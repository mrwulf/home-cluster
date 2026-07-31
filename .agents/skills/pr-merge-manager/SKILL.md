---
name: pr-merge-manager
description: Instructions to safely review, audit, remediate, validate, and squash-merge pull requests in this repository with strict verification, active configuration adjustments, and safety guardrails.
---

# Pull Request Audit & Merge Manager Handbook

This skill details the standardized workflow for auditing, remediating, validating, and merging outstanding pull requests (primarily Renovate dependency updates) in the `mrwulf/home-cluster` GitOps repository.

---

## 1. Retrieval & Audit Workflow

When asked to review outstanding pull requests, follow this workflow:

1. **Comprehensive Retrieval**:
   Retrieve all open pull requests using the `local-mcp-gateway` `list_pull_requests` tool.
   - **Important**: Always set `per_page: 100` (or similar high count) to ensure no older PRs are omitted due to pagination limits.
2. **Release Notes Safety Audit & Configuration Alignment**:
   For each retrieved PR, read the release notes, upstream issue tracker, and diffs to identify:
   - **Breaking Changes**: Any breaking changes in major or minor version bumps (e.g. operators, API deprecations, resource schema changes).
   - **Deprecations & Migrations**: Dependencies requiring custom database migrations, helm values shifts, or feature flag updates.
   - **Configuration Compatibility**: Compare upstream changes/fixes against current repository configurations (e.g., Cilium BPF datapath modes, netkit vs veth, eBPF tproxy, OIDC custom claims).
   - **Upstream Regressions & Fixes**: Check whether bug fixes or regressions affect current workarounds in the repository.
3. **Safety Matrix & Remediation Plan**:
   Compile a clear safety matrix for the user outlining the risk, impact, version changes, and **required configuration fixes**. Every PR must have an actionable plan to achieve a successful merge.

---

## 2. Validation, Active Remediation & Testing Workflow

Before presenting the plan or executing merges:

1. **Local Branch Checkout & Active Remediation**:
   - **Mandate**: All PRs must be brought to a mergeable, successful state. Do not simply warn about potential risks or leave PRs blocked.
   - For any PR requiring configuration updates (e.g. schema changes, deprecated flags, workarounds, or fixing datapath modes), check out the branch or apply changes to the PR ref.
   - Modify the underlying configurations (e.g., HelmRelease values, manifests) so the update is 100% compatible with the cluster.
2. **Execute Validation Suite**:
   Validate configurations by running the test suite:
   ```bash
   mise x -- task test:all
   ```
   - Ensure that all linters (Prettier, OpenTofu validation) and Flux build compatibility checks (`flux check`) pass cleanly.

---

## 3. Merge Protocol (Strict User Approval)

1. **Wait for Approval**:
   - **DO NOT** execute merges or close PRs automatically.
   - Present the audit findings, active remediation changes made, and wait for explicit approval before proceeding.
2. **Execution**:
   Once approved by the user, perform the merges:
   - Use the `local-mcp-gateway` `merge_pull_request` tool (using the `squash` merge method to preserve conventional commit headers without AI trailers).
   - Close any duplicate or superseded PRs using the `update_issue` tool setting `state: "closed"`.
3. **Local Workspace Sync**:
   After merges complete, fast-forward your local `main` branch:
   ```bash
   git pull origin main
   ```
4. **Walkthrough Optimization**:
   - **DO NOT** generate a summary `walkthrough.md` or output a summary of the merged PRs unless there were errors, regressions, or unexpected issues during execution.
   - If everything succeeded cleanly, provide a brief direct message to the user confirming successful completion.
