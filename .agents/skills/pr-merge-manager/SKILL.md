---
name: pr-merge-manager
description: Instructions to safely review, audit, validate, and squash-merge pull requests in this repository with strict verification, OIDC compatibility checks, and safety guardrails.
---

# Pull Request Audit & Merge Manager Handbook

This skill details the standardized workflow for auditing, validating, and merging outstanding pull requests (primarily Renovate dependency updates) in the `mrwulf/home-cluster` GitOps repository.

---

## 1. Retrieval & Audit Workflow

When asked to review outstanding pull requests, follow this workflow:

1. **Comprehensive Retrieval**:
   Retrieve all open pull requests using the `local-mcp-gateway` `list_pull_requests` tool.
   * **Important**: Always set `per_page: 100` (or similar high count) to ensure no older PRs are omitted due to pagination limits.
2. **Release Notes Safety Audit**:
   For each retrieved PR, read the release notes and diffs to identify:
   * **Breaking Changes**: Any breaking changes in major or minor version bumps (e.g. operators, API deprecations, resource schema changes).
   * **Deprecations & Migrations**: Dependencies requiring custom database migrations or configuration changes.
   * **OIDC & Custom Claims**: Verify changes to OIDC flows (e.g. Immich role claims, Pocket ID configurations) and ensure any changes align with current custom mappings.
   * **Upstream Regressions**: Look for known issues in the release notes or issue tracker (e.g., deadlocks in Gluetun, memory leaks, or CVE patches).
3. **Safety Matrix & Report**:
   Compile a clear safety matrix for the user outlining the risk, impact, and version changes. Inform the user of any potentially unsafe actions (e.g., major version CRD upgrades, breaking changes, or manual migration steps).

---

## 2. Validation & Testing Workflow

Before presenting the plan or executing merges:

1. **Local Branch Checkout**:
   For any high-risk updates (e.g. major Prometheus Operator CRD bumps, Traefik ingress changes, etc.), check out the branch locally.
2. **Execute Validation Suite**:
   Validate configurations by running the test suite:
   ```bash
   mise x -- task test:all
   ```
   * Ensure that all linters (Prettier, OpenTofu validation) and Flux build compatibility checks (`flux check`) pass cleanly.

---

## 3. Merge Protocol (Strict User Approval)

1. **Wait for Approval**:
   * **DO NOT** execute merges or close PRs automatically.
   * Present the audit findings to the user and wait for explicit approval before proceeding.
2. **Execution**:
   Once approved by the user, perform the merges:
   * Use the `local-mcp-gateway` `merge_pull_request` tool (using the `squash` merge method to preserve conventional commit headers without AI trailers).
   * Close any duplicate or superseded PRs using the `update_issue` tool setting `state: "closed"`.
3. **Local Workspace Sync**:
   After merges complete, fast-forward your local `main` branch:
   ```bash
   git pull origin main
   ```
4. **Walkthrough Optimization**:
   * **DO NOT** generate a summary `walkthrough.md` or output a summary of the merged PRs unless there were errors, regressions, or unexpected issues during execution.
   * If everything succeeded cleanly, provide a brief direct message to the user confirming successful completion.
