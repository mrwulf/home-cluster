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
  cause, and it's a confirmed Talos v1.14.1 gap, not something we can fix from this repo.**
  Migrated all patches in `talos/patches/` from legacy v1alpha1 fields to the new Talos v1.14
  multi-document config (discovery, install image/disk-selector, hostDNS, kubelet args/config,
  network CNI, kubePrism, apiserver/OIDC via `KubeAuthenticationConfig`, controller-manager,
  scheduler, proxy, node labels/annotations/taints) — took `talosctl validate --mode metal` from
  13 errors down to 1. The one that's left: `.machine.kubelet.extraMounts` (bind-mounts
  `/var/mnt/extra` for openebs-hostpath) has **no equivalent in the new `KubeletConfig` document** —
  confirmed at the source level: `pkg/machinery/config/types/k8s/kubelet.go`'s
  `KubeletConfigV1Alpha1.ExtraMounts()` is hardcoded `return nil`, and
  `V1Alpha1ConflictValidate` rejects `.machine.kubelet` if it's non-nil at all — not per-field, so
  even leaving _only_ `extraMounts` behind still conflicts with the document's mere presence.
  Talos validates the whole config bundle atomically, so this single remaining conflict still
  blocks `apply-config`/`diff-config` end-to-end despite the other 12 being fully resolved.
  No workaround exists short of dropping the mount (risks breaking openebs-hostpath) or Talos
  shipping a real equivalent. Revisit when a newer Talos version adds one.
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

- **Kernel-log shipping to Vector is fixed at the config level but the rollout is mid-flight.**
  Root cause was the same `vector-aggregator.monitoring.svc.cluster.local` DNS-vs-LAN-resolver
  bug as the service-log fix below, but for kernel logs it's baked into `talos/schematic.yaml`'s
  `extraKernelArgs` (`talos.logging.kernel=...`), so fixing it changes the schematic ID and needs
  an actual `talosctl upgrade --image` + reboot per node, not a config patch. As of 2026-09-26,
  node1 has been upgraded and reports the fixed endpoint on its live `/proc/cmdline`; node2 and
  node3 are still on the old broken one. Confirm all 3 land on the new schematic, then confirm
  `talos_kernel_logs` shows nonzero `vector_component_sent_events_total` in Vector's own metrics
  (service logs already confirmed flowing this way — fully resolved, see the resolver/talenv fix
  in `talos/patches/common/logging.yaml` and `talos/talenv.yaml`).

- **No BMC/IPMI check yet for node3's 2026-09-24T19:46:41Z reboot.**
  Confirmed a genuine full reboot via fresh Talos `Member`/`PlatformMetadata` resources, ruled out
  a tuppr-triggered Talos upgrade (last one completed 121 days prior) and a fatal hardware error
  (`CperHardwareErrorFatal` untouched since Feb 25). `talosctl dmesg`'s ring buffer only retains
  ~36-48h and rotates on volume, not on reboot, so the actual boot-time kernel log was already
  gone by the time this was investigated — inconclusive whether it was a clean power-cycle
  (`NodeShutdown` leans this way) or a crash. Once kernel-log shipping above is fully rolled out,
  the _next_ reboot will be diagnosable from Loki; this one still needs node3's BMC/IPMI SEL log
  checked directly, if it's still retained there.
  Found: 2026-09-26.

## Unreviewed — verify before merging

- **Renovate PR [#5269](https://github.com/mrwulf/home-cluster/pull/5269): `@bitwarden/cli` `2026.8.0` → `2026.9.0`.**
  Open, unmerged. No confirmed public regression found for `2026.9.0` as of 2026-09-26 — flagging
  here because it was called out as a held-back update, but the specific blocking reason isn't
  recorded anywhere in this repo or its PR. Confirm the actual issue before merging or dropping this entry.
