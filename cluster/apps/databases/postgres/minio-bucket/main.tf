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

# Backs both postgres17 and postgres17-postgis (cluster/apps/databases/postgres/
# cluster/cluster17.yaml + cluster17-postgis.yaml) - they already share one
# bucket and one credential today via the postgres-minio Secret, so this keeps
# that shape rather than splitting into two credentials for no operational gain.
#
# Mints a brand-new, distinctly-named IAM user rather than importing/rotating
# the existing one (see cluster/apps/household/outline/minio-bucket/main.tf for
# why) - the old postgres-minio credential keeps working, undisturbed, until
# it's deleted by hand once the new one is confirmed backing up successfully.

import {
  to = minio_s3_bucket.postgresql
  id = "postgresql"
}

resource "minio_s3_bucket" "postgresql" {
  bucket = "postgresql"
  acl    = "private"
}

resource "random_password" "postgres_backup_secret_key" {
  length  = 40
  special = false
}

resource "minio_iam_user" "postgres_backup" {
  name          = "postgres-backup"
  secret        = random_password.postgres_backup_secret_key.result
  force_destroy = true
}

resource "minio_iam_policy" "postgres_backup" {
  name = "postgres-backup"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
        Resource = ["arn:aws:s3:::${minio_s3_bucket.postgresql.bucket}/*"]
      },
      {
        Effect   = "Allow"
        Action   = ["s3:ListBucket"]
        Resource = ["arn:aws:s3:::${minio_s3_bucket.postgresql.bucket}"]
      }
    ]
  })
}

resource "minio_iam_user_policy_attachment" "postgres_backup" {
  user_name   = minio_iam_user.postgres_backup.id
  policy_name = minio_iam_policy.postgres_backup.id
}

output "MINIO_ACCESS_KEY" {
  value = minio_iam_user.postgres_backup.name
}

output "MINIO_SECRET_KEY" {
  value     = minio_iam_user.postgres_backup.secret
  sensitive = true
}
