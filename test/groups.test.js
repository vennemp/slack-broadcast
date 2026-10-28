import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalGroups, GroupError } from '../src/channel-groups.js';
import { ChannelAccess } from '../src/channel-access.js';
import { createGroupHandler } from '../src/group-handlers.js';
import { groupEditView } from '../src/group-views.js';
import { createCloudHandler } from '../src/cloud-handlers.js';

async function local(t) {
  const dir = await mkdtemp(join(tmpdir(), 'slack-broadcast-groups-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return new LocalGroups(dir);
}

test('shared groups persist across restarts and reject stale or conflicting edits', async (t) => {
  const groups = await local(t);
  const first = await groups.save('TONE', { userId: 'UONE', name: 'Engineering', channels: ['CPUBLIC', 'CPUBLIC'] });
  assert.deepEqual(first.channels, ['CPUBLIC']);
  const secondInstance = new LocalGroups(groups.directory);
  assert.equal((await secondInstance.list('TONE'))[0].name, 'Engineering');
  assert.deepEqual(await secondInstance.list('TOTHER'), []);
  await assert.rejects(groups.save('TONE', { userId: 'UTWO', name: 'engineering', channels: ['COTHER'] }), /already exists/);
  const changes = await Promise.allSettled([
    groups.save('TONE', { id: first.id, version: first.version, userId: 'UONE', name: 'Engineering', channels: ['CPUBLIC', 'COTHER'] }),
    groups.save('TONE', { id: first.id, version: first.version, userId: 'UTWO', name: 'Engineering', channels: ['CPUBLIC'] }),
  ]);
  assert.equal(changes.filter((result) => result.status === 'fulfilled').length, 1);
  assert.ok(changes.find((result) => result.status === 'rejected').reason instanceof GroupError);
  const current = await groups.get('TONE', first.id);
  await groups.save('TONE', { operation: 'delete', id: current.id, version: current.version, userId: 'UTWO' });
  assert.deepEqual(await groups.list('TONE'), []);
});

test('channel access requires bot membership and the sender membership for private channels', async () => {
  const calls = [];
  const client = { users: { conversations: async (args) => {
    calls.push(args);
    if (args.user) return { ok: true, channels: [{ id: 'CPRIVATEA', is_private: true }] };
    return { ok: true, channels: [
      { id: 'CPUBLIC', is_private: false }, { id: 'CPRIVATEA', is_private: true },
      { id: 'CPRIVATEB', is_private: true }, { id: 'CUNKNOWN' },
      { id: 'CARCHIVED', is_private: false, is_archived: true },
    ] };
  } } };
  const access = new ChannelAccess(client);
  assert.deepEqual([...(await access.available('UONE'))], ['CPUBLIC', 'CPRIVATEA']);
  await assert.rejects(access.assert('UONE', ['CPRIVATEB']), /unavailable/);
  assert.ok(calls.some((call) => call.user === 'UONE' && call.types === 'private_channel'));
  assert.ok(calls.every((call) => call.exclude_archived));
});

test('group editing hides inaccessible channels and preserves them when another sender saves', async (t) => {
  const groups = await local(t);
  const group = await groups.save('TONE', { userId: 'UONE', name: 'Updates', channels: ['CPUBLIC', 'CPRIVATEB'] });
  const allowed = new Set(['CPUBLIC', 'CPRIVATEA']);
  const view = groupEditView(group, allowed, 'Slack Broadcast');
  assert.equal(JSON.stringify(view).includes('CPRIVATEB'), false);
  const handler = createGroupHandler({ groups, access: { available: async () => allowed }, client: {}, teamId: 'TONE', appName: 'Slack Broadcast' });
  const response = await handler({ type: 'view_submission', user: { id: 'UTWO' }, view: {
    callback_id: 'group_save', private_metadata: view.private_metadata,
    state: { values: { group_name: { name: { value: 'Updated group' } }, group_channels: { channels: { selected_conversations: ['CPRIVATEA'] } } } },
  } });
  assert.equal(response.response_action, 'update');
  const saved = await groups.get('TONE', group.id);
  assert.deepEqual(saved.channels, ['CPRIVATEB', 'CPRIVATEA']);
  assert.equal(saved.updatedBy, 'UTWO');
});

test('an unavailable group cannot prefill a broadcast, and saving an inaccessible channel is denied', async (t) => {
  const groups = await local(t);
  const group = await groups.save('TONE', { userId: 'UONE', name: 'Restricted', channels: ['CPRIVATEB'] });
  let composed = false;
  let updated;
  const handler = createGroupHandler({
    groups, access: { available: async () => new Set(['CPUBLIC']) }, teamId: 'TONE', appName: 'Slack Broadcast',
    client: { views: { update: async ({ view }) => { updated = view; } } }, compose: async () => { composed = true; },
  });
  await handler({ type: 'block_actions', user: { id: 'UTWO' }, view: { id: 'VONE', private_metadata: '{}' }, actions: [{ action_id: 'group_choice', selected_option: { value: `${group.id}:use` } }] });
  assert.equal(composed, false);
  assert.match(JSON.stringify(updated), /cannot access/);
  const rejected = await handler({ type: 'view_submission', user: { id: 'UTWO' }, view: {
    callback_id: 'group_save', private_metadata: '{}', state: { values: {
      group_name: { name: { value: 'Unauthorized channel' } }, group_channels: { channels: { selected_conversations: ['CPRIVATEB'] } },
    } },
  } });
  assert.match(rejected.errors.group_channels, /unavailable/);
});

test('unlisted senders cannot read or modify shared groups through the cloud entrypoint', async () => {
  let reads = 0;
  const handler = createCloudHandler({
    store: {}, queue: {}, client: {}, teamId: 'TONE', appName: 'Slack Broadcast', allowedUsers: new Set(['UONE']),
    groups: { list: async () => { reads += 1; return []; } },
  });
  const response = await handler({ command: '/broadcast', text: 'groups', team_id: 'TONE', user_id: 'UNOTLISTED' });
  assert.match(response.text, /do not have access/);
  assert.equal(reads, 0);
});

test('the app description states ownership and storage accurately and does not request history access', async () => {
  const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));
  assert.ok(manifest.display_information.description.length <= 140);
  assert.match(manifest.display_information.description, /Slack message broadcast app/);
  assert.match(manifest.display_information.long_description, /stores approved sender IDs, access change records, saved channel groups, and delivery records/);
  assert.match(manifest.display_information.long_description, /temporarily stores message text/);
  assert.ok(manifest.oauth_config.scopes.bot.includes('channels:read'));
  assert.ok(manifest.oauth_config.scopes.bot.includes('groups:read'));
  assert.ok(manifest.oauth_config.scopes.bot.every((scope) => !scope.includes('history')));
});
