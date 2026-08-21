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
   Retrieve all open pull requests using `local-mcp-gateway` via `call_mcp_tool`:
   - **Tool**: `list_pull_requests`
   - **Arguments**: `{ "owner": "mrwulf", "repo": "home-cluster", "state": "open", "per_page": 100 }`
2. **Release Notes Safety Audit & Configuration Alignment**:
   For each retrieved PR, inspect files using `get_pull_request_files` (`{ "owner": "mrwulf", "repo": "home-cluster", "pull_number": <N> }`), read release notes, upstream issue trackers, and diffs to identify:
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
2. **Execution via MCP**:
   Once approved by the user, perform the merges using `local-mcp-gateway` tools:
   - **Merge Approved PRs**: `merge_pull_request` with `{ "owner": "mrwulf", "repo": "home-cluster", "pull_number": <N>, "merge_method": "squash", "commit_title": "<conventional-header>" }`.
   - **Close Superseded/Duplicate PRs**: `update_issue` with `{ "owner": "mrwulf", "repo": "home-cluster", "issue_number": <N>, "state": "closed" }`.
   - If an MCP tool error or SSE stream timeout occurs, advise the user to restart the MCP server connection in the IDE (**... > MCP Servers > Restart**) rather than falling back to CLI scripts.
3. **Local Workspace Sync**:
   After merges complete, fast-forward your local `main` branch:
   ```bash
   git pull origin main
   ```
4. **Post-Merge Live Runtime Verification**:
   In accordance with Rule 12 in `AGENTS.md`, never declare a PR merge task complete without empirically verifying live cluster workload health:
   - Query Kubernetes pods across all modified namespaces via `kubectl_get` (or `local-mcp-gateway`).
   - Confirm that all updated containers transition to a healthy `Running` state without restart loops or `CrashLoopBackOff`.
   - If a container update crashes at runtime (e.g. upstream incompatibilities):
     1. Immediately revert the tag in git to the last known stable release.
     2. Suppress the broken release by adding `ignoreVersions: ["<broken-version>"]` to both `.github/renovate.json5` `packageRules` and the inline `# renovate:` comment in the manifest so Renovate will not immediately regenerate PRs for the broken version.
     3. Validate with `mise x -- task test:all`, commit, push to `main`, and confirm pod recovery.
5. **Walkthrough Optimization**:
   - **DO NOT** generate a summary `walkthrough.md` or output a summary of the merged PRs unless there were errors, regressions, or unexpected issues during execution.
   - If everything succeeded cleanly, provide a brief direct message to the user confirming successful completion.
