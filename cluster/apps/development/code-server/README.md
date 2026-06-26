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
