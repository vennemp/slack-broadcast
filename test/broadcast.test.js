import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Journal } from '../src/journal.js';
import { deliver } from '../src/delivery.js';
import { registerHandlers } from '../src/handlers.js';

async function journalFor(t) {
  const path = await mkdtemp(join(tmpdir(), 'slack-broadcast-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  const journal = new Journal(path);
  await journal.load();
  return journal;
}

const draftFor = (channels = ['CONE', 'CTWO']) => ({
  id: randomUUID(), teamId: 'TONE', userId: 'UONE', channels, text: 'A private draft message',
});
const platformError = (error) => Object.assign(new Error('Slack rejected the request'), {
  code: 'slack_webapi_platform_error', data: { error },
});

test('partial failure preserves successful sends, deduplicates channels, and does not resend an existing receipt', async (t) => {
  const journal = await journalFor(t);
  const draft = draftFor(['CONE', 'CTWO', 'CONE']);
  const calls = [];
  const client = { chat: { postMessage: async (args) => {
    calls.push(args);
    if (args.channel === 'CTWO') throw platformError('not_in_channel');
    return { ok: true, ts: '123.456' };
  } } };
  const job = await deliver({ client, journal, draft });
  assert.deepEqual(job.results.map((result) => result.status), ['sent', 'failed']);
  assert.equal(job.results[1].error, 'not_in_channel');
  assert.ok(job.finishedAt);
  await deliver({ client, journal, draft });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].unfurl_links, false);
  const receipt = await readFile(join(journal.directory, `${draft.id}.json`), 'utf8');
  assert.equal(receipt.includes(draft.text), false);
});

test('network ambiguity is reported as unknown and is never automatically retried', async (t) => {
  const journal = await journalFor(t);
  let calls = 0;
  const client = { chat: { postMessage: async () => {
    calls += 1;
    throw Object.assign(new Error('Lost connection after upload'), { code: 'slack_webapi_request_error' });
  } } };
  const job = await deliver({ client, journal, draft: draftFor(['CONE']) });
  assert.equal(calls, 1);
  assert.equal(job.results[0].status, 'unknown');
});

test('explicit rate limits are retried with Retry-After and have a finite retry budget', async (t) => {
  const journal = await journalFor(t);
  const waits = [];
  let calls = 0;
  const client = { chat: { postMessage: async () => {
    calls += 1;
    throw Object.assign(new Error('Rate limited'), { code: 'slack_webapi_rate_limited_error', retryAfter: 2 });
  } } };
  const job = await deliver({ client, journal, draft: draftFor(['CONE']), wait: async (ms) => waits.push(ms) });
  assert.equal(calls, 3);
  assert.deepEqual(waits, [2000, 2000]);
  assert.deepEqual(job.results[0], { channel: 'CONE', status: 'failed', error: 'ratelimited' });
});

test('fanout bounds concurrent requests while eventually sending to every recipient', async (t) => {
  const journal = await journalFor(t);
  let inFlight = 0;
  let maximum = 0;
  const received = new Set();
  const client = { chat: { postMessage: async ({ channel }) => {
    inFlight += 1;
    maximum = Math.max(maximum, inFlight);
    received.add(channel);
    await new Promise((resolve) => setImmediate(resolve));
    inFlight -= 1;
    return { ok: true, ts: '123' };
  } } };
  const draft = draftFor(Array.from({ length: 10 }, (_, i) => `C${i}`));
  const job = await deliver({ client, journal, draft });
  assert.ok(maximum <= 3);
  assert.equal(received.size, 10);
  assert.equal(job.results.filter((result) => result.status === 'sent').length, 10);
});

test('a receipt write failure prevents external sends', async () => {
  let sends = 0;
  const client = { chat: { postMessage: async () => { sends += 1; } } };
  const journal = { get: () => undefined, save: async () => { throw new Error('Disk full'); } };
  await assert.rejects(deliver({ client, journal, draft: draftFor() }), /Disk full/);
  assert.equal(sends, 0);
});

test('interrupted persistence stops queued sends and leaves an accurate receipt', async (t) => {
  const journal = await journalFor(t);
  const save = journal.save.bind(journal);
  let saves = 0;
  journal.save = async (job) => {
    saves += 1;
    if (saves > 1) throw new Error('Disk full');
    return save(job);
  };
  let sends = 0;
  const client = { chat: { postMessage: async () => { sends += 1; return { ok: true }; } } };
  const draft = draftFor(['CONE', 'CTWO', 'CTHREE', 'CFOUR']);
  await assert.rejects(deliver({ client, journal, draft }), /Disk full/);
  assert.equal(sends, 0);
  assert.ok(journal.get(draft.id).finishedAt);
  assert.deepEqual(journal.get(draft.id).results.map((result) => result.status), ['unknown', 'unknown', 'unknown', 'cancelled']);
});

test('restart keeps confirmed receipts and does not automatically replay interrupted sends', async (t) => {
  const journal = await journalFor(t);
  const draft = draftFor();
  await journal.save({
    id: draft.id, teamId: draft.teamId, userId: draft.userId, createdAt: new Date().toISOString(),
    results: [
      { channel: 'CONE', status: 'sent', ts: '123' },
      { channel: 'CTWO', status: 'sending' },
      { channel: 'CTHREE', status: 'queued' },
    ],
  });
  const reopened = new Journal(journal.directory);
  await reopened.load();
  const job = reopened.latest(draft.teamId, draft.userId);
  assert.deepEqual(job.results.map((result) => result.status), ['sent', 'unknown', 'cancelled']);
  assert.ok(job.finishedAt);
  assert.equal(reopened.latest('TOTHER', draft.userId), undefined);
  assert.equal(reopened.latest(draft.teamId, 'UOTHER'), undefined);
  assert.equal(await deliver({ client: {}, journal: reopened, draft }), job);
});

function harness(journal, options = {}) {
  const commands = new Map();
  const views = new Map();
  const actions = new Map();
  const app = {
    command: (id, handler) => commands.set(id, handler),
    view: (id, handler) => views.set(id, handler),
    action: (id, handler) => actions.set(id, handler),
    event: () => {},
  };
  const controller = registerHandlers(app, { journal, teamId: 'TONE', access: { assert: async () => {} }, ...options });
  return { commands, views, actions, controller };
}

test('the Slack flow requires review and ignores overlapping Send submissions', async (t) => {
  const journal = await journalFor(t);
  const { commands, views } = harness(journal);
  let opened;
  let sends = 0;
  let release;
  const waitForSend = new Promise((resolve) => { release = resolve; });
  const client = {
    views: { open: async ({ view }) => { opened = view; }, update: async () => ({ ok: true }) },
    chat: { postMessage: async () => { sends += 1; await waitForSend; return { ok: true, ts: '123' }; } },
  };
  const logger = { error: () => {} };
  await commands.get('/broadcast')({
    command: { team_id: 'TONE', user_id: 'UONE', text: '', trigger_id: 'trigger' },
    ack: async () => {}, respond: async () => {}, client, logger,
  });
  const body = { user: { id: 'UONE' }, team: { id: 'TONE' } };
  const view = {
    id: 'VONE', private_metadata: opened.private_metadata,
    state: { values: { channels: { selected: { selected_conversations: ['CONE'] } }, message: { text: { value: 'Hello' } } } },
  };
  let review;
  await views.get('broadcast_compose')({ body, view, ack: async (response) => { review = response.view; } });
  assert.equal(sends, 0);
  assert.equal(review.callback_id, 'broadcast_send');
  assert.equal(review.submit.text, 'Send to 1');
  const args = { body, view, client, logger, ack: async () => {} };
  const first = views.get('broadcast_send')(args);
  const duplicate = views.get('broadcast_send')(args);
  release();
  await Promise.all([first, duplicate]);
  assert.equal(sends, 1);
  await views.get('broadcast_send')(args);
  assert.equal(sends, 1);
});

test('unauthorized users and other workspaces cannot open a composer', async (t) => {
  const { commands } = harness(await journalFor(t), { allowedUsers: new Set(['UOWNER']) });
  let opened = 0;
  const responses = [];
  const common = {
    ack: async () => {}, client: { views: { open: async () => { opened += 1; } } },
    respond: async (response) => responses.push(response), logger: { error: () => {} },
  };
  await commands.get('/broadcast')({ ...common, command: { team_id: 'TONE', user_id: 'UOTHER', text: '' } });
  await commands.get('/broadcast')({ ...common, command: { team_id: 'TOTHER', user_id: 'UOWNER', text: '' } });
  assert.equal(opened, 0);
  assert.equal(responses.length, 2);
  assert.ok(responses.every((response) => response.response_type === 'ephemeral'));
});
