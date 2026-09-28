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

# This module lives with the app it belongs to (not centralized under MinIO's
# own directory) so retiring AFFiNE later removes its bucket definition too -
# only the GitRepository/RBAC plumbing in cluster/apps/databases/minio/app/
# stays centralized and shared across every app that adopts this pattern.
# Each app gets its own Terraform root + Terraform CR + own state, mirroring
# cluster/apps/networking/ingress-vps's per-region directories: this matters
# because writeOutputsToSecret produces exactly one Secret per Terraform CR,
# so merging apps into one root would mix every app's credentials together.
#
# The generated secret key never leaves this apply: it's written straight to a
# K8s Secret via the Terraform CR's writeOutputsToSecret, and a Kyverno clone
# policy (cluster/apps/system/kyverno/policies/sync-affine-minio-credentials.yaml)
# copies only that derived, bucket-scoped Secret into household - MinIO's root
# credentials (used by this provider) stay contained to the databases namespace,
# where this Terraform CR itself runs (see ../minio-bucket-ks.yaml).

resource "random_password" "affine_secret_key" {
  length  = 40
  special = false
}

resource "minio_s3_bucket" "affine" {
  bucket = "affine"
  acl    = "private"
}

resource "minio_iam_user" "affine" {
  name          = "affine"
  secret        = random_password.affine_secret_key.result
  force_destroy = true
}

resource "minio_iam_policy" "affine" {
  name = "affine"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
        Resource = ["arn:aws:s3:::${minio_s3_bucket.affine.bucket}/*"]
      },
      {
        Effect   = "Allow"
        Action   = ["s3:ListBucket"]
        Resource = ["arn:aws:s3:::${minio_s3_bucket.affine.bucket}"]
      }
    ]
  })
}

resource "minio_iam_user_policy_attachment" "affine" {
  user_name   = minio_iam_user.affine.id
  policy_name = minio_iam_policy.affine.id
}

output "MINIO_ACCESS_KEY" {
  value = minio_iam_user.affine.name
}

output "MINIO_SECRET_KEY" {
  value     = minio_iam_user.affine.secret
  sensitive = true
}
