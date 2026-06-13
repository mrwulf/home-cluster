# Renovate Self-Hosting & Hetzner Server Type Updates

This document summarizes the proposed configuration to have Renovate watch and
update Hetzner Cloud server types (e.g. `cx23`) in OpenTofu/Terraform configurations.
Because the Hetzner Cloud API requires authentication, implementing this is a
primary driver for migrating Renovate to a self-hosted instance.

---

## 1. Custom Datasource & Manager Configuration

To support Hetzner server type tracking, the Renovate configuration (e.g. `.github/renovate.json5`) needs to define:

1. A **custom JSON datasource** that queries the Hetzner Cloud API and extracts server type names as "versions" using JSONata.
2. A **regex custom manager** to scan `.tf` files for `server_type` definitions prefixed with a renovate comment.

### Configuration Snippet

Add the following to `.github/renovate.json5` (or `.github/renovate/customManagers.json5`):

```json5
{
  customDatasources: {
    "hetzner-server-types": {
      defaultRegistryUrlTemplate: "https://api.hetzner.cloud/v1/server_types",
      format: "json",
      transformTemplates: ['{"releases": $.server_types.{ "version": name }}'],
    },
  },
  customManagers: [
    {
      customType: "regex",
      description: ["Process Hetzner server types in Terraform/OpenTofu files"],
      fileMatch: ["(^|/)cluster/.+\\.tf$"],
      matchStrings: [
        '# renovate: datasource=(?<datasource>\\S+)\\s*\\n\\s*server_type\\s*=\\s*"(?<currentValue>[^"]+)"',
      ],
    },
  ],
}
```

---

## 2. Infrastructure Code Annotation

Once the custom manager is configured, annotate any `hcloud_server` resources in your Terraform files (e.g., `cluster/apps/networking/ingress-tunnel/main.tf`):

```hcl
  # renovate: datasource=custom.hetzner-server-types
  server_type = "cx23"
```

---

## 3. Self-Hosting Authentication Setup (The "Why")

The official Hetzner API (`https://api.hetzner.cloud/v1/server_types`) requires an API token.

When self-hosting Renovate (e.g., as a CronJob or deployment in the Kubernetes cluster), you can securely inject your Hetzner Cloud Token via environment variables without committing secrets to the repo:

### Method A: Global Environment Variable

You can pass the token using the `RENOVATE_HOST_RULES` environment variable in the Renovate deployment:

```bash
export RENOVATE_HOST_RULES='[{"matchHost": "api.hetzner.cloud", "token": "${HCLOUD_TOKEN}"}]'
```

### Method B: Self-Hosted `config.js`

If using a custom JS configuration file for the self-hosted runner, you can reference the environment variable directly:

```javascript
module.exports = {
  hostRules: [
    {
      matchHost: "api.hetzner.cloud",
      token: process.env.HCLOUD_TOKEN,
    },
  ],
}
```
