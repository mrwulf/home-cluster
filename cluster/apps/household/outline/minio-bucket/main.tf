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

# See cluster/apps/household/affine/minio-bucket/main.tf for the pattern this
# follows (bucket lives with the app, Kyverno clones the derived secret into
# household, root credentials never leave databases).
#
# The "outline" bucket already exists (hand-created) with real uploaded files
# in it - import it rather than creating fresh so Tofu adopts it in place
# instead of erroring on "already exists" or, worse, trying to recreate it.
#
# The existing hand-created IAM user is NOT imported or reused: MinIO can't
# return an existing user's secret key on read, so importing it would just
# mean Tofu immediately wants to rotate it to match this config anyway - with
# no guarantee that rotation lands in the same window as Outline's own pod
# picking up the new value. Minting a distinctly-named user instead means the
# old credential keeps working, undisturbed, until it's deleted by hand once
# the new one is confirmed working - no cutover race.

import {
  to = minio_s3_bucket.outline
  id = "outline"
}

resource "minio_s3_bucket" "outline" {
  bucket = "outline"
  acl    = "private"
}

resource "random_password" "outline_secret_key" {
  length  = 40
  special = false
}

resource "minio_iam_user" "outline_app" {
  name          = "outline-app"
  secret        = random_password.outline_secret_key.result
  force_destroy = true
}

resource "minio_iam_policy" "outline_app" {
  name = "outline-app"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
        Resource = ["arn:aws:s3:::${minio_s3_bucket.outline.bucket}/*"]
      },
      {
        Effect   = "Allow"
        Action   = ["s3:ListBucket"]
        Resource = ["arn:aws:s3:::${minio_s3_bucket.outline.bucket}"]
      }
    ]
  })
}

resource "minio_iam_user_policy_attachment" "outline_app" {
  user_name   = minio_iam_user.outline_app.id
  policy_name = minio_iam_policy.outline_app.id
}

output "AWS_ACCESS_KEY_ID" {
  value = minio_iam_user.outline_app.name
}

output "AWS_SECRET_ACCESS_KEY" {
  value     = minio_iam_user.outline_app.secret
  sensitive = true
}
