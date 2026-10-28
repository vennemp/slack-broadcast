import { readFile, writeFile } from 'node:fs/promises';
import { configureManifest, getAppName } from './branding.js';

try {
  const template = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));
  const manifest = configureManifest(template, getAppName(), { transport: process.env.APP_TRANSPORT || 'socket', serviceUrl: process.env.SERVICE_URL });
  await writeFile(new URL('../manifest.generated.json', import.meta.url), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Generated manifest.generated.json for ${manifest.display_information.name}. Apply it in your Slack app's App Manifest settings.`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
