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

- **`task talos:apply-config`/`talos:diff-config` still fail on every node — down to exactly one
  cause, and there's a known real fix, just not applied yet (needs care first).**
  Migrated all patches in `talos/patches/` from legacy v1alpha1 fields to the new Talos v1.14
  multi-document config (discovery, install image/disk-selector, hostDNS, kubelet args/config,
  network CNI, kubePrism, apiserver/OIDC via `KubeAuthenticationConfig`, controller-manager,
  scheduler, proxy, node labels/annotations/taints) — took `talosctl validate --mode metal` from
  13 errors down to 1. The one that's left: `.machine.kubelet.extraMounts` (bind-mounts
  `/var/mnt/extra` for openebs-hostpath) has no equivalent in the new `KubeletConfig` document —
  confirmed at the source level: `pkg/machinery/config/types/k8s/kubelet.go`'s
  `KubeletConfigV1Alpha1.ExtraMounts()` is hardcoded `return nil`, and
  `V1Alpha1ConflictValidate` rejects `.machine.kubelet` if it's non-nil at all — not per-field, so
  even leaving _only_ `extraMounts` behind still conflicts with the document's mere presence.
  Talos validates the whole config bundle atomically, so this single remaining conflict still
  blocks `apply-config`/`diff-config` end-to-end despite the other 12 being fully resolved.
  **Real fix found** (researched other Talos GitOps repos hitting the identical issue):
  `extraMounts` was deliberately removed — [siderolabs/talos#13716](https://github.com/siderolabs/talos/issues/13716)
  ("not needed anymore with user volumes") — and Longhorn/LINSTOR/TopoLVM/generic-hostpath users
  all hit the same wall and moved to `UserVolumeConfig` (`volumeType: directory`), a first-class
  Talos volume that auto-mounts at `/var/mnt/<name>` with zero kubelet involvement, so it never
  touches `.machine.kubelet` at all. For us that's:

  ```yaml
  apiVersion: v1alpha1
  kind: UserVolumeConfig
  name: extra
  volumeType: directory
  ```

  **Not applied yet** — confirmed live that `/var/mnt/extra` already has real data
  (`openebs/` subdirectory, actively used by openebs-hostpath PVs), and switching to a
  Talos-managed `UserVolumeConfig` volume is not guaranteed to preserve what's already on that
  path ([siderolabs/talos#14411](https://github.com/siderolabs/talos/issues/14411) tracks exactly
  this migration-data-loss risk for v1.13→v1.14). Verify what's safe to lose/back up before
  applying this — don't rewrite `install-image.yaml` blind.
  Ruled out along the way: `.machine.install.grubUseUKICmdline` looked like a second unfixable
  gap (no new-document equivalent either), but is provably dead weight here — checked
  `bootedentries` on all 3 nodes and confirmed every one boots via systemd-boot/UKI
  (`Talos-v1.14.1~3.efi`-style entries), not legacy GRUB, so the flag never did anything on this
  hardware. Dropped it; `.machine.install` is now fully migrated (see `UnattendedInstallConfig`
  patches in `talos/patches/common/install-image.yaml` and each `talos/patches/nodes/*.yaml`).
  Found: 2026-09-26, while fixing the vector-aggregator logging endpoint below.

## Needs a real fix (not upstream-blocked, just not done yet)

- **`kube-cleanup-operator` never reaps `Failed` pods owned by a ReplicaSet/Deployment/StatefulSet.**
  Confirmed in its source (`lwolf/kube-cleanup-operator` v1.0.4, `pkg/controller/pod.go`
  `shouldDeletePod()`): the `--delete-failed-after` path only fires for pods with
  `status.reason == "Evicted"` or a single `Job` owner reference. Anything else (e.g. Rook's
  mon/osd/exporter pods failing with `NodeShutdown`) is silently ignored forever, regardless of
  the flag. Will keep recurring on every future node reboot. Needs either a fix/fork upstream, a
  switch to a different cleanup tool, or a small CronJob to reap `Failed` pods this operator misses.
  Found: 2026-09-26, after node3's reboot left 91 pods stuck in `rook-ceph`.

- **No BMC/IPMI check yet for node3's 2026-09-24T19:46:41Z reboot.**
  Confirmed a genuine full reboot via fresh Talos `Member`/`PlatformMetadata` resources, ruled out
  a tuppr-triggered Talos upgrade (last one completed 121 days prior) and a fatal hardware error
  (`CperHardwareErrorFatal` untouched since Feb 25). `talosctl dmesg`'s ring buffer only retains
  ~36-48h and rotates on volume, not on reboot, so the actual boot-time kernel log was already
  gone by the time this was investigated — inconclusive whether it was a clean power-cycle
  (`NodeShutdown` leans this way) or a crash. Kernel-log shipping to Vector/Loki is now fixed and
  fully rolled out across all 3 nodes (2026-09-26), so the _next_ reboot will be diagnosable from
  Loki directly; this one still needs node3's BMC/IPMI SEL log checked directly, if it's still
  retained there.
  Found: 2026-09-26.

## Unreviewed — verify before merging

- **Renovate PR [#5269](https://github.com/mrwulf/home-cluster/pull/5269): `@bitwarden/cli` `2026.8.0` → `2026.9.0`.**
  Open, unmerged. No confirmed public regression found for `2026.9.0` as of 2026-09-26 — flagging
  here because it was called out as a held-back update, but the specific blocking reason isn't
  recorded anywhere in this repo or its PR. Confirm the actual issue before merging or dropping this entry.
