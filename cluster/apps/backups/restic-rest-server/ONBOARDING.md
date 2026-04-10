# Restic REST Server — Client Onboarding

Backups are stored at `backups.<SECRET_DOMAIN>` (direct, Cloudflare-bypassed).
Each device gets its own isolated repository directory and HTTP credentials.
All repos share a single restic encryption password (used by the server-side prune job).

---

## Adding a New Device

### 1. Generate HTTP credentials

On any machine with `htpasswd` (part of `apache2-utils` / `httpd-tools`, or via Homebrew):

```sh
htpasswd -nB <devicename>
# e.g.: htpasswd -nB macbook-pro
```

Copy the output line (e.g. `macbook-pro:$2y$05$...`).

### 2. Add to the cluster secret

Edit `app/secret.sops.yaml` — decrypt first if already encrypted:

```sh
sops --decrypt --in-place app/secret.sops.yaml
```

Add the new htpasswd line under `.htpasswd`, then re-encrypt:

```sh
sops --encrypt --in-place app/secret.sops.yaml
```

Commit and push. Flux will reconcile and reload the secret automatically
(reloader.stakater.com/auto watches the deployment).

### 3. Initialize the restic repository on the client

Install restic: https://restic.net/

```sh
# Set these once — add to your shell profile or backup script
export RESTIC_REPOSITORY="rest:https://<devicename>:<password>@backups.<SECRET_DOMAIN>/<devicename>"
export RESTIC_PASSWORD="<restic-password from secret>"

restic init
```

The `<password>` here is the plaintext HTTP password you entered when running
`htpasswd -nB` (not the hashed output — the original you typed).

### 4. Run a backup

```sh
restic backup /path/to/data /another/path
```

Verify it landed:

```sh
restic snapshots
```

### 5. Schedule backups

**macOS** — create a launchd plist at `~/Library/LaunchAgents/com.restic.backup.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.restic.backup</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/restic</string>
    <string>backup</string>
    <string>/path/to/data</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>RESTIC_REPOSITORY</key>
    <string>rest:https://devicename:password@backups.SECRET_DOMAIN/devicename</string>
    <key>RESTIC_PASSWORD</key>
    <string>restic-password-value</string>
  </dict>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>2</integer>
    <key>Minute</key>
    <integer>0</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>/tmp/restic-backup.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/restic-backup.log</string>
</dict>
</plist>
```

```sh
launchctl load ~/Library/LaunchAgents/com.restic.backup.plist
```

**Windows** — create a scheduled task via PowerShell:

```powershell
$env:RESTIC_REPOSITORY = "rest:https://devicename:password@backups.SECRET_DOMAIN/devicename"
$env:RESTIC_PASSWORD   = "restic-password-value"

$action  = New-ScheduledTaskAction -Execute "restic" -Argument "backup C:\path\to\data"
$trigger = New-ScheduledTaskTrigger -Daily -At 2am
Register-ScheduledTask -TaskName "ResticBackup" -Action $action -Trigger $trigger -RunLevel Highest
```

---

## Retention Policy

The server-side prune CronJob runs every 10 days and applies the same retention
policy as volsync PVC backups:

| Window  | Keep |
|---------|------|
| Hourly  | 24   |
| Daily   | 5    |
| Weekly  | 4    |
| Monthly | 3    |

Clients use `--append-only` via the REST server — they **cannot** delete snapshots
directly. The prune job handles all cleanup by accessing the NFS share directly,
bypassing the append-only restriction.

---

## Restore

```sh
# List snapshots
restic snapshots

# Restore latest to a directory
restic restore latest --target /path/to/restore

# Restore a specific snapshot
restic restore <snapshot-id> --target /path/to/restore

# Mount as a FUSE filesystem (macOS/Linux)
restic mount /mnt/restic-restore
```
