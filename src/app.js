import { App } from '@slack/bolt';
import { resolve } from 'node:path';
import { Journal } from './journal.js';
import { registerHandlers } from './handlers.js';
import { getAppName } from './branding.js';
import { LocalSenders } from './approved-senders.js';

function token(name, prefix) {
  const value = process.env[name];
  if (!value?.startsWith(prefix) || value.includes('replace-me')) {
    throw new Error(`Set ${name} in .env. See README.md for setup.`);
  }
  return value;
}

try {
  const appName = getAppName();
  const app = new App({
    token: token('SLACK_BOT_TOKEN', 'xoxb-'),
    appToken: token('SLACK_APP_TOKEN', 'xapp-'),
    socketMode: true,
    clientOptions: {
      // Ambiguous network errors must never automatically duplicate a broadcast.
      retryConfig: { retries: 0 },
      rejectRateLimitedCalls: true,
      timeout: 15_000,
    },
  });
  const journal = new Journal(resolve(process.env.DATA_DIR || './data'));
  await journal.load();
  const auth = await app.client.auth.test();
  if (!auth.team_id || !auth.bot_id) throw new Error('Use a workspace bot token from OAuth & Permissions.');
  const allowedUsers = new Set((process.env.SLACK_ALLOWED_USER_IDS || '').split(',').map((id) => id.trim()).filter(Boolean));
  if ([...allowedUsers].some((id) => !/^[UW][A-Z0-9]+$/.test(id))) throw new Error('SLACK_ALLOWED_USER_IDS must contain comma-separated Slack member IDs.');
  const admins = new Set((process.env.SLACK_ADMIN_USER_IDS || '').split(',').map((id) => id.trim()).filter(Boolean));
  if ([...admins].some((id) => !/^[UW][A-Z0-9]+$/.test(id))) throw new Error('SLACK_ADMIN_USER_IDS must contain comma-separated administrator member IDs.');
  const senders = admins.size ? new LocalSenders(journal.directory, admins, allowedUsers) : undefined;
  const handlers = registerHandlers(app, { journal, teamId: auth.team_id, allowedUsers, appName, senders });
  app.error(async (error) => {
    app.logger.error(`Slack event failed: ${error.code || error.name || 'unknown_error'}`);
  });
  await app.start();
  app.logger.info(`${appName} is connected. Run /broadcast in Slack.`);
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    app.logger.info('Finishing active broadcasts before shutdown…');
    await app.stop();
    await handlers.drain();
  };
  process.on('SIGINT', () => { void stop().catch(() => { process.exitCode = 1; }); });
  process.on('SIGTERM', () => { void stop().catch(() => { process.exitCode = 1; }); });
} catch (error) {
  console.error(error.code ? `Could not start the communications app (${error.code}). Check the Slack credentials and network connection.` : error.message);
  process.exitCode = 1;
}
