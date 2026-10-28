import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DEFAULT_APP_NAME, getAppName, configureManifest } from '../src/branding.js';
import { createViews } from '../src/views.js';

test('default branding matches the checked-in Slack app and bot names', async () => {
  const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));
  assert.equal(getAppName(''), 'Slack Broadcast');
  assert.equal(manifest.display_information.name, DEFAULT_APP_NAME);
  assert.equal(manifest.features.bot_user.display_name, DEFAULT_APP_NAME);
});

test('custom names update both Slack identity fields without changing permissions or the template', async () => {
  const template = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));
  const result = configureManifest(template, '  Partner Communications  ');
  assert.equal(result.display_information.name, 'Partner Communications');
  assert.equal(result.features.bot_user.display_name, 'Partner Communications');
  assert.equal(template.display_information.name, DEFAULT_APP_NAME);
  assert.deepEqual(result.oauth_config, template.oauth_config);
  assert.deepEqual(result.features.slash_commands, template.features.slash_commands);
});

test('branding is displayed as plain text and keeps Slack modal titles within 24 characters', () => {
  const name = 'A name with <markup> & *formatting*';
  const views = createViews(name);
  const draft = { id: 'draft', channels: ['CONE'], text: 'Hello' };
  const rendered = [
    views.composeView(draft), views.reviewView(draft), views.noticeView('Notice'),
    views.statusView({ id: 'job', results: [{ channel: 'CONE', status: 'sent' }], finishedAt: 'now' }),
  ];
  for (const view of rendered) {
    assert.ok([...view.title.text].length <= 24);
    const textElements = view.blocks.flatMap((block) => [block.text, block.hint, ...(block.elements || [])]).filter(Boolean);
    const branded = textElements.filter((element) => typeof element.text === 'string' && element.text.includes(name));
    assert.ok(branded.length > 0);
    assert.ok(branded.every((element) => element.type === 'plain_text'));
  }
});

test('names incompatible with the Slack manifest are rejected', () => {
  assert.throws(() => getAppName('a'.repeat(36)), /35 characters/);
  assert.throws(() => getAppName('Company\nCommunications'), /single line/);
});

test('the cloud manifest configures both Slack callback URLs and disables Socket Mode', async () => {
  const template = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));
  const result = configureManifest(template, DEFAULT_APP_NAME, {
    transport: 'http', serviceUrl: 'https://slack-broadcast-123456789.us-central1.run.app',
  });
  assert.equal(result.settings.socket_mode_enabled, false);
  assert.equal(result.settings.interactivity.request_url, 'https://slack-broadcast-123456789.us-central1.run.app/slack/events');
  assert.equal(result.features.slash_commands[0].url, result.settings.interactivity.request_url);
  assert.equal(result.settings.event_subscriptions.request_url, result.settings.interactivity.request_url);
  assert.deepEqual(result.settings.event_subscriptions.bot_events, ['app_home_opened']);
  assert.equal(result.features.app_home.home_tab_enabled, true);
  assert.equal(template.settings.socket_mode_enabled, true);
  assert.deepEqual(result.oauth_config.scopes.bot, ['commands', 'chat:write', 'channels:read', 'groups:read']);
  assert.throws(() => configureManifest(template, DEFAULT_APP_NAME, { transport: 'http', serviceUrl: 'http://insecure.example' }), /HTTPS/);
});
