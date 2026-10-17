# Storage Operations & Emergency Runbook

This document describes the Rook-Ceph disk layout and keeps the procedures used
to get here. For the planned node1/node3 disk swap see
[ceph-node1-osd-swap.md](ceph-node1-osd-swap.md).

## Current layout (verified 2026-10-07)

Every node boots Talos from a small dedicated OS disk. All Ceph OSDs are whole
NVMe drives, separate from the OS disk.

| Node  | OS disk                    | OSDs                                                                     |
| ----- | -------------------------- | ------------------------------------------------------------------------ |
| node1 | Samsung 970 EVO 250GB      | `osd.4` Kingston OM8PGP41024N-A0 1TB, `osd.5` Micron MTFDHBA512TDV 512GB |
| node2 | Samsung MZVLB256HBHQ 256GB | `osd.0` Kingston OM8PGP41024N-A0 1TB, `osd.1` Samsung 980 PRO 1TB        |
| node3 | PNY CS2241 1TB             | `osd.2` T-FORCE TM8FP7001T 1TB, `osd.3` Kingston OM8PGP41024N-A0 1TB     |

The repo already describes the post-swap layout (node1 gets the PNY instead of
the Micron, node3 boots from the Micron). The hardware matches the table above
until the swap runbook has been carried out.

The Talos install disk of each node is pinned by model in
[talos/patches/nodes/](../talos/patches/nodes/). The OSD devices are listed by
`/dev/disk/by-id` in `storage.nodes` of the
[rook-ceph-cluster HelmRelease](../cluster/apps/rook-ceph/rook-ceph/cluster/helm-release.yaml).

## Historical: OS-disk partitions as OSDs

Everything below this heading describes an earlier layout in which `r-rook-vol`
partitions on the Kingston OS disks served as OSDs `0`, `4` and `5`. They were
retired on July 5, 2026, and the OS disks no longer have an `r-rook-vol`
partition, so the re-enable procedure below can no longer be followed as
written. It is kept as a record.

### Talos Disk Layout (Kingston NVMe — OS Disks)

The Kingston OS disks on each node hosted multiple Talos system partitions plus
the two user volumes. The Talos volume provisioner laid them out in this order:

| Partition    | Size        | Description                      |
| ------------ | ----------- | -------------------------------- |
| System parts | <1 GiB      | Talos boot, STATE, etc.          |
| `EPHEMERAL`  | 100–250 GiB | `/var` — kubelet, container data |
| `r-rook-vol` | 600 GiB     | Raw Ceph OSD partition           |

**Important**: The `EPHEMERAL` volume in the Talos machine configuration was
configured with `grow: true` **and** `maxSize: 250GiB`. The `maxSize` was
mandatory — without it, `EPHEMERAL` would greedily consume all remaining disk
space before `r-rook-vol` could be allocated, causing the 600 GiB partition to
never be created.

### Rationale for Disabling OS Disk Partitions

The `r-rook-vol` partitions resided on the same physical disks as the Talos
Linux operating system and the **etcd** control plane data store.

Under sustained writes or Ceph recovery operations, I/O contention on these
Kingston NVMe drives caused write latency spikes. Since etcd is highly
sensitive to disk write latency, this contention led to etcd warning/error logs
and cluster control-plane instability.

To eliminate this contention, the 600G partitions were disabled from Rook-Ceph
usage.

---

## Emergency Recovery: Re-enabling 600G Partitions

If a primary SSD fails or storage capacity becomes critically low, follow these
steps to re-enable the 600G partitions to restore redundancy or expand storage.

### Step 1: Update GitOps Configuration

1. Open [cluster/apps/rook-ceph/rook-ceph/cluster/helm-release.yaml](../cluster/apps/rook-ceph/rook-ceph/cluster/helm-release.yaml) and locate the `storage.nodes` block.
2. Uncomment the line `- name: "/dev/disk/by-partlabel/r-rook-vol"` under all nodes (`node1`, `node2`, `node3`):

   ```yaml
   nodes:
     - name: "node1"
       devices:
         - name: "/dev/disk/by-partlabel/r-rook-vol"
         - name: "/dev/disk/by-id/nvme-Samsung_SSD_970_EVO_Plus_1TB_S6S1NJ0TB02681R"
   ```

3. Open [cluster/apps/rook-ceph/rook-ceph/cluster/kustomization.yaml](../cluster/apps/rook-ceph/rook-ceph/cluster/kustomization.yaml).
4. Uncomment the primary-affinity cronjob resource:

   ```yaml
   resources:
     - ./helm-release.yaml
     - ./route.yaml
     - ./grafana-config-job.yaml
     - ./primary-affinity-cronjob.yaml
   ```

   _Note: This cronjob is required when using these partitions to set their primary affinity to 0 and reweight them to 0.6, ensuring they only act as replica storage and do not handle primary read operations._

### Step 2: Validate and Apply changes

1. Run the local test suite to ensure the configurations are valid:

   ```bash
   mise x -- task test:all
   ```

2. Commit and push the changes:

   ```bash
   git add cluster/apps/rook-ceph/rook-ceph/cluster/
   git commit -m "feat(storage): re-enable 600G OS disk partitions in emergency"
   git push
   ```

3. Wait for Flux to automatically reconcile, or manually force reconciliation:

   ```bash
   flux reconcile kustomization rook-ceph-cluster -n rook-ceph
   ```

### Step 3: Monitor Rook-Ceph Re-provisioning

Once Flux applies the changes, the Rook-Ceph operator will automatically detect
the new devices in the spec, partition them, and spin up new OSD deployments
for the Kingston `r-rook-vol` partitions.

Verify that the OSDs are successfully created and that Ceph begins rebalancing
data:

1. Exec into the tools pod:

   ```bash
   kubectl -n rook-ceph exec -it deploy/rook-ceph-tools -- bash
   ```

2. Run status checks:

   ```bash
   ceph status
   ceph osd tree
   ```

   You should see all 6 OSDs listed as `up` and `in` in the tree.

---

## Decommissioning Log: Kingston NVMe Retirement

The retirement and decommissioning of OSDs `0`, `4`, and `5` (on the Kingston OS
disk partitions) was executed on July 5, 2026. This section logs the active
procedure followed to ensure clean removal from the active cluster topology.

### Decommissioning Steps Followed

1. **GitOps Specification Update**: Commented out the Kingston disk devices
   (`/dev/disk/by-partlabel/r-rook-vol`) in `helm-release.yaml` and retired the
   `ceph-osd-primary-affinity` cronjob in `kustomization.yaml`. Pushed commit
   `3c8a20706` to the GitOps repository.
2. **Reconciliation**: Verified that Flux successfully pulled and applied the
   configuration updates to the `rook-ceph` namespace resources.
3. **Data Migration (Marking Out)**: Marked OSDs `0`, `4`, and `5` as `out`
   inside the `rook-ceph-tools` pod:

   ```bash
   ceph osd out 0 4 5
   ```

4. **Tuning for Backfill Concurrency**: Enabled mClock overrides and increased
   backfill limits to speed up data migration to the Samsung/T-Force SSDs over
   the 10G network:

   ```bash
   ceph config set osd osd_mclock_override_recovery_settings true
   ceph config set osd osd_max_backfills 16
   ceph config set osd osd_recovery_max_active_ssd 32
   ceph tell osd.* injectargs \
     --osd_mclock_override_recovery_settings true \
     --osd_max_backfills 16 \
     --osd_recovery_max_active 16 \
     --osd_recovery_max_active_ssd 32 \
     --osd_recovery_sleep_ssd 0
   ```

5. **Monitoring Migration & Safety Checks**: Monitored rebalancing using
   `ceph status` and verified each OSD was safe to destroy:

   ```bash
   ceph osd safe-to-destroy 0 4 5
   ```

6. **Deployments Stop**: Scaled OSD deployments `rook-ceph-osd-0`,
   `rook-ceph-osd-4`, and `rook-ceph-osd-5` to `0` replicas.
7. **Purging from Topology**: Purged the retired OSDs from Ceph, removing them
   from the CRUSH map:

   ```bash
   ceph osd purge 0 --yes-i-really-mean-it
   ceph osd purge 4 --yes-i-really-mean-it
   ceph osd purge 5 --yes-i-really-mean-it
   ```

8. **Tuning Cleanup**: Reverted all dynamic recovery overrides back to defaults
   (mClock profile `high_recovery_ops`).

### Post-Decommission Verification

- **Ceph Health**: `HEALTH_OK`
- **OSD Count**: `3 osds: 3 up, 3 in` (`osd.1`, `osd.2`, `osd.3`)
- **CRUSH Map**: Verified `ceph osd tree` only lists the primary Samsung and
  T-Force 1TB NVMe drives.
- **Client Traffic Impact**: Resolved etcd latency warnings completely by
  redirecting all write/read traffic to the dedicated SSD storage tier.

### Clearing OSD Signatures After Decommission

Even after purging OSDs from Ceph, the Rook operator's prepare job
(`ceph-volume raw list`) will detect the residual BlueStore superblock
signatures on the Kingston partitions and auto-adopt them, recreating the OSD
deployments. To permanently prevent this, the signatures must be wiped from
each partition.

The cleanest approach uses `talosctl debug` to run a privileged Alpine
container directly on the node with host `/dev` access — no Kubernetes pod
manifest or cleanup required.

> [!NOTE]
> `wipefs` is not included in Alpine's base image. Install it first with
> `apk update && apk add util-linux` inside the debug shell.

First, identify which partition on each node holds the Ceph signature. The
`r-rook-vol` label is the most reliable way to find it:

```bash
# On each node, find the partition device path
talosctl get volumestatus --nodes <node>.home | grep r-rook-vol
# or from a debug shell on the node:
lsblk -o NAME,PARTLABEL | grep r-rook-vol
```

Then for each affected node, open a debug shell and wipe the signature:

```bash
talosctl debug docker.io/library/alpine:latest \
  --nodes <node>.home \
  --namespace system \
  --args /bin/sh
# inside the shell:
apk add util-linux
wipefs -a /dev/<partition>   # e.g. /dev/nvme0n1p6
```

After wiping each node, confirm Rook no longer spawns OSD prepare jobs for
these devices:

```bash
kubectl -n rook-ceph get pods -w | grep osd-prepare
```

No new prepare pods should appear after the next Rook reconciliation cycle.
