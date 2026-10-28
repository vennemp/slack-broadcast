import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createCloudHandler } from '../src/cloud-handlers.js';

const expected = ['U0123456789'];
const expectedAdmins = ['U0123456789'];

test('the example deployment configuration defines approved senders and administrators', async () => {
  const tfvars = await readFile(new URL('../terraform/terraform.tfvars.example', import.meta.url), 'utf8');
  const block = tfvars.match(/allowed_user_ids\s*=\s*\[([\s\S]*?)\]/)[1];
  const actual = [...block.matchAll(/"(U[A-Z0-9]+)"/g)].map((match) => match[1]);
  assert.deepEqual(actual, expected);
  const environment = await readFile(new URL('../.env.cloud.example', import.meta.url), 'utf8');
  const adminBlock = tfvars.match(/admin_user_ids\s*=\s*\[([\s\S]*?)\]/)[1];
  assert.deepEqual([...adminBlock.matchAll(/"(U[A-Z0-9]+)"/g)].map((match) => match[1]), expectedAdmins);
  assert.equal(environment.match(/^SLACK_ADMIN_USER_IDS=(.*)$/m)[1], expectedAdmins.join(','));
});

test('each configured communications member can open the composer and an unlisted user is denied', async () => {
  let opened = 0;
  const handler = createCloudHandler({
    teamId: 'TONE', allowedUsers: new Set(expected), appName: 'Slack Broadcast',
    store: { createDraft: async () => ({ id: 'draft', channels: [], text: '' }) },
    queue: {}, client: { views: { open: async () => { opened += 1; } } },
  });
  for (const user_id of expected) {
    assert.deepEqual(await handler({ command: '/broadcast', team_id: 'TONE', user_id, text: '', trigger_id: 'trigger' }), {});
  }
  const denied = await handler({ command: '/broadcast', team_id: 'TONE', user_id: 'UUNLISTED', text: '' });
  assert.equal(opened, 1);
  assert.match(denied.text, /do not have access/);
});

test('Terraform creates empty secret containers and keeps app deployment separate from payload entry', async () => {
  const main = await readFile(new URL('../terraform/main.tf', import.meta.url), 'utf8');
  assert.match(main, /resource "google_secret_manager_secret" "credentials"/);
  assert.equal(/(?:resource|data)\s+"google_secret_manager_secret_version"/.test(main), false);
  assert.equal(/\bsecret_data\b/.test(main), false);
  assert.match(main, /secret_key_ref/);
  assert.match(main, /count\s*=\s*var\.deploy_app \? 1 : 0/);
  const target = await readFile(new URL('../terraform/terraform.tfvars.example', import.meta.url), 'utf8');
  assert.match(target, /deploy_app\s*=\s*false/);
});
