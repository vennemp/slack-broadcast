terraform {
  required_version = ">= 1.6.0"
  required_providers {
    google = { source = "hashicorp/google", version = "~> 7.0" }
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

variable "project_id" { type = string }
variable "region" {
  type    = string
  default = "us-central1"
}
variable "image" {
  type        = string
  default     = ""
  description = "An already-built container image; prefer an immutable digest."
}
variable "slack_team_id" {
  type    = string
  default = ""
  validation {
    condition     = var.slack_team_id == "" || can(regex("^T[A-Z0-9]+$", var.slack_team_id))
    error_message = "Provide the installed Slack workspace ID, such as T0123456789."
  }
}
variable "deploy_app" {
  type        = bool
  default     = false
  description = "First apply false to create infrastructure and empty secret containers. Populate secrets out of band, then set true with workspace ID and image."
}
variable "allowed_user_ids" {
  type        = list(string)
  description = "Initial approved sender IDs, used only to initialize Firestore. After deployment, manage senders from App Home. Empty means no approved senders."
  validation {
    condition     = alltrue([for id in var.allowed_user_ids : can(regex("^[UW][A-Z0-9]+$", id))])
    error_message = "Provide Slack member IDs, such as U0123456789."
  }
}
variable "admin_user_ids" {
  type        = list(string)
  description = "App administrators who can add or remove approved senders. Only deployment configuration can change administrators."
  validation {
    condition     = length(var.admin_user_ids) > 0 && alltrue([for id in var.admin_user_ids : can(regex("^[UW][A-Z0-9]+$", id))])
    error_message = "Provide at least one app administrator's Slack member ID."
  }
}
variable "app_name" {
  type    = string
  default = "Slack Broadcast"
}
variable "service_name" {
  type    = string
  default = "slack-broadcast"
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{0,29}$", var.service_name))
    error_message = "Use a short lowercase service name (maximum 30 characters)."
  }
}
variable "bot_token_secret" {
  type        = string
  description = "Secret Manager container ID for the bot token; populate its value outside Terraform."
}
variable "bot_token_version" {
  type    = string
  default = "1"
}
variable "signing_secret" {
  type        = string
  description = "Secret Manager container ID for the signing secret; populate its value outside Terraform."
}
variable "signing_secret_version" {
  type    = string
  default = "1"
}
variable "create_firestore_database" {
  type        = bool
  default     = true
  description = "Set false if the default Firestore Native database already exists."
}
variable "registry_repository" {
  type    = string
  default = "slack-broadcast"
}
variable "registry_kms_key" {
  type        = string
  default     = null
  description = "Optional existing regional KMS key for the dedicated image repository."
}

data "google_project" "current" { project_id = var.project_id }

locals {
  # Predictable service URL avoids a self-reference in the Cloud Run environment.
  service_url = "https://${var.service_name}-${data.google_project.current.number}.${var.region}.run.app"
  queue_name  = "slack-broadcast"
}

resource "google_project_service" "apis" {
  for_each = toset([
    "run.googleapis.com", "cloudtasks.googleapis.com", "firestore.googleapis.com",
    "secretmanager.googleapis.com", "iam.googleapis.com", "artifactregistry.googleapis.com",
  ])
  service            = each.value
  disable_on_destroy = false
}

resource "google_artifact_registry_repository" "app" {
  project       = var.project_id
  location      = var.region
  repository_id = var.registry_repository
  description   = "Slack broadcast application container images"
  format        = "DOCKER"
  kms_key_name  = var.registry_kms_key
  depends_on    = [google_project_service.apis]
}

resource "google_service_account" "runtime" {
  account_id   = "slack-broadcast-runtime"
  display_name = "Slack broadcast runtime"
  depends_on   = [google_project_service.apis]
}

resource "google_service_account" "tasks" {
  account_id   = "slack-broadcast-tasks"
  display_name = "Slack broadcast delivery task identity"
  depends_on   = [google_project_service.apis]
}

resource "google_service_account_iam_member" "enqueue_as_tasks" {
  service_account_id = google_service_account.tasks.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.runtime.email}"
}

resource "google_service_account_iam_member" "task_agent_identity" {
  service_account_id = google_service_account.tasks.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:service-${data.google_project.current.number}@gcp-sa-cloudtasks.iam.gserviceaccount.com"
}

resource "google_project_iam_member" "firestore" {
  project = var.project_id
  role    = "roles/datastore.user"
  member  = "serviceAccount:${google_service_account.runtime.email}"
}

resource "google_secret_manager_secret" "credentials" {
  for_each  = toset([var.bot_token_secret, var.signing_secret])
  project   = var.project_id
  secret_id = each.value
  replication {
    auto {}
  }
  deletion_protection = true
  depends_on          = [google_project_service.apis]
}

# Payloads are created out of band. No secret-version resource or payload data
# source is used anywhere in this configuration.
resource "google_secret_manager_secret_iam_member" "secrets" {
  for_each  = google_secret_manager_secret.credentials
  project   = var.project_id
  secret_id = each.value.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.runtime.email}"
}

resource "google_firestore_database" "default" {
  count                   = var.create_firestore_database ? 1 : 0
  name                    = "(default)"
  location_id             = var.region
  type                    = "FIRESTORE_NATIVE"
  delete_protection_state = "DELETE_PROTECTION_ENABLED"
  deletion_policy         = "ABANDON"
  depends_on              = [google_project_service.apis]
}

resource "google_firestore_field" "expiry" {
  for_each   = toset(["slackBroadcastDrafts", "slackBroadcastJobs"])
  database   = "(default)"
  collection = each.value
  field      = "expiresAt"
  ttl_config {}
  depends_on = [google_project_service.apis, google_firestore_database.default]
}

resource "google_firestore_document" "approved_senders" {
  count           = var.slack_team_id == "" ? 0 : 1
  project         = var.project_id
  database        = "(default)"
  collection      = "slackBroadcastAccess"
  document_id     = var.slack_team_id
  deletion_policy = "ABANDON"
  fields = jsonencode({
    senders = { arrayValue = { values = [for id in var.allowed_user_ids : { stringValue = id }] } }
    history = { arrayValue = { values = [] } }
  })
  # Terraform initializes the list once. App Home owns subsequent sender changes.
  lifecycle { ignore_changes = [fields] }
  depends_on = [google_project_service.apis, google_firestore_database.default]
}

resource "google_cloud_tasks_queue" "delivery" {
  name     = local.queue_name
  location = var.region
  rate_limits {
    max_concurrent_dispatches = 2
    max_dispatches_per_second = 1
  }
  retry_config {
    max_attempts       = 100
    max_retry_duration = "86400s"
    min_backoff        = "10s"
    max_backoff        = "600s"
    max_doublings      = 5
  }
  depends_on = [google_project_service.apis]
}

resource "google_cloud_tasks_queue_iam_member" "enqueue" {
  name     = google_cloud_tasks_queue.delivery.name
  location = var.region
  role     = "roles/cloudtasks.enqueuer"
  member   = "serviceAccount:${google_service_account.runtime.email}"
}

resource "google_cloud_run_v2_service" "app" {
  count               = var.deploy_app ? 1 : 0
  name                = var.service_name
  location            = var.region
  deletion_protection = false
  ingress             = "INGRESS_TRAFFIC_ALL"
  # Public ingress is authenticated inside the app with Slack HMAC / task OIDC.
  # This per-service setting is permitted by the project's effective Cloud Run
  # policy; domain-restricted sharing rejects an allUsers IAM binding.
  invoker_iam_disabled = true
  lifecycle {
    precondition {
      condition     = var.image != "" && can(regex("^T[A-Z0-9]+$", var.slack_team_id))
      error_message = "Before deploying the app, set its container image and workspace T… ID, and populate the referenced secret versions outside Terraform."
    }
  }
  template {
    service_account = google_service_account.runtime.email
    timeout         = "300s"
    scaling {
      min_instance_count = 0
      max_instance_count = 2
    }
    max_instance_request_concurrency = 20
    containers {
      image = var.image
      ports { container_port = 8080 }
      resources {
        limits            = { cpu = "1", memory = "512Mi" }
        cpu_idle          = true
        startup_cpu_boost = true
      }
      dynamic "env" {
        for_each = {
          SLACK_APP_NAME       = var.app_name
          SLACK_TEAM_ID        = var.slack_team_id
          SLACK_ADMIN_USER_IDS = join(",", var.admin_user_ids)
          GOOGLE_CLOUD_PROJECT = var.project_id
          GOOGLE_CLOUD_REGION  = var.region
          CLOUD_TASKS_QUEUE    = local.queue_name
          TASK_SERVICE_ACCOUNT = google_service_account.tasks.email
          SERVICE_URL          = local.service_url
        }
        content {
          name  = env.key
          value = env.value
        }
      }
      env {
        name = "SLACK_BOT_TOKEN"
        value_source {
          secret_key_ref {
            secret  = var.bot_token_secret
            version = var.bot_token_version
          }
        }
      }
      env {
        name = "SLACK_SIGNING_SECRET"
        value_source {
          secret_key_ref {
            secret  = var.signing_secret
            version = var.signing_secret_version
          }
        }
      }
    }
  }
  depends_on = [
    google_project_service.apis, google_secret_manager_secret_iam_member.secrets,
    google_project_iam_member.firestore, google_service_account_iam_member.enqueue_as_tasks,
    google_service_account_iam_member.task_agent_identity,
    google_cloud_tasks_queue_iam_member.enqueue, google_firestore_database.default,
    google_firestore_document.approved_senders,
    google_artifact_registry_repository.app,
  ]
}

output "service_url" { value = local.service_url }
output "slack_request_url" { value = "${local.service_url}/slack/events" }
output "app_deployed" { value = var.deploy_app }
output "credential_secret_ids" { value = [for secret in google_secret_manager_secret.credentials : secret.secret_id] }
output "registry_url" { value = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.app.repository_id}" }
