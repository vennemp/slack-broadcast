import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalSenders } from '../src/approved-senders.js';
import { createCloudHandler } from '../src/cloud-handlers.js';
import { handleSenderManagement } from '../src/sender-management.js';

async function fixture(t, initial = ['USENDER']) {
  const dir = await mkdtemp(join(tmpdir(), 'slack-broadcast-access-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return new LocalSenders(dir, new Set(['UADMIN']), new Set(initial));
}

test('only administrators can change approved senders and changes are recorded', async (t) => {
  const senders = await fixture(t);
  await assert.rejects(senders.change('TONE', { actor: 'USENDER', operation: 'add', userId: 'UOTHER' }), /Only app administrators/);
  await senders.change('TONE', { actor: 'UADMIN', operation: 'add', userId: 'UOTHER' });
  let policy = await senders.policy('TONE');
  assert.ok(policy.allowed.has('UOTHER'));
  assert.equal(policy.admins.has('UOTHER'), false);
  await senders.change('TONE', { actor: 'UADMIN', operation: 'remove', userId: 'USENDER' });
  policy = await senders.policy('TONE');
  assert.equal(policy.allowed.has('USENDER'), false);
  const reopened = new LocalSenders(senders.directory, ['UADMIN'], ['USENDER']);
  assert.deepEqual([...(await reopened.policy('TONE')).allowed], ['UOTHER']);
  const saved = JSON.parse(await readFile(senders.path('TONE'), 'utf8'));
  assert.deepEqual(saved.history.map((entry) => [entry.actor, entry.operation, entry.userId]), [
    ['UADMIN', 'add', 'UOTHER'], ['UADMIN', 'remove', 'USENDER'],
  ]);
});

test('App Home administration is separate from broadcasting and empty sender lists deny sending', async (t) => {
  const senders = await fixture(t, []);
  let published;
  let opened;
  let drafts = 0;
  const client = { views: { publish: async (value) => { published = value; }, open: async (value) => { opened = value; } } };
  const handler = createCloudHandler({
    store: { createDraft: async () => { drafts += 1; return { id: 'draft', channels: [], text: '' }; } },
    senders, queue: {}, client, teamId: 'TONE', appName: 'Slack Broadcast',
  });
  await handler({ type: 'event_callback', team_id: 'TONE', event: { type: 'app_home_opened', user: 'UADMIN', tab: 'home' } });
  assert.match(JSON.stringify(published), /home_senders/);
  assert.equal(JSON.stringify(published).includes('home_compose'), false);
  await handler({ type: 'block_actions', team: { id: 'TONE' }, user: { id: 'UADMIN' }, trigger_id: 'trigger', actions: [{ action_id: 'home_senders' }] });
  assert.equal(opened.view.title.text, 'Approved senders');
  const denied = await handler({ command: '/broadcast', text: '', team_id: 'TONE', user_id: 'USENDER' });
  assert.match(denied.text, /do not have access/);
  assert.equal(drafts, 0);
  await senders.change('TONE', { actor: 'UADMIN', operation: 'add', userId: 'USENDER' });
  await handler({ command: '/broadcast', text: '', team_id: 'TONE', user_id: 'USENDER', trigger_id: 'trigger' });
  assert.equal(drafts, 1);
  await senders.change('TONE', { actor: 'UADMIN', operation: 'remove', userId: 'USENDER' });
  await handler({ command: '/broadcast', text: '', team_id: 'TONE', user_id: 'USENDER', trigger_id: 'trigger' });
  assert.equal(drafts, 1);
});

test('forged management actions from senders or another workspace cannot grant access', async (t) => {
  const senders = await fixture(t);
  const handler = createCloudHandler({ store: {}, senders, queue: {}, client: {}, teamId: 'TONE', appName: 'Slack Broadcast' });
  const payload = {
    type: 'view_submission', team: { id: 'TONE' }, user: { id: 'USENDER' },
    view: { callback_id: 'sender_save', state: { values: { sender: { user: { selected_user: 'UATTACKER' } } } } },
  };
  assert.match(JSON.stringify(await handler(payload)), /Only app administrators/);
  await handler({ ...payload, team: { id: 'TOTHER' }, user: { id: 'UADMIN' } });
  assert.equal((await senders.policy('TONE')).allowed.has('UATTACKER'), false);
  await assert.rejects(handleSenderManagement({ ...payload, team: { id: 'TOTHER' }, user: { id: 'UADMIN' } }, { senders, teamId: 'TONE', client: {} }), /Workspace mismatch/);
});

test('the native user selection adds a sender without granting app administrator rights', async (t) => {
  const senders = await fixture(t);
  const result = await handleSenderManagement({
    type: 'view_submission', team: { id: 'TONE' }, user: { id: 'UADMIN' },
    view: { callback_id: 'sender_save', state: { values: { sender: { user: { selected_user: 'UOTHER' } } } } },
  }, { senders, teamId: 'TONE', client: {} });
  assert.equal(result.response_action, 'update');
  assert.ok((await senders.policy('TONE')).allowed.has('UOTHER'));
  assert.equal((await senders.policy('TONE')).admins.has('UOTHER'), false);
});
