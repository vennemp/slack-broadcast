import { WebClient } from '@slack/web-api';
import { Firestore } from '@google-cloud/firestore';
import { CloudTasksClient } from '@google-cloud/tasks';
import { OAuth2Client } from 'google-auth-library';
import { getAppName } from './branding.js';
import { CloudStore } from './cloud-store.js';
import { createQueue } from './cloud-queue.js';
import { createCloudHandler, cloudStatusView } from './cloud-handlers.js';
import { createCloudServer } from './cloud-server.js';
import { processCloudJob } from './cloud-worker.js';
import { FirestoreGroups } from './channel-groups.js';
import { ChannelAccess } from './channel-access.js';
import { FirestoreSenders } from './approved-senders.js';

function required(name) {
  const value = process.env[name];
  if (!value || value.includes('replace-me')) throw new Error(`Set ${name} in the deployment configuration.`);
  return value;
}

try {
  const appName = getAppName();
  const token = required('SLACK_BOT_TOKEN');
  if (!token.startsWith('xoxb-')) throw new Error('SLACK_BOT_TOKEN must be a bot token.');
  const signingSecret = required('SLACK_SIGNING_SECRET');
  const teamId = required('SLACK_TEAM_ID');
  if (!/^T[A-Z0-9]+$/.test(teamId)) throw new Error('SLACK_TEAM_ID must be a workspace T… ID. Use npm run workspace:info to resolve it from the bot token.');
  const projectId = required('GOOGLE_CLOUD_PROJECT');
  const region = process.env.GOOGLE_CLOUD_REGION || 'us-central1';
  const queueId = process.env.CLOUD_TASKS_QUEUE || 'slack-broadcast';
  const serviceAccount = required('TASK_SERVICE_ACCOUNT');
  const serviceUrl = new URL(required('SERVICE_URL')).origin;
  if (!serviceUrl.startsWith('https://')) throw new Error('SERVICE_URL must use HTTPS.');
  const admins = new Set(required('SLACK_ADMIN_USER_IDS').split(',').map((value) => value.trim()).filter(Boolean));
  if (!admins.size || [...admins].some((id) => !/^[UW][A-Z0-9]+$/.test(id))) throw new Error('SLACK_ADMIN_USER_IDS must contain app administrator member IDs.');
  const client = new WebClient(token, { retryConfig: { retries: 0 }, rejectRateLimitedCalls: true, timeout: 15_000 });
  const db = new Firestore({ projectId, databaseId: process.env.FIRESTORE_DATABASE || '(default)', preferRest: true, ignoreUndefinedProperties: true });
  const store = new CloudStore(db);
  const groups = new FirestoreGroups(db);
  const senders = new FirestoreSenders(db, admins);
  const access = new ChannelAccess(client);
  const tasks = new CloudTasksClient({ fallback: true });
  const queue = createQueue({ client: tasks, projectId, region, queueId, serviceUrl, serviceAccount });
  const handleSlack = createCloudHandler({ store, queue, client, teamId, appName, groups, access, senders });
  const server = createCloudServer({
    signingSecret, handleSlack, verifier: new OAuth2Client(), serviceUrl, serviceAccount,
    handleTask: async (id) => {
      const result = await processCloudJob({ id, store, client, access, permitted: async (userId, workspace) => workspace === teamId && (await senders.policy(teamId)).allowed.has(userId) });
      if (result.state === 'done' && result.job.viewId) {
        try { await client.views.update({ view_id: result.job.viewId, view: cloudStatusView(result.job, appName) }); }
        catch (error) { console.warn(`Result dialog unavailable: ${error.code || error.name}`); }
      }
      return result;
    },
  });
  server.listen(Number(process.env.PORT || 8080), '0.0.0.0', () => console.log(`${appName} HTTP service is ready.`));
  process.on('SIGTERM', () => server.close());
  process.on('SIGINT', () => server.close());
} catch (error) {
  console.error(`Could not start HTTP service: ${error.message}`);
  process.exitCode = 1;
}
