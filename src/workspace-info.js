import { WebClient } from '@slack/web-api';
import { GoogleAuth } from 'google-auth-library';

try {
  let token = process.env.SLACK_BOT_TOKEN;
  const secret = process.env.SLACK_BOT_TOKEN_SECRET;
  if (secret) {
    const project = process.env.GOOGLE_CLOUD_PROJECT;
    if (!project) throw new Error('Set GOOGLE_CLOUD_PROJECT to read the app token from Secret Manager.');
    const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
    const google = await auth.getClient();
    const { data } = await google.request({
      url: `https://secretmanager.googleapis.com/v1/projects/${encodeURIComponent(project)}/secrets/${encodeURIComponent(secret)}/versions/latest:access`,
      timeout: 15_000,
    });
    token = Buffer.from(data.payload.data, 'base64').toString('utf8').trim();
  }
  if (!token || token.includes('replace-me')) throw new Error('Set SLACK_BOT_TOKEN locally, or GOOGLE_CLOUD_PROJECT and SLACK_BOT_TOKEN_SECRET to read the app token from Secret Manager.');
  if (!token.startsWith('xoxb-')) throw new Error('Use the new app’s workspace bot token.');
  const client = new WebClient(token, { retryConfig: { retries: 0 }, timeout: 15_000 });
  const auth = await client.auth.test();
  if (!/^T[A-Z0-9]+$/.test(auth.team_id || '')) throw new Error('This token does not identify a single installed workspace.');
  if (process.env.SLACK_ENTERPRISE_ID && auth.enterprise_id !== process.env.SLACK_ENTERPRISE_ID) throw new Error('This app token belongs to a different Enterprise organization.');
  // Output only non-secret installation identifiers, never the credential.
  console.log(JSON.stringify({ workspace_id: auth.team_id, workspace_name: auth.team, enterprise_id: auth.enterprise_id || null }, null, 2));
} catch (error) {
  console.error(error.code ? `Could not resolve the workspace (${error.code}). Check access to the app's token.` : error.message);
  process.exitCode = 1;
}
