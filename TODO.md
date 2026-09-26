# TODO — known-broken / blocked items

Tracks things that are intentionally left broken, pinned, or unmerged because of a known
upstream issue or an open question — not because they were missed. **Check this file before
applying any fix or merging a Renovate PR** in an area listed here; the block may still apply.

Remove an entry once the underlying issue is resolved and the real fix is applied/merged.

## Blocked on upstream

- **Cloudflare Terraform provider pinned at `5.25.0`** (`cluster/apps/networking/ingress-vps/{failover,failover-fast,eu,us}/.terraform.lock.hcl`).
  `5.26.0` regresses `modified_on` planning on `cloudflare_dns_record` updates, causing
  `Provider produced inconsistent result after apply` whenever the record changes out-of-band
  (our `failover`/`failover-fast` Workers write to the same record every minute).
  Renovate is blocked from re-proposing `>= 5.26.0` via `allowedVersions` in `.github/renovate.json5`.
  Upstream: [cloudflare/terraform-provider-cloudflare#7387](https://github.com/cloudflare/terraform-provider-cloudflare/issues/7387) — unpin once fixed.
  Found: 2026-09-26, while investigating intermittent `ingress-vps-failover-tf-runner` failures.

## Needs a real fix (not upstream-blocked, just not done yet)

- **`kube-cleanup-operator` never reaps `Failed` pods owned by a ReplicaSet/Deployment/StatefulSet.**
  Confirmed in its source (`lwolf/kube-cleanup-operator` v1.0.4, `pkg/controller/pod.go`
  `shouldDeletePod()`): the `--delete-failed-after` path only fires for pods with
  `status.reason == "Evicted"` or a single `Job` owner reference. Anything else (e.g. Rook's
  mon/osd/exporter pods failing with `NodeShutdown`) is silently ignored forever, regardless of
  the flag. Will keep recurring on every future node reboot. Needs either a fix/fork upstream, a
  switch to a different cleanup tool, or a small CronJob to reap `Failed` pods this operator misses.
  Found: 2026-09-26, after node3's reboot left 91 pods stuck in `rook-ceph`.

- **No off-box kernel/syslog shipping, so node reboots can't be root-caused after the fact.**
  Investigated node3's 2026-09-24T19:46:41Z reboot (the trigger for the 91 stuck pods above):
  confirmed a genuine full reboot via fresh Talos `Member`/`PlatformMetadata` resources, ruled out
  a tuppr-triggered Talos upgrade (last one completed 121 days prior) and a fatal hardware error
  (`CperHardwareErrorFatal` untouched since Feb 25). `talosctl dmesg`'s ring buffer only retains
  ~36-48h and rotates on volume, not on reboot, so the actual boot-time kernel log was already
  gone by the time this was investigated (2026-09-26) — inconclusive whether it was a clean
  power-cycle (`NodeShutdown` leans this way) or a crash. Ship kernel/syslog to Loki/VictoriaLogs
  so the next one is actually diagnosable, and check node3's BMC/IPMI SEL log for this specific
  event if it's still retained there.

## Needs a real fix — blocks the standard Talos config workflow

- **`task talos:apply-config` (and `talos:diff-config`) fails on every node with a
  document-conflict error**, e.g. `kubelet config is already set in v1alpha1 config
(.machine.kubelet)`, `.machine.cluster.network` / `KubeNetworkConfig` conflict, etc.
  Root cause: `talosctl gen config` on the currently pinned `talosVersion: v1.14.1` now emits
  ~20 standalone documents (`KubeNetworkConfig`, `KubePrismConfig`, `KubeProxyConfig`,
  `KubeletConfig`, `KubeAPIServerConfig`, `KubeControllerManagerConfig`, `KubeSchedulerConfig`,
  `KubeFlannelCNIConfig`, `DiscoveryServiceConfig`, `VolumeConfig`, etc.) by default, alongside
  the legacy v1alpha1 document that still embeds the same settings. `scripts/generate-talos-configs.sh`
  only strips `HostnameConfig` and a couple of specific v1alpha1 fields — a leftover from before
  `gen config`'s default output changed — so the generated bundle now self-conflicts on `apply`.
  Confirmed **not** caused by any specific patch content (a before/after diff of the rendered
  config for an unrelated one-line change showed only that one line differing; the base conflict
  exists either way) — this will fail for literally any future Talos config change until
  `generate-talos-configs.sh` is updated to strip the newly-introduced duplicate documents (or the
  repo migrates its patches to the new document style instead of v1alpha1 fields).
  Found: 2026-09-26, while trying to push the vector-aggregator logging endpoint fix below.

## Unreviewed — verify before merging

- **Renovate PR [#5269](https://github.com/mrwulf/home-cluster/pull/5269): `@bitwarden/cli` `2026.8.0` → `2026.9.0`.**
  Open, unmerged. No confirmed public regression found for `2026.9.0` as of 2026-09-26 — flagging
  here because it was called out as a held-back update, but the specific blocking reason isn't
  recorded anywhere in this repo or its PR. Confirm the actual issue before merging or dropping this entry.

- **No off-box kernel/syslog shipping, so node reboots can't be root-caused after the fact.**
  Investigated node3's 2026-09-24T19:46:41Z reboot (the trigger for the 91 stuck pods above):
  confirmed a genuine full reboot via fresh Talos `Member`/`PlatformMetadata` resources, ruled out
  a tuppr-triggered Talos upgrade (last one completed 121 days prior) and a fatal hardware error
  (`CperHardwareErrorFatal` untouched since Feb 25). `talosctl dmesg`'s ring buffer only retains
  ~36-48h and rotates on volume, not on reboot, so the actual boot-time kernel log was already
  gone by the time this was investigated (2026-09-26) — inconclusive whether it was a clean
  power-cycle (`NodeShutdown` leans this way) or a crash. Ship kernel/syslog to Loki/VictoriaLogs
  so the next one is actually diagnosable, and check node3's BMC/IPMI SEL log for this specific
  event if it's still retained there.
