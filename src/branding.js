export const DEFAULT_APP_NAME = 'Slack Broadcast';

export function getAppName(value = process.env.SLACK_APP_NAME) {
  const name = value?.trim() || DEFAULT_APP_NAME;
  if ([...name].length > 35 || /[\r\n\t]/.test(name)) {
    throw new Error('SLACK_APP_NAME must be a single line of at most 35 characters.');
  }
  return name;
}

export function configureManifest(template, name, { transport = 'socket', serviceUrl } = {}) {
  const manifest = structuredClone(template);
  const appName = getAppName(name);
  manifest.display_information.name = appName;
  manifest.features.bot_user.display_name = appName;
  if (transport === 'http') {
    const url = new URL(serviceUrl);
    if (url.protocol !== 'https:') throw new Error('SERVICE_URL must use HTTPS.');
    const endpoint = `${url.origin}/slack/events`;
    manifest.settings.socket_mode_enabled = false;
    manifest.settings.interactivity.request_url = endpoint;
    manifest.settings.event_subscriptions.request_url = endpoint;
    for (const command of manifest.features.slash_commands) command.url = endpoint;
  } else if (transport !== 'socket') {
    throw new Error('APP_TRANSPORT must be socket or http.');
  }
  return manifest;
}
