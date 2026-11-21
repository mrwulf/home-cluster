variable "MINIO_ROOT_USER" {
  type      = string
  sensitive = true
}
variable "MINIO_ROOT_PASSWORD" {
  type      = string
  sensitive = true
}

terraform {
  required_providers {
    minio = {
      source  = "aminueza/minio"
      version = "~> 3.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
}

provider "minio" {
  minio_server   = "minio.databases.svc.cluster.local:9000"
  minio_user     = var.MINIO_ROOT_USER
  minio_password = var.MINIO_ROOT_PASSWORD
  minio_ssl      = false
}

# Same shape as cluster/apps/household/outline/minio-bucket: a bucket-scoped
# IAM user, with the Kyverno policy sync-rowboat-minio-credentials cloning the
# derived secret into ai so MinIO's root credentials never leave databases.
# The bucket is new, so unlike outline there is nothing to import.

resource "minio_s3_bucket" "rowboat" {
  bucket = "rowboat"
  acl    = "private"
}

resource "random_password" "rowboat_secret_key" {
  length  = 40
  special = false
}

resource "minio_iam_user" "rowboat_app" {
  name          = "rowboat-app"
  secret        = random_password.rowboat_secret_key.result
  force_destroy = true
}

resource "minio_iam_policy" "rowboat_app" {
  name = "rowboat-app"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
        Resource = ["arn:aws:s3:::${minio_s3_bucket.rowboat.bucket}/*"]
      },
      {
        Effect   = "Allow"
        Action   = ["s3:ListBucket"]
        Resource = ["arn:aws:s3:::${minio_s3_bucket.rowboat.bucket}"]
      }
    ]
  })
}

resource "minio_iam_user_policy_attachment" "rowboat_app" {
  user_name   = minio_iam_user.rowboat_app.id
  policy_name = minio_iam_policy.rowboat_app.id
}

# Named for what Harbor reads (BLOBS_S3_*).
output "BLOBS_S3_ACCESS_KEY_ID" {
  value = minio_iam_user.rowboat_app.name
}

output "BLOBS_S3_SECRET_ACCESS_KEY" {
  value     = minio_iam_user.rowboat_app.secret
  sensitive = true
}
