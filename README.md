# Slack Broadcast

A custom Slack app that sends one message to multiple channels from a single dialog. Messages appear from **Slack Broadcast** by default; the name is configurable.

For deployment to Google Cloud, see [CLOUD_RUN.md](CLOUD_RUN.md). It uses Slack HTTP callbacks, request-based Cloud Run with minimum instances 0, Cloud Tasks, and Firestore. The instructions below describe running Socket Mode locally; cloud message retention and retry behavior are documented in the deployment guide.

For the step-by-step production installation, start with [SETUP.md](SETUP.md). Credentials are populated directly in Secret Manager after Terraform creates their empty containers; secret payloads never enter Terraform.

The container uses `cgr.dev/chainguard/node:latest-dev` to install dependencies and run all tests, then copies the application into `cgr.dev/chainguard/node:latest`. Both Dockerfile bases use tags without digest pins. The public tags currently provide Node.js 26; they can advance on later builds. The final image runs as UID/GID 65532 and inherits Chainguard's Node entrypoint. The free runtime includes npm and a shell; version-specific and `-slim` variants require separate Chainguard access. See [Chainguard's Node image](https://images.chainguard.dev/directory/image/node/versions).

1. Open the app's **Home** tab and click **Compose message**, or run `/broadcast` (or `/broadcast Your message here`).
2. Choose saved channel groups, optionally add individual channels, and compose the message.
3. Review the message and recipients, then click **Send to N**.
4. See delivery results for each channel. `/broadcast status` reopens your latest receipt.

The app makes separate Slack API calls for each channel, with up to three sends in flight. Delivery is not atomic: one channel can succeed while another fails. The app never rolls back successful sends or automatically resends a whole broadcast.

## Set up your Slack app

You need permission to install a custom app in the target workspace and Node.js 22.9 or newer (Node.js 24 LTS is a suitable default).

1. Open [Your Slack Apps](https://api.slack.com/apps), choose **Create New App → From a manifest**, and select your workspace.
2. Choose JSON and paste [manifest.json](manifest.json). Create the app. The manifest enables Socket Mode, the Home tab, interactivity, `/broadcast`, and the four permissions listed below.
3. Under **Basic Information → App-Level Tokens**, generate a token with the `connections:write` scope. Copy the `xapp-…` token.
4. Under **OAuth & Permissions**, choose **Install to Workspace** and copy the **Bot User OAuth Token** (`xoxb-…`). Your workspace may require an administrator to approve installation.
5. In this project directory, install dependencies and create your local environment file:

   ```sh
   npm ci
   cp .env.example .env
   ```

6. Edit `.env` locally and set `SLACK_APP_TOKEN` and `SLACK_BOT_TOKEN`. Set `SLACK_ALLOWED_USER_IDS` for initial senders and `SLACK_ADMIN_USER_IDS` for the administrators who can manage them from Home. Once local administration is enabled, its sender list is persisted under `DATA_DIR`. Without local administrators, the legacy environment allowlist applies; only in that legacy mode does an empty list permit everyone.
7. Invite **Slack Broadcast** (or your configured app name) to every destination channel using the channel's **Integrations → Add apps** control. Private channels require an invitation too. The channel picker shows channels available to the person composing; choosing a channel does not grant the app access.
8. Start the app:

   ```sh
   npm start
   ```

9. In Slack, enter `/broadcast`, select channels, compose a message, and review before sending.

Socket Mode uses an outbound WebSocket connection, so a public server URL or tunnel is unnecessary. Keep the Node process running for the command to work. For continuous use, run one instance on a host with persistent storage and outbound access to Slack. If `/broadcast` conflicts with another installed app, change the command in both `manifest.json` and `src/handlers.js`, then update the app's configuration.

## Configure the app name

Set `SLACK_APP_NAME` in `.env`. The default is `Slack Broadcast`. Names must fit Slack's 35-character app-name limit and occupy a single line.

```dotenv
SLACK_APP_NAME=Slack Broadcast
```

Run `npm run manifest` to create `manifest.generated.json`, then paste that file into **App Manifest** in your [Slack app settings](https://api.slack.com/apps), review, and save. You can also use it when creating a new Slack app. This updates both the installed app name and its bot display name. Restart the Node process to update the labels in the composer and review screens.

Changing `.env` alone updates this program's labels after restart; the actual message sender name is controlled by the Slack app's bot profile. Apply the generated manifest to keep those names aligned. The app uses its configured bot identity and does not request `chat:write.customize` or override the sender on individual messages. See [Slack's manifest propagation behavior](https://docs.slack.dev/app-management/distribution/) for how bot profile changes reach installations.

## Who can use it

Access is divided into these controls:

| Control | Current behavior |
| --- | --- |
| Install the app | Your workspace's app installation policy determines who can install or approve it. |
| Approve/remove senders | App administrators listed in the deployment's `SLACK_ADMIN_USER_IDS` can manage the live sender list from Home. Slack workspace administrators do not automatically receive this role. |
| Use the composer, send, and manage groups | Only approved senders in the workspace's Firestore access record can use these features in the cloud app. An empty or missing sender list denies sending. |
| Post to a channel | The bot must have joined every destination. For private destinations, the sender must also be a member. Slack posting restrictions apply. |

The deployment initializes approved senders and app administrators. Terraform initializes the sender list once; later Home changes take effect without redeployment and are not overwritten by subsequent Terraform runs. Administrator changes remain a deployment operation. Administrators who are not approved senders can manage access from Home and can approve themselves to broadcast.

The app checks workspace and sender permission on each interaction and again during queued delivery. A person who is not approved may still see `/broadcast`, but the app denies their request. Only each sender's own delivery results are shown on Home. Access changes record the actor, affected member, action, and timestamp; the latest 100 changes are kept with the access configuration.

| Bot permission | Purpose |
| --- | --- |
| `commands` | Receive slash commands |
| `chat:write` | Post as the app in channels it has joined |
| `channels:read` | Read public channel metadata to check bot membership |
| `groups:read` | Read private channel metadata to check shared membership |

The native picker is populated by Slack. The metadata permissions support server-side access checks and safe shared-group use; no channel history or direct-message history scopes are requested. Local Socket Mode additionally uses an app-level token with `connections:write`. Cloud HTTP mode uses the signing secret instead. Apply updated scopes and reinstall the app if it was created with an older manifest.

## Where the UI lives

Open **Slack Broadcast → Home** to compose messages, manage shared channel groups, and view your five latest delivery results. Administrators also see **Approved senders**, with controls to add a workspace member or remove sending access. Other users see app ownership, permissions, retention information, and an access notice. Refresh Home to load the latest results.

`/broadcast` opens the same private composer; `/broadcast groups` opens shared groups; `/broadcast status` opens the latest receipt. Neither Home actions nor commands post into the launch channel. Messages are posted only after the sender reviews and confirms Send. The Home view uses Slack's [App Home surface](https://docs.slack.dev/surfaces/app-home/).

## Shared channel groups

Approved senders can create, view, rename, and delete groups, and add or remove their member channels. Groups are shared by approved senders in the installed workspace. There can be up to 25 groups, each with up to 25 channels. Groups contain channel IDs and the creator/updater IDs and timestamps, and persist until removed.

The **Saved channel groups** picker in the composer lists existing groups and their channel counts. Select one or more groups and optionally add individual channels. Review expands the groups into one recipient list, removes duplicate channels, and enforces the 25-channel total limit. Use **Manage channel groups** in the composer or **Shared channel groups** on Home to create or edit groups. Group management preserves the message and selections you are drafting. A group's later edits do not change destinations already saved in a reviewed or queued broadcast.

The Slack app icon is available at [assets/slack-broadcast-icon.png](assets/slack-broadcast-icon.png). Upload it under **Basic Information → Display Information → App icon** in the Slack app settings.

Private channels are shown only to senders who belong to them. When editing a group, inaccessible existing channels are preserved rather than silently removed. Using a whole group is blocked if any member channel is unavailable to the sender or app. Group edits use versions so simultaneous changes do not overwrite one another. Removing a channel from a saved group changes that group only; it does not change Slack channel membership.

## Selected operating policy

The app is intended for ordinary internal communications. Slack Connect destinations are allowed when the sender and app have access. The sender's own review is sufficient to publish; there is no second-person approval step.

## Behavior and limits

- Maximum 25 channels and 2,800 characters per broadcast. Direct messages and group DMs are excluded.
- Slack message formatting such as `*bold*`, `_italic_`, and links is supported. The review screen shows the message before sending. Link and media previews are disabled. Explicit Slack mention markup can notify recipients.
- Each channel receives an independent message. Replies and later edits are independent. This version handles text; attachments, templates, and scheduling are future additions.
- A send rejected by Slack is reported as failed. Only explicit HTTP rate-limit rejections are retried, at most twice, with a maximum 30-second wait per retry. Network errors are reported as **delivery unconfirmed** because Slack may already have accepted the message. Check that channel before trying again.
- Duplicate Send submissions for the same draft do not trigger another broadcast. Composing and confirming a new draft is a new broadcast.
- Drafts expire after 30 minutes and are lost on restart. Draft text is kept in memory and released after sending; the app does not persist the text.
- Delivery receipts under `DATA_DIR` contain the sender/workspace IDs, channel IDs, timestamps, statuses, and Slack error codes. They contain no message text or tokens. Receipts are retained until you remove them. `/broadcast status` shows only the requesting person's latest receipt in the installed workspace.
- After a restart, unfinished sends are not retried: an in-flight send becomes **delivery unconfirmed**, and a queued send becomes **not sent**. Keep the receipt directory on persistent storage. Run only one app instance against this directory; the local journal is not a distributed queue.
- A forced process stop or storage failure can interrupt delivery. Graceful SIGINT/SIGTERM shutdown waits for active broadcasts. The app cannot guarantee exact delivery after network failures or machine crashes.

## Development

```sh
npm run dev
npm test
```

Tests use fake Slack clients and temporary receipt directories; they do not post messages to Slack.

The application uses [Slack Bolt for JavaScript](https://docs.slack.dev/tools/bolt-js/), [Socket Mode](https://docs.slack.dev/tools/bolt-js/concepts/socket-mode/), [Block Kit modals](https://docs.slack.dev/surfaces/modals/), and [`chat.postMessage`](https://docs.slack.dev/reference/methods/chat.postMessage/).
