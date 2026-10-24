# code-server with Antigravity AI Extensions

This directory hosts the deployment configuration for the web-based `code-server` instance.
To enable Antigravity AI companion capabilities in this deployment, the custom built-in extensions
from your local laptop must be copied into the pod's persistent storage.

## Extension Synchronization

The Antigravity extensions (`antigravity`, `antigravity-code-executor`, etc.) are packaged with the local Electron application and are not published on the open extensions marketplaces.

To sync the extensions from your local machine (where the IDE is installed at `/opt/antigravity-ide-Linux`) to the active pod in Kubernetes:

```bash
task k:sync-antigravity
```

This task dynamically finds the running `code-server-0` pod, copies the local folders,
and rolls over the StatefulSet. Run this command whenever you update the local Antigravity
IDE application to keep the web-based extensions in sync.

## Agent terminals (Codeman)

A `codeman` sidecar in the same pod runs [Codeman](https://github.com/Ark0N/Codeman), a web UI over
persistent tmux sessions for Claude Code and other agent CLIs, at `https://agents.home.<domain>`.

- **Auth:** the route is LAN-only (`rfc1918-ips`) and behind Pocket ID forward-auth through a
  dedicated `oauth2-proxy-agents` ([auth/oauth2-proxy-agents](../../auth/oauth2-proxy-agents/)).
  Its session lasts 30 days and renews with the refresh token every 45 minutes, unlike the shared
  oauth2-proxy (50 minutes, tied to the Ceph dashboard). Codeman has no login of its own and is started
  with `--allow-unauthenticated-network`, so the route is the only gate. The renewed cookie only reaches the
  browser because the forward-auth middleware lists the session cookie names in `addAuthCookiesToResponse`
  (`middlewares.yaml`); without that the session dies about a minute after the first refresh.
- **Network:** `networkpolicy.yaml` allows ingress from the internal Traefik only. Egress is unrestricted
  on purpose (Kubernetes API, Talos API, ToolHive, model APIs).
- **Permission mode:** set to `auto` in Codeman's Settings, which is stored in `~/.codeman` on the PVC.
  It is not declarative; check it after the first start.
- **Logs:** Codeman runs in the foreground, so `kubectl logs -n development code-server-0 -c codeman` has them.
- **Tools:** `setup-tools.sh` installs mise, Node, Claude Code and Codeman as the `coder` user on the PVC,
  then clones the dotfiles repo and runs its `bin/install-agents.sh`, which links `mise.agents.toml` (tmux, kubectl,
  talosctl, sops, age, jq, ...) into `~/.config/mise/conf.d/`. Versions of those tools are owned by the dotfiles repo. The `codeman`
  container waits (and logs why) until tmux exists, so it stays idle until that clone has happened.
  The clone needs two things kept out of this public repo: on first setup copy an
  SSH key with access to Forgejo into `/home/coder/.ssh` and write the clone URL into
  `/home/coder/.config/dotfiles-repo`. Also put `~/.kube/config`, `~/.talos/config` and the SOPS age key in place,
  then restart the pod.
- **Git identity:** agents commit as their own identity, separate from the principal's, signed with
  `~/.ssh/agents_signing` that the same script generates on first start. Its public key is in
  `/home/coder/setup.log`; register it as a signing key on GitHub once. Pushing uses the separate SSH key you place by hand.
  The same script installs a `commit-msg` hook that strips AI attribution from commit messages
  (`--no-verify` skips it) and a `gh` wrapper that does the same for PR and issue bodies. Details are in the dotfiles README.
- **ToolHive:** register the in-cluster gateway once from a Codeman terminal:
  `claude mcp add --transport http -s user toolhive http://vmcp-toolhive-gateway.ai.svc.cluster.local:4483/mcp`.
  Each MCP session costs the gateway about 60Mi that is never reaped, so avoid leaving many agent sessions open.
- **Service account:** the token is not mounted; the agents use the kubeconfig on the PVC.

## Troubleshooting & Emergency Recovery

In the unlikely event that a corrupted extension prevents `code-server` from launching,
or if you want to cleanly revert to a vanilla `code-server` setup, you can manually
delete the extensions from the pod's persistent volume using `kubectl`:

```bash
# Delete all Antigravity extensions from the persistent volume
kubectl exec -n development statefulset/code-server -- rm -rf \
  /home/coder/.vscode/antigravity \
  /home/coder/.vscode/antigravity-code-executor \
  /home/coder/.vscode/antigravity-dev-containers \
  /home/coder/.vscode/antigravity-remote-openssh \
  /home/coder/.vscode/antigravity-remote-wsl

# Force a rollout restart to reload without them
kubectl rollout restart -n development statefulset/code-server
```

## Web/Remote Compatibility & Proposed APIs

Because the Antigravity extension runs NodeJS code (like the embedded language server binary)
and uses proposed VS Code APIs, we apply two adjustments to allow it to run inside `code-server` (web):

1. **`extensionKind: ["workspace"]`**: The `task k:sync-antigravity` script automatically patches
   the extension's `package.json` inside the pod, instructing VS Code Web to run this extension
   in the remote container's extension host rather than inside the browser sandbox.
2. **Proposed APIs**: We pass `--enable-proposed-api google.antigravity` and
   `--enable-proposed-api google.antigravity-code-executor` to the `code-server` container arguments
   in `helm-release.yaml` to authorize the extensions to use proposed APIs.
