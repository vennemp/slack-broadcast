import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { CloudStore } from '../src/cloud-store.js';
import { processCloudJob } from '../src/cloud-worker.js';
import { createCloudHandler } from '../src/cloud-handlers.js';
import { createCloudServer } from '../src/cloud-server.js';
import { createQueue } from '../src/cloud-queue.js';
import { verifySlackRequest, verifyTaskRequest } from '../src/cloud-security.js';
import { FirestoreGroups } from '../src/channel-groups.js';
import { FirestoreSenders } from '../src/approved-senders.js';

const access = { available: async () => new Set(['CONE', 'CTWO', 'CTHREE']), assert: async () => {} };

// A serializable in-memory transaction adapter. Separate store instances share
// this database so tests exercise ownership and retries without Google access.
function database() {
  const records = new Map();
  let tail = Promise.resolve();
  const snapshot = (key) => ({ data: () => structuredClone(records.get(key)) });
  return {
    collection: (name) => ({ doc: (id) => {
      const key = `${name}/${id}`;
      return {
        key, get: async () => snapshot(key),
        create: async (value) => { assert.equal(records.has(key), false); records.set(key, structuredClone(value)); },
        set: async (value) => records.set(key, structuredClone(value)),
      };
    } }),
    runTransaction(callback) {
      const run = tail.then(async () => {
        const writes = [];
        const tx = {
          get: async (ref) => snapshot(ref.key),
          set: (ref, value) => writes.push(() => records.set(ref.key, structuredClone(value))),
          create: (ref, value) => writes.push(() => { assert.equal(records.has(ref.key), false); records.set(ref.key, structuredClone(value)); }),
          update: (ref, value) => writes.push(() => records.set(ref.key, { ...records.get(ref.key), ...structuredClone(value) })),
        };
        const result = await callback(tx);
        for (const write of writes) write();
        return result;
      });
      tail = run.catch(() => {});
      return run;
    },
  };
}

async function prepared(store, channels = ['CONE', 'CTWO']) {
  const draft = await store.createDraft({ teamId: 'TONE', userId: 'UONE', text: 'Durable pending message' });
  await store.changeDraft(draft.id, 'TONE', 'UONE', 'compose', { state: 'review', channels });
  return store.prepare(draft.id, 'TONE', 'UONE', 'VONE');
}

test('Firestore draft confirmation and worker ownership are atomic across instances', async () => {
  const db = database();
  const a = new CloudStore(db);
  const b = new CloudStore(db);
  const job = await prepared(a);
  const repeated = await b.prepare(job.id, 'TONE', 'UONE', 'VONE');
  assert.equal(repeated.id, job.id);
  assert.equal(await b.prepare(job.id, 'TONE', 'UOTHER', 'VONE'), undefined);
  assert.equal(await b.job(job.id, 'TOTHER', 'UONE'), undefined);
  assert.equal((await b.latest('TONE', 'UONE')).id, job.id);
  const claims = await Promise.all([a.claim(job.id), b.claim(job.id)]);
  assert.deepEqual(claims.map((result) => result.state), ['claimed', 'busy']);
});

test('a crashed task never repeats an ambiguous send and continues queued recipients', async () => {
  const db = database();
  const a = new CloudStore(db);
  const job = await prepared(a);
  const first = await a.claim(job.id);
  await a.checkpoint(job.id, first.job.leaseId, 'CONE', { status: 'sending' });
  const interrupted = await a.job(job.id);
  interrupted.leaseUntil = 0;
  await a.jobs.doc(job.id).set(interrupted);
  const b = new CloudStore(db);
  const calls = [];
  const client = { chat: { postMessage: async ({ channel }) => { calls.push(channel); return { ok: true, ts: '123' }; } } };
  const result = await processCloudJob({ id: job.id, store: b, client, access });
  assert.deepEqual(calls, ['CTWO']);
  assert.deepEqual(result.job.results.map((entry) => entry.status), ['unknown', 'sent']);
  assert.equal(result.job.text, '');
  await processCloudJob({ id: job.id, store: a, client, access });
  assert.deepEqual(calls, ['CTWO']);
});

test('the cloud worker records partial failure without retrying an entire broadcast', async () => {
  const store = new CloudStore(database());
  const job = await prepared(store);
  const client = { chat: { postMessage: async ({ channel }) => {
    if (channel === 'CTWO') throw Object.assign(new Error(), { code: 'slack_webapi_rate_limited_error', retryAfter: 30 });
    return { ok: true, ts: '123' };
  } } };
  const result = await processCloudJob({ id: job.id, store, client, access });
  assert.deepEqual(result.job.results.map((entry) => entry.status), ['sent', 'failed']);
  assert.equal(result.job.results[1].error, 'ratelimited');
});

test('a queue create failure preserves a safe retry and cross-instance UI flow', async () => {
  const store = new CloudStore(database());
  let opened;
  let attempts = 0;
  const ids = [];
  const makeHandler = () => createCloudHandler({
    store, access, teamId: 'TONE', appName: 'Slack Broadcast', allowedUsers: new Set(['UONE']),
    client: { views: { open: async ({ view }) => { opened = view; } } },
    queue: { enqueue: async (id) => { ids.push(id); if (++attempts === 1) throw new Error('Lost queue response'); } },
  });
  await makeHandler()({ command: '/broadcast', team_id: 'TONE', user_id: 'UONE', trigger_id: 'trigger', text: '' });
  const owner = { team: { id: 'TONE' }, user: { id: 'UONE' } };
  const view = { id: 'VONE', private_metadata: opened.private_metadata, callback_id: 'broadcast_compose', state: { values: {
    channels: { selected: { selected_conversations: ['CONE'] } }, message: { text: { value: 'Hello world' } },
  } } };
  const review = await makeHandler()({ ...owner, type: 'view_submission', view });
  assert.equal(review.view.callback_id, 'broadcast_send');
  view.callback_id = 'broadcast_send';
  const retry = await makeHandler()({ ...owner, type: 'view_submission', view });
  assert.equal(retry.view.callback_id, 'broadcast_send');
  const queued = await makeHandler()({ ...owner, type: 'view_submission', view });
  assert.ok(queued.view.blocks.some((block) => block.type === 'actions'));
  assert.deepEqual(ids, [opened.private_metadata, opened.private_metadata]);
  const denied = await makeHandler()({ ...owner, user: { id: 'UOTHER' }, type: 'view_submission', view });
  assert.match(JSON.stringify(denied), /do not have access/);
  assert.equal(ids.length, 2);
});

test('queue requests contain only the job ID, use OIDC, and tolerate an existing named task', async () => {
  let request;
  const client = {
    queuePath: () => 'projects/p/locations/us-east4/queues/q',
    createTask: async (value) => { request = value; throw Object.assign(new Error(), { code: 6 }); },
  };
  const id = randomUUID();
  const queue = createQueue({ client, projectId: 'p', region: 'us-east4', queueId: 'q', serviceUrl: 'https://app.example', serviceAccount: 'tasks@p.iam.gserviceaccount.com' });
  await queue.enqueue(id);
  assert.ok(request.task.name.endsWith(id));
  assert.equal(request.task.httpRequest.oidcToken.audience, 'https://app.example');
  assert.deepEqual(JSON.parse(Buffer.from(request.task.httpRequest.body, 'base64')), { id });
});

test('Slack verification rejects tampering and old timestamps', () => {
  const secret = 'signing-secret';
  const body = Buffer.from('command=%2Fbroadcast&text=Hello');
  const timestamp = '1800000000';
  const signature = `v0=${createHmac('sha256', secret).update(`v0:${timestamp}:`).update(body).digest('hex')}`;
  const args = { secret, body, timestamp, signature, now: Number(timestamp) * 1000 };
  assert.equal(verifySlackRequest(args), true);
  assert.equal(verifySlackRequest({ ...args, body: Buffer.from('command=%2Fbroadcast&text=Tampered') }), false);
  assert.equal(verifySlackRequest({ ...args, now: args.now + 301_000 }), false);
  assert.equal(verifySlackRequest({ ...args, signature: 'v0=invalid' }), false);
});

test('task authentication requires a verified Google token for the configured identity and audience', async () => {
  const verify = (email, verified = true) => ({ verifyIdToken: async ({ audience }) => {
    assert.equal(audience, 'https://app.example');
    return { getPayload: () => ({ email, email_verified: verified }) };
  } });
  const args = { authorization: 'Bearer signed-token', audience: 'https://app.example', serviceAccount: 'tasks@example' };
  assert.equal(await verifyTaskRequest({ ...args, verifier: verify('tasks@example') }), true);
  assert.equal(await verifyTaskRequest({ ...args, verifier: verify('someone@example') }), false);
  assert.equal(await verifyTaskRequest({ ...args, verifier: verify('tasks@example', false) }), false);
  assert.equal(await verifyTaskRequest({ ...args, verifier: { verifyIdToken: async () => { throw new Error('Signature invalid'); } } }), false);
});

test('HTTP server denies unsigned Slack requests and holds task responses until delivery completes', async (t) => {
  let invoked = 0;
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  const server = createCloudServer({
    signingSecret: 'secret', serviceUrl: 'https://app.example', serviceAccount: 'tasks@example',
    handleSlack: async () => { invoked += 1; return {}; },
    verifier: { verifyIdToken: async () => ({ getPayload: () => ({ email: 'tasks@example', email_verified: true }) }) },
    handleTask: async () => { await blocked; return { state: 'done' }; },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const health = await fetch(`${base}/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true });
  assert.equal((await fetch(`${base}/slack/events`, { method: 'POST', body: 'command=%2Fbroadcast' })).status, 401);
  assert.equal(invoked, 0);
  const body = 'command=%2Fbroadcast';
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = `v0=${createHmac('sha256', 'secret').update(`v0:${timestamp}:${body}`).digest('hex')}`;
  assert.equal((await fetch(`${base}/slack/events`, { method: 'POST', body, headers: { 'x-slack-signature': signature, 'x-slack-request-timestamp': timestamp } })).status, 200);
  assert.equal(invoked, 1);
  const id = randomUUID();
  let responded = false;
  const request = fetch(`${base}/tasks/deliver`, { method: 'POST', body: JSON.stringify({ id }), headers: { Authorization: 'Bearer token' } }).then((response) => { responded = true; return response; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(responded, false);
  release();
  assert.equal((await request).status, 200);
});

test('Firestore groups are shared only within their workspace and reject stale edits', async () => {
  const db = database();
  const first = new FirestoreGroups(db);
  const second = new FirestoreGroups(db);
  const group = await first.save('TONE', { name: 'Announcements', channels: ['CONE'], userId: 'UONE' });
  assert.equal((await second.list('TONE'))[0].id, group.id);
  assert.deepEqual(await second.list('TOTHER'), []);
  await second.save('TONE', { ...group, userId: 'UTWO', channels: ['CONE', 'CTWO'] });
  await assert.rejects(first.save('TONE', { ...group, userId: 'UONE', channels: ['CONE'] }), /changed/);
});

test('group selection preserves an unsent draft and never sends a message', async () => {
  const db = database();
  const store = new CloudStore(db);
  const groups = new FirestoreGroups(db);
  const group = await groups.save('TONE', { name: 'Engineering', channels: ['CONE'], userId: 'UONE' });
  let current;
  const client = { views: {
    open: async ({ view }) => { current = view; },
    update: async ({ view }) => { current = view; },
  } };
  const handler = createCloudHandler({ store, groups, access, queue: {}, client, teamId: 'TONE', appName: 'Slack Broadcast', allowedUsers: new Set(['UONE']) });
  await handler({ command: '/broadcast', text: 'Initial message', team_id: 'TONE', user_id: 'UONE', trigger_id: 'trigger' });
  const id = current.private_metadata;
  const owner = { team: { id: 'TONE' }, user: { id: 'UONE' } };
  await handler({ ...owner, type: 'block_actions', view: {
    id: 'VONE', private_metadata: id,
    state: { values: { message: { text: { value: 'Edited before picking a group' } }, channels: { selected: { selected_conversations: ['CTWO'] } } } },
  }, actions: [{ action_id: 'group_manage' }] });
  assert.equal(JSON.parse(current.private_metadata).draftId, id);
  await handler({ ...owner, type: 'block_actions', view: { id: 'VONE', private_metadata: current.private_metadata }, actions: [{ action_id: 'group_choice', selected_option: { value: `${group.id}:use` } }] });
  assert.equal(current.private_metadata, id);
  assert.equal(current.blocks.find((block) => block.block_id === 'message').element.initial_value, 'Edited before picking a group');
  assert.deepEqual(current.blocks.find((block) => block.block_id === 'channels').element.initial_conversations, ['CONE']);
});

test('private access and sender authorization are checked again by the delivery worker', async () => {
  const store = new CloudStore(database());
  const calls = [];
  const client = { chat: { postMessage: async ({ channel }) => { calls.push(channel); return { ok: true, ts: '123' }; } } };
  const first = await prepared(store);
  const result = await processCloudJob({ id: first.id, store, client, access: { available: async () => new Set(['CONE']) } });
  assert.deepEqual(calls, ['CONE']);
  assert.equal(result.job.results[1].error, 'channel_access_denied');
  const second = await prepared(store);
  const denied = await processCloudJob({ id: second.id, store, client, permitted: () => false, access: { available: async () => { throw new Error('Must not query channel memberships'); } } });
  assert.ok(denied.job.results.every((entry) => entry.error === 'sender_not_authorized'));
  assert.deepEqual(calls, ['CONE']);
});

test('Home publishes only the current sender receipts and restricted users get an informational view', async () => {
  const store = new CloudStore(database());
  const job = await prepared(store);
  let published;
  let opened;
  const client = { views: {
    publish: async (value) => { published = value; },
    open: async (value) => { opened = value; },
  } };
  const handler = createCloudHandler({ store, access, queue: {}, client, teamId: 'TONE', appName: 'Slack Broadcast', allowedUsers: new Set(['UONE', 'UTWO']) });
  await handler({ type: 'event_callback', team_id: 'TONE', event: { type: 'app_home_opened', user: 'UONE', tab: 'home' } });
  assert.equal(published.user_id, 'UONE');
  assert.ok(JSON.stringify(published).includes(job.id));
  assert.equal(JSON.stringify(published).includes('Durable pending message'), false);
  await handler({ type: 'event_callback', team_id: 'TONE', event: { type: 'app_home_opened', user: 'UNOTLISTED', tab: 'home' } });
  assert.equal(JSON.stringify(published).includes(job.id), false);
  assert.equal(JSON.stringify(published).includes('home_compose'), false);
  await handler({ type: 'block_actions', team: { id: 'TONE' }, user: { id: 'UTWO' }, trigger_id: 'trigger', actions: [{ action_id: 'home_results', value: job.id }] });
  assert.match(JSON.stringify(opened.view), /unavailable/);
  await handler({ type: 'block_actions', team: { id: 'TONE' }, user: { id: 'UONE' }, trigger_id: 'trigger', actions: [{ action_id: 'home_compose' }] });
  assert.equal(opened.view.callback_id, 'broadcast_compose');
  assert.deepEqual(await handler({ type: 'url_verification', challenge: 'verified-challenge' }), { challenge: 'verified-challenge' });
});

test('composer combines saved groups and extra channels once, preserves edits, and freezes the reviewed recipients', async () => {
  const db = database();
  const store = new CloudStore(db);
  const groups = new FirestoreGroups(db);
  const first = await groups.save('TONE', { userId: 'UONE', name: 'Engineering', channels: ['CONE', 'CTWO'] });
  const second = await groups.save('TONE', { userId: 'UTWO', name: 'Operations', channels: ['CTWO', 'CTHREE'] });
  let opened;
  let edited;
  let checked;
  const queued = [];
  const handler = createCloudHandler({ store, groups, teamId: 'TONE', appName: 'Slack Broadcast', allowedUsers: new Set(['UONE']),
    client: { views: { open: async (value) => { opened = value.view; }, update: async (value) => { edited = value.view; } } },
    queue: { enqueue: async (id) => queued.push(id) }, access: { assert: async (_user, channels) => { checked = channels; } },
  });
  await handler({ type: 'block_actions', team: { id: 'TONE' }, user: { id: 'UONE' }, trigger_id: 'trigger', actions: [{ action_id: 'home_compose' }] });
  assert.deepEqual(opened.blocks.find((block) => block.block_id === 'saved_groups').element.options.map((option) => option.text.text), ['Engineering', 'Operations']);
  const draftId = opened.private_metadata;
  const values = { saved_groups: { selected: { selected_options: [{ value: first.id }, { value: second.id }] } }, channels: { selected: { selected_conversations: ['CTHREE'] } }, message: { text: { value: 'Review this message' } } };
  const payload = { type: 'view_submission', team: { id: 'TONE' }, user: { id: 'UONE' }, view: { id: 'VONE', callback_id: 'broadcast_compose', private_metadata: draftId, state: { values } } };
  const reviewed = await handler(payload);
  assert.equal(reviewed.view.callback_id, 'broadcast_send');
  assert.deepEqual([...checked].sort(), ['CONE', 'CTHREE', 'CTWO']);
  assert.deepEqual(queued, []);
  await handler({ type: 'block_actions', team: { id: 'TONE' }, user: { id: 'UONE' }, actions: [{ action_id: 'broadcast_edit' }], view: { id: 'VONE', private_metadata: draftId } });
  assert.equal(edited.blocks.find((block) => block.block_id === 'saved_groups').element.initial_options.length, 2);
  assert.deepEqual(edited.blocks.find((block) => block.block_id === 'channels').element.initial_conversations, ['CTHREE']);
  await handler(payload);
  await groups.save('TONE', { id: first.id, version: first.version, userId: 'UTWO', name: 'Engineering', channels: ['CUNREVIEWED'] });
  await handler({ ...payload, view: { ...payload.view, callback_id: 'broadcast_send' } });
  const job = await store.job(draftId, 'TONE', 'UONE');
  assert.deepEqual(job.results.map((entry) => entry.channel).sort(), ['CONE', 'CTHREE', 'CTWO']);
  assert.deepEqual(queued, [draftId]);
});

test('composer rejects missing or foreign groups, inaccessible recipients, and more than 25 combined channels', async () => {
  const db = database();
  const store = new CloudStore(db);
  const groups = new FirestoreGroups(db);
  const foreign = await groups.save('TOTHER', { userId: 'UONE', name: 'Other workspace', channels: ['CSECRET'] });
  const group = await groups.save('TONE', { userId: 'UONE', name: 'Private destinations', channels: ['CSECRET'] });
  const many = await groups.save('TONE', { userId: 'UONE', name: 'Full group', channels: Array.from({ length: 25 }, (_, i) => `C${i}`) });
  const handler = createCloudHandler({ store, groups, client: {}, queue: {}, teamId: 'TONE', allowedUsers: new Set(['UONE']), appName: 'Communications', access: { assert: async () => { throw new Error('No access'); } } });
  const draft = await store.createDraft({ teamId: 'TONE', userId: 'UONE' });
  const payload = (id, channels = []) => ({ type: 'view_submission', team: { id: 'TONE' }, user: { id: 'UONE' }, view: { callback_id: 'broadcast_compose', private_metadata: draft.id, state: { values: { saved_groups: { selected: { selected_options: [{ value: id }] } }, channels: { selected: { selected_conversations: channels } }, message: { text: { value: 'Message' } } } } } });
  for (const id of [foreign.id, randomUUID()]) assert.ok((await handler(payload(id))).errors.saved_groups);
  assert.match((await handler(payload(group.id))).errors.channels, /verify every destination/);
  assert.match((await handler(payload(many.id, ['CEXTRA']))).errors.channels, /25/);
  assert.equal((await store.draft(draft.id, 'TONE', 'UONE')).state, 'compose');
});

test('recent history is limited to five receipts and remains scoped to its sender', async () => {
  const store = new CloudStore(database());
  const ids = [];
  for (let i = 0; i < 6; i += 1) ids.push((await prepared(store)).id);
  assert.deepEqual((await store.recent('TONE', 'UONE')).map((job) => job.id), ids.slice(-5).reverse());
  assert.deepEqual(await store.recent('TONE', 'UTWO'), []);
});

test('Firestore sender permissions persist across instances and missing state denies sending', async () => {
  const db = database();
  const first = new FirestoreSenders(db, ['UADMIN']);
  const second = new FirestoreSenders(db, ['UADMIN']);
  assert.equal((await first.policy('TONE')).allowed.size, 0);
  await first.change('TONE', { actor: 'UADMIN', operation: 'add', userId: 'USENDER' });
  assert.ok((await second.policy('TONE')).allowed.has('USENDER'));
  assert.equal((await second.policy('TOTHER')).allowed.size, 0);
  await assert.rejects(second.change('TONE', { actor: 'USENDER', operation: 'add', userId: 'UOTHER' }), /Only app administrators/);
  await second.change('TONE', { actor: 'UADMIN', operation: 'remove', userId: 'USENDER' });
  assert.equal((await first.policy('TONE')).allowed.size, 0);
});

test('the HTTP endpoint accepts signed JSON URL verification without reading user state', async (t) => {
  const server = createCloudServer({
    signingSecret: 'secret', serviceUrl: 'https://app.example', serviceAccount: 'tasks@example', verifier: {}, handleTask: async () => {},
    handleSlack: createCloudHandler({ store: {}, queue: {}, client: {}, teamId: 'TONE', appName: 'Slack Broadcast' }),
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const body = JSON.stringify({ type: 'url_verification', challenge: 'slack-challenge' });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = `v0=${createHmac('sha256', 'secret').update(`v0:${timestamp}:${body}`).digest('hex')}`;
  const response = await fetch(`http://127.0.0.1:${server.address().port}/slack/events`, {
    method: 'POST', body, headers: { 'Content-Type': 'application/json; charset=utf-8', 'x-slack-signature': signature, 'x-slack-request-timestamp': timestamp },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { challenge: 'slack-challenge' });
});
