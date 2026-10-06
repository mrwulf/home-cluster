# TODO — known-broken / blocked items

Tracks things that are intentionally left broken, pinned, or unmerged because of a known
upstream issue or an open question — not because they were missed. **Check this file before
applying any fix or merging a Renovate PR** in an area listed here; the block may still apply.

Remove an entry once the underlying issue is resolved and the real fix is applied/merged.

## Blocked on upstream

- **Cloudflare Terraform provider pinned at `5.25.0`** (`cluster/apps/networking/ingress-vps/{eu,us}/.terraform.lock.hcl`).
  `5.26.0` regresses `modified_on` planning on `cloudflare_dns_record` updates, causing
  `Provider produced inconsistent result after apply` (other projects report it failing _every_
  DNS record apply, not only out-of-band changes). The failover Workers that exposed it first
  (they updated a record every minute) were removed on 2026-10-03, but that doesn't remove the bug:
  any update to `vps_us`/`vps_eu` (a VPS IP change, for example) would hit it, so unpinning is
  **not** safe yet. Checked 2026-10-03: upstream issue is still open, and `5.27.0` (released the same
  day) has no change to the `dns_record` resource that addresses it.
  Renovate is blocked from re-proposing `>= 5.26.0` via `allowedVersions` in `.github/renovate.json5`.
  Upstream: [cloudflare/terraform-provider-cloudflare#7387](https://github.com/cloudflare/terraform-provider-cloudflare/issues/7387) — unpin once it's closed and a release notes the fix, then verify
  with a plan-only run (`approvePlan` manual) and a harmless record update before trusting auto-apply.

- **`task talos:apply-config`/`talos:diff-config` still fail on every node — down to exactly one
  cause, now confirmed permanent short of a full node wipe.**
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

  **Ruled out as unfixable without a full node wipe — closing this as a permanent, intentional
  exception rather than something to revisit.** The `openebs-hostpath` data at `/var/mnt/extra`
  turned out to be a non-issue (every single PVC on that storage class is a `volsync-src-*-cache`
  volume — VolSync's own disposable sync cache, confirmed via `kubectl get pvc -A`, nothing
  precious). The real blocker is disk space: `UserVolumeConfig` doesn't just reserve a directory,
  it **allocates a brand-new GPT partition** on the disk. Checked live on all 3 nodes
  (`talosctl get volumestatus`): `EPHEMERAL` is 248-254 GB on ~250 GB system disks — it grows to
  consume 100% of the disk by default at install time, so there is zero free space left for a new
  partition. Confirmed by Talos maintainers directly that this can't be fixed live: EPHEMERAL
  cannot be shrunk on an already-provisioned node
  ([siderolabs/talos#9373](https://github.com/siderolabs/talos/discussions/9373)), and system
  volumes are always provisioned before user volumes specifically so they win the space race
  ([siderolabs/talos#12713](https://github.com/siderolabs/talos/discussions/12713)) — `maxSize` on
  EPHEMERAL only takes effect at initial provisioning, not on a running node. No home-operations
  repo has done this migration live on an existing cluster; every real example sets EPHEMERAL's
  `maxSize` as part of a fresh install. Revisit only if a full wipe+reinstall of a node is already
  planned for some other reason — do it in that same pass by setting EPHEMERAL's `maxSize` before
  first boot, not as a standalone fix.
  Ruled out along the way: `.machine.install.grubUseUKICmdline` looked like a second unfixable
  gap (no new-document equivalent either), but is provably dead weight here — checked
  `bootedentries` on all 3 nodes and confirmed every one boots via systemd-boot/UKI
  (`Talos-v1.14.1~3.efi`-style entries), not legacy GRUB, so the flag never did anything on this
  hardware. Dropped it; `.machine.install` is now fully migrated (see `UnattendedInstallConfig`
  patches in `talos/patches/common/install-image.yaml` and each `talos/patches/nodes/*.yaml`).
  Found: 2026-09-26, while fixing the vector-aggregator logging endpoint below.

## Needs a real fix (not upstream-blocked, just not done yet)

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

- **Rename and relocate the `cloudflare-ddns` secret.** The dynamic DNS CronJob is gone (replaced by a
  ddup domain), but `cluster/apps/networking/cloudflare-ddns/` still exists only because the OpenTofu
  stacks in `ingress-vps` read the Cloudflare token (`CLOUDFLARE_APIKEY`) from the `cloudflare-ddns`
  secret via `varsFrom`. Rename it to something accurate, update the four `varsFrom` entries in
  `ingress-vps/app/tofu.yaml`, move the ExternalSecret next to them, delete the directory and the
  `cloudflare-ddns` dependency in `cloudflare-tunnel/ks.yaml`. That token (`api-token-external-dns`) is
  also broader than the tofu stacks need.
