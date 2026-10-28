# Set up Slack Broadcast

Target: **Google Cloud Run**. Start with the Slack app, then create empty infrastructure with Terraform, enter credentials out of band into Secret Manager, and deploy the backend.

The backend uses Slack HTTP callbacks and request-based Cloud Run with minimum instances 0, Cloud Tasks, and Firestore.

## 1. Create and install the Slack app

1. Open [Your Slack Apps](https://api.slack.com/apps) and choose **Create New App → From a manifest**.
2. Choose the intended workspace (or Enterprise organization workspace).
3. Choose JSON, paste [manifest.json](manifest.json), review, and create the app. Use this initial manifest before the server exists; it enables Socket Mode temporarily so HTTP endpoints are not required during creation.
4. Under **OAuth & Permissions**, install the app to that workspace. It requests `commands`, `chat:write`, `channels:read`, and `groups:read`.
5. Locate its **Bot User OAuth Token** (`xoxb-…`) on that page and its **Signing Secret** under **Basic Information → App Credentials**. Keep the pages available for the Secret Manager step. You do not need an app-level `xapp-…` token for the Cloud Run deployment.

The short description visible on the app profile says: “Slack Broadcast application hosted on Google Cloud Run. Posts approved messages to selected channels.” Its fuller description discloses the metadata permissions and storage.

## 2. Create empty infrastructure with Terraform

From the project directory:

```sh
cd terraform
terraform init
terraform plan -out=bootstrap.tfplan
```

Review this plan before applying it:

```sh
terraform apply bootstrap.tfplan
```

The first stage has `deploy_app = false` (configured by default or in `terraform.tfvars`). It creates empty Secret Manager containers and supporting infrastructure. It requires no secret values, container image, or workspace ID. Confirm the default Firestore database creation setting before applying. For a shared deployment, configure your organization's Terraform state backend before applying.

## 3. Add credentials directly to Secret Manager

Open [Secret Manager in the Google Cloud Console](https://console.cloud.google.com/security/secret-manager):

| Secret container | Add as its first version |
| --- | --- |
| `slack-broadcast-bot-token` | The new app's Bot User OAuth Token |
| `slack-broadcast-signing-secret` | The new app's Signing Secret |

The values go into the console's secret-value field. Terraform contains container IDs, IAM bindings, and pinned version references only. No secret values belong in Terraform inputs, state, chat, or image build files.

## 4. Resolve the workspace ID

If using Slack Enterprise Grid, your browser URL shows the Enterprise organization ID (e.g. `E0123456789`). The app's workspace bot token identifies its specific `T…` workspace. From the project directory, run:

```sh
GOOGLE_CLOUD_PROJECT=your-project-id \
SLACK_BOT_TOKEN_SECRET=slack-broadcast-bot-token \
SLACK_ENTERPRISE_ID=E0123456789 \
npm run workspace:info
```

This reads the app token using Google Application Default Credentials, calls Slack's read-only identity endpoint, verifies the Enterprise organization (if specified), and prints the workspace ID/name. It does not print the token.

## 5. Build the image and deploy Cloud Run

Build and publish the image to your Artifact Registry repository (e.g., `us-east4-docker.pkg.dev/your-project-id/slack-broadcast/communications:v0.1.0`) using your normal workflow. A Docker example is in [CLOUD_RUN.md](CLOUD_RUN.md).

Copy `terraform/terraform.tfvars.example` to `terraform/terraform.tfvars`; fill in your GCP project, region, resulting immutable image digest, approved sender IDs, and the workspace ID from step 4. Set `deploy_app = true`.

```sh
cd terraform
terraform plan -out=deployment.tfplan
# Review this plan, then deploy when ready.
terraform apply deployment.tfplan
```

The service scales to zero between requests. Its token and signing secret come from Secret Manager references at runtime.

## 6. Connect Slack's HTTP callbacks

From the project directory:

```sh
APP_TRANSPORT=http \
SERVICE_URL=https://your-service-url.run.app \
SLACK_APP_NAME='Slack Broadcast' \
npm run manifest
```

In the Slack app configuration, open **App Manifest**, paste `manifest.generated.json`, review, and save. This disables Socket Mode, enables Home, and sends command, dialog, and `app_home_opened` callbacks to `/slack/events`. Slack verifies the Events API URL against the deployed backend. Reinstall if the permission list changed from the initial app.

## 7. Open Home and add destinations

1. Open **Slack Broadcast → Home** in Slack.
2. Administrators see **Approved senders** and can add or remove sending access using the workspace member picker. Initial senders and administrators can be defined in `terraform.tfvars`. Administrators must approve themselves if they need to send too.
3. Invite the app to each destination channel through the channel's **Agents & apps / Integrations** controls. For private channels, an existing channel member must add the app first, and the sender must also belong to that channel. For external channels, ask external participants for permission before adding the app (recommended). Home includes a copyable permission request explaining application ownership, Google Cloud Run hosting, posting permissions, basic channel metadata access, and the absence of message-history access.
4. Use **Shared channel groups** to create a group and add or remove its member channels.
5. Use **Compose message**. The **Saved channel groups** picker lists existing shared groups and their channel counts. Choose one or more groups and optionally add individual channels, then review the combined recipients and message and confirm **Send**. Duplicate channels receive one copy, with a maximum of 25 total channels. **Manage channel groups** opens group creation and editing. Private-channel access is checked before review and delivery. Delivery results are private and available from **Recent broadcasts** or `/broadcast status`.

Opening Home, managing access/groups, and composing a draft do not post messages into a channel. Live test messages should be sent only to destinations you deliberately select and confirm.
