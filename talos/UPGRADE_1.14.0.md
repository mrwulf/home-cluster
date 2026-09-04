# Talos v1.14.0 upgrade prep

Reference: [Talos v1.14.0 release notes](https://github.com/siderolabs/talos/releases/tag/v1.14.0).

This is a planning doc only — nothing here has been applied to
`talos/patches/**`, `talos/schematic.yaml`, or `talos/talenv.yaml`. The
actual version bump is tracked separately in PR #5081 (currently only
touches `talos/talenv.yaml` and the talos-backup cronjob image).

None of the items below block the mechanical 1.14.0 upgrade — every
v1alpha1 field Talos deprecates in this release stays supported during a
deprecation period, and defaults are preserved for upgraded clusters. This
doc separates what's worth doing anyway from what genuinely doesn't apply
here.

## Confirmed needed / worth doing at the same time as the bump

### Host DNS config must move into `ResolverConfig`

"Host DNS Configuration" (v1.14 release notes): `.machine.features.hostDNS`
is deprecated in favor of a new `hostDNS` field on the `ResolverConfig`
document.

Current state — two separate patches:

- `talos/patches/common/resolver.yaml` (already its own `ResolverConfig`
  document, added ahead of this need):

  ```yaml
  apiVersion: v1alpha1
  kind: ResolverConfig
  nameservers:
    - address: 10.0.0.1
    - address: 10.0.1.1
  searchDomains:
    disableDefault: true
  ```

- `talos/patches/common/host-dns.yaml` (plain v1alpha1 patch, no `kind:`):

  ```yaml
  machine:
    features:
      hostDNS:
        enabled: true
        forwardKubeDNSToHost: false
        resolveMemberNames: true
  ```

Target: fold `hostDNS` into the existing `ResolverConfig` document and
retire `host-dns.yaml`, so there's a single DNS config source instead of
two:

```yaml
apiVersion: v1alpha1
kind: ResolverConfig
nameservers:
  - address: 10.0.0.1
  - address: 10.0.1.1
searchDomains:
  disableDefault: true
hostDNS:
  enabled: true
  forwardKubeDNSToHost: false
  resolveMemberNames: true
```

File: merge into `talos/patches/common/resolver.yaml`, delete
`talos/patches/common/host-dns.yaml`. Not urgent for the upgrade itself
(the old field still works), but do it as part of the same change so
there's one obvious place DNS is configured — don't run both an old-style
patch and a new-style document for the same feature indefinitely.

### Renovate: switch the Talos version anchor off `ghcr.io/siderolabs/installer`

Not from the user's list, but found while cross-referencing: "Default
Installer Image" (v1.14 release notes) says
`ghcr.io/siderolabs/installer` **is no longer published with releases**
starting 1.14.0 — Image Factory is now the only source. This repo already
uses the Image Factory image at runtime
(`factory.talos.dev/metal-installer/${schematicId}:${talosVersion}` in
`talos/patches/common/install-image.yaml`), so nothing breaks
operationally. But both `talos/talenv.yaml`'s `talosVersion` and
`talosupgrade.yaml`'s `spec.talos.version` are tracked by Renovate via:

```yaml
# renovate: depName=ghcr.io/siderolabs/installer datasource=docker
```

If that image really stops getting new tags published after 1.14.0, this
tracking silently goes stale for every 1.14.x patch release — the same
failure mode this PR just fixed for the regex-order bug, but from a
different cause. Recommend switching both anchors to the still-published,
git-tag-backed source already listed in the "Talos" Renovate group
(`.github/renovate/groups.json5`):

```yaml
# renovate: depName=siderolabs/talos datasource=github-releases
```

Low risk, no cluster impact — pure Renovate config. Worth doing now,
independent of the 1.14.0 bump itself (see "prep now" section).

## Recommended / optional feature adoption

Everything in this section is a deprecated-but-supported v1alpha1 field
today. No urgency — safe to land in a follow-up change once the version
bump itself is verified healthy.

### Kernel/sysctl/sysfs/udev split into dedicated documents

"Kernel Multi-document Configuration" / "Udev Rules Multi-document
Configuration": `.machine.sysctls`, `.machine.sysfs`, `.machine.kernel`,
and `.machine.udev.rules` each get a dedicated document kind. New docs
take precedence over the old fields on conflict, so this is a safe,
mechanical 1:1 rename with no behavior change.

| Current file                                     | Current field              | New document kind                                  | New file             |
| ------------------------------------------------ | -------------------------- | -------------------------------------------------- | -------------------- |
| `talos/patches/common/sysctl.yaml`               | `machine.sysctls`          | `SysctlConfig` (`params:`)                         | same file, new shape |
| `talos/patches/common/sysfs.yaml`                | `machine.sysfs`            | `SysfsConfig` (`params:`)                          | same file, new shape |
| `talos/patches/controlplane/kernel-modules.yaml` | `machine.kernel.modules[]` | `KernelModuleConfig` (one doc per module, `name:`) | same file, new shape |
| `talos/patches/common/udev.yaml`                 | `machine.udev.rules[]`     | `UdevRulesConfig` (`rules:`)                       | same file, new shape |

Example — `sysctl.yaml` becomes:

```yaml
apiVersion: v1alpha1
kind: SysctlConfig
params:
  fs.inotify.max_user_watches: "1048576"
  # ...rest of the existing keys, unchanged
```

`kernel-modules.yaml` (only one module today, `nbd`) becomes:

```yaml
apiVersion: v1alpha1
kind: KernelModuleConfig
name: nbd
```

`udev.yaml` becomes:

```yaml
apiVersion: v1alpha1
kind: UdevRulesConfig
rules:
  - SUBSYSTEM=="drm", KERNEL=="renderD*", GROUP="44", MODE="0660"
  - SUBSYSTEM=="net", ACTION=="add", KERNEL=="tap*", ATTR{tx_queue_len}="10000"
  - SUBSYSTEM=="net", ACTION=="add", KERNEL=="tun*", ATTR{tx_queue_len}="10000"
  - SUBSYSTEM=="block", ENV{DEVTYPE}=="disk", ATTR{queue/scheduler}="none"
```

### `SecurityProfileConfig` — `workloadIsolation: true`

"Workload Isolation (sandboxd)": moves CRI containerd + kubelet + all pods
into a dedicated PID/mount namespace anchored by a new `sandboxd` service.
New clusters get `workloadIsolation: true` by default; upgraded clusters
keep the old behavior until this document is added.

```yaml
apiVersion: v1alpha1
kind: SecurityProfileConfig
workloadIsolation: true
```

New file, e.g. `talos/patches/common/security-profile.yaml`.

Caveats before flipping this on:

- Breaks the in-tree kubelet iSCSI volume plugin (kubelet can't reach host
  `iscsid` across the sandbox). Grepped the repo — no in-tree iSCSI usage
  found, so this is clear.
- Rook-Ceph's OSD pods and CSI node plugins do heavy host-level device and
  mount access. They run as privileged pods and Rook manages its own CSI
  drivers rather than relying on the in-tree iSCSI plugin, so this
  _should_ be unaffected — but this is exactly the kind of change worth
  verifying on one node with Ceph health watched closely before rolling
  cluster-wide, rather than trusting the "should."
- Recommend landing this as its own change, after the version bump has
  been running clean for a while — not bundled into the upgrade itself.

### `FilesystemTrimConfig`

"Filesystem Trim": opt-in periodic `fstrim` on eligible mounted
filesystems. New clusters get this with a one-week default interval;
upgraded clusters don't, so trim stays disabled until added.

```yaml
apiVersion: v1alpha1
kind: FilesystemTrimConfig
interval: 168h0m0s
```

New file, e.g. `talos/patches/common/filesystem-trim.yaml`. Note this
trims Talos-managed volumes (e.g. `EPHEMERAL`); Rook-Ceph OSDs on raw
block devices aren't Talos-mounted filesystems and are unaffected either
way — Ceph does its own space reclamation.

### `KubePrismConfig`

"Kubernetes Multi-document Configuration" deprecates
`.machine.features.kubePrism` explicitly in favor of a dedicated document.
Trivial rename, zero behavior change:

Current (`talos/patches/common/kubeprism.yaml`):

```yaml
machine:
  features:
    kubePrism:
      enabled: true
      port: 7445
```

New:

```yaml
apiVersion: v1alpha1
kind: KubePrismConfig
port: 7445
```

(`enabled` isn't a field on the new document — presence of the document
_is_ enabling it; absence disables it.)

### Broader `.cluster.*` multi-document split — not recommended yet

The release notes also split `.cluster.apiServer`, `.cluster.etcd`
encryption, `.cluster.controllerManager`, `.cluster.scheduler`,
`.cluster.proxy`, `.cluster.network`, `.cluster.coreDNS`, `.cluster.name`,
the control plane endpoint, and most of `.machine.kubelet` into a long
list of new `Kube*Config` documents. This repo's
`talos/patches/controlplane/{apiserver,controller-mgr,scheduler,
scheduling,discovery,disable-proxy}.yaml` and
`talos/patches/common/kubelet.yaml` all use the current v1alpha1 shape.

This is a much larger, higher-risk rewrite than the other items above for
no behavior change today, and the v1alpha1 fields aren't going away in
1.14 — just deprecated. Not recommending this migration now; revisit
if/when Talos actually removes the old fields, or if a specific new
`Kube*Config`-only feature is needed.

### `EtcFileConfig` / `CRICustomizationConfig` for existing file patches

Two existing patches use the now-deprecated `.machine.files` mechanism, in
exactly the two forms the release notes call out as reasons to migrate:

- `talos/patches/common/nfs.yaml` writes `/etc/nfsmount.conf` — the exact
  example given for `EtcFileConfig`.
- `talos/patches/common/containerd.yaml` writes
  `/etc/cri/conf.d/20-customization.part` — the exact legacy path called
  out for `CRICustomizationConfig` (reserved name `customization`).

Neither is urgent (`.machine.files` keeps working), and migrating the CRI
customization one gets a real benefit — "CRI Customization Configuration"
notes that a `CRICustomizationConfig` change no longer requires a reboot
to apply, unlike the current file-based approach. Worth doing in a
low-risk follow-up, not bundled with the version bump.

```yaml
apiVersion: v1alpha1
kind: EtcFileConfig
name: nfsmount.conf
mode: 0o644
contents: |
  [ NFSMount_Global_Options ]
  hard=True
  noatime=True
  nodiratime=True
  rsize=131072
  wsize=131072
  nconnect=16
```

```yaml
apiVersion: v1alpha1
kind: CRICustomizationConfig
name: spegel
content: |
  [plugins."io.containerd.cri.v1.images"]
    discard_unpacked_layers = false
```

## Not applicable to this repo

- **`UnattendedInstall`/`UnattendedInstallConfig`** — replaces
  `.machine.install` with a CEL `diskSelector` + controller-driven install
  flow, and is required for the new declarative-RAID boot support. This
  repo doesn't need RAID boot, and the per-node disk selectors today
  (`model: Samsung SSD 970 EVO 250GB`, `model: SAMSUNG MZVLB256HBHQ-000L7`,
  `model: SAMSUNG MZVLV256HCHP-000L2`, plus `type: ssd` for the standby
  replacement pattern) would need translating into CEL disk-match
  expressions (e.g. `disk.model == "..."`). `.machine.install` "remains
  supported for backwards compatibility and is still used for older
  version contracts," so there's no forcing function to migrate. If this
  is ever revisited, validate the exact CEL field names against
  `talosctl get disks -o yaml` on a live node first — don't trust a
  guessed field name against boot-critical config.
- **Etcd monitoring endpoint move (2379 → 2383)** — this is the one item
  from the user's original list that turns out to need _no_ change.
  Release notes: "If `--listen-metrics-urls` was customized, the metrics
  should not move." This repo already sets
  `cluster.etcd.extraArgs.listen-metrics-urls: http://0.0.0.0:2381` in
  `talos/patches/controlplane/etcd.yaml` — a dedicated, non-default
  metrics port. `cluster/apps/monitoring/victoria-metrics/app/
helmrelease.yaml`'s `kubeEtcd` scrape config already points at port
  2381 (`http-metrics`, `scheme: http`), which is unaffected by the
  2379/2383 change since it was never scraping 2379 in the first place.
  Still worth a post-upgrade sanity check (`curl` the metrics port from a
  node), but no config change needed.
- **Flannel `EnableNFTables`** — `talos/patches/common/cni.yaml` sets
  `cluster.network.cni.name: none`; this cluster runs Cilium, not the
  bundled Flannel. N/A.
- **Multipath (`EtcFileConfig` for `/etc/multipath.conf`)** —
  `multipath-tools` isn't in `talos/schematic.yaml`'s extension list. N/A.
- **Dedicated system volumes for `ETCD`/`CRI`/`KUBELET`/`LOG`** — backing
  (directory vs. dedicated partition) is fixed at cluster creation and
  switching an already-provisioned node is rejected. Not adoptable for
  existing nodes regardless of desire.
- **XFS allocation group geometry** — only affects filesystems formatted
  by 1.14+; existing volumes keep their geometry until wiped/recreated.
  No action; applies automatically to any future wipe/reset.
- **TLS 1.3 minimum for etcd/kube-apiserver** — no custom cipher suite
  config exists anywhere in `talos/patches/`, so there's nothing to remove
  and no client compatibility risk found. Informational only.
- **`--mode=reboot` removal from `talosctl apply-config`** — this repo's
  `apply-config`/`upgrade`/`reboot` tasks in `.taskfiles/talos.yml`
  already default to `MODE=no-reboot` and issue a separate `talosctl
reboot --mode=powercycle` when a reboot is actually wanted. Unaffected.
- **ICMP `send_redirects` disabled by default** — new default sysctl,
  doesn't affect normal pod/service traffic, and this cluster's nodes
  aren't acting as L3 gateways. No action; flagging only because it's a
  behavior change worth knowing about if routing ever gets weird.

## Also worth knowing (beyond the user's list)

- **Kubernetes bumped to 1.37.0** in Talos's own bundled tooling/testing
  baseline. This repo's `kubernetesupgrade.yaml` (tuppr) is independently
  pinned at `v1.36.3` — Talos supports a version range, so this isn't
  forced by the Talos bump, but a Kubernetes version bump should be
  planned as its own separate change, not assumed to ride along with
  1.14.0.
- **etcd**: default bundled version moves to 3.7.0+; Talos 1.14 requires
  etcd 3.6.x+ compatibility. This is Talos-managed, no config action.
- **`talosctl apply-config --mode=reboot` deprecation** and **in-tree
  iSCSI volume plugin deprecation** are both covered above since they
  intersect items already being checked.
- Secure Boot images (not used by this repo — schematic doesn't reference
  Secure Boot) drop `lockdown=confidentiality` as an implicit default;
  N/A here since `talos/schematic.yaml` isn't a Secure Boot schematic.

## Cluster prep work that can be done now, under 1.13.x

1. **Switch the Renovate version anchor for Talos** from
   `depName=ghcr.io/siderolabs/installer datasource=docker` to
   `depName=siderolabs/talos datasource=github-releases` in both
   `talos/talenv.yaml` and `talosupgrade.yaml`. This is pure tooling
   config, has zero cluster impact, and de-risks the exact "installer
   image no longer published" change called out above — do this before
   1.14.x patch releases start landing, not after tracking has already
   gone stale.
2. **No iSCSI in-tree volume plugin usage** — already verified via repo
   grep. Nothing to change now, but this clears the way for
   `SecurityProfileConfig`/`workloadIsolation` later without needing a
   storage migration first.
3. **No custom TLS cipher suite config** on etcd or kube-apiserver —
   already verified via repo grep. Nothing to remove before the TLS 1.3
   minimum takes effect.
4. **Sequencing**: land the mechanical version bump (PR #5081) on its own
   and confirm cluster/Ceph health before layering on any of the
   "Recommended" section above (especially `workloadIsolation`). Don't
   bundle the deprecated-field migrations into the same change as the
   version bump — if something regresses, it should be obvious whether it
   was the Talos version or a config-shape change that caused it.
