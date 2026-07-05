---
name: rook-ceph
description: Instructions for monitoring, diagnosing, and cleaning up Rook-Ceph storage clusters, OSDs, pools, block storage, released PVs, trashed snapshots, and crash dumps in Kubernetes.
---

# Rook-Ceph Operational & Maintenance Handbook

This skill provides standardized operational workflows for inspecting, monitoring, and maintaining Rook-Ceph storage clusters, utilizing repository taskfiles (`.taskfiles/rook.yml`) and maintenance scripts (`scripts/cleanup-trashed-snapshots.sh`).

---

## 1. Quick Diagnostics via Toolbox

The `rook-ceph-tools` pod runs continuously in the `rook-ceph` namespace with full administrative CLI privileges.

### Standard Status Checks

When investigating cluster state or responding to alerts, run the following commands via the `rook-ceph-tools` deployment pod:

- **Cluster Health Summary**: `ceph status` or `ceph health detail` (or run `task rook:ack-warnings` to archive crashes)
- **OSD Status & Map Tree**: `ceph osd status` and `ceph osd tree`
- **Storage Pool Utilization**: `ceph df` and `ceph df detail`
- **Active Placement Groups**: `ceph pg stat`

### Crash Dump Inspection & Resolution

If Ceph health reports `RECENT_CRASH` warnings:

1. List recent crash dumps: `ceph crash ls`
2. Inspect crash details: `ceph crash info <crash_id>`
3. Archive resolved crashes: Run `task rook:ack-warnings` (executes `ceph crash archive-all`).

---

## 2. Telemetry & Metric Monitoring (VictoriaMetrics)

Use `mcp-victoriametrics` (`query_prometheus`) to inspect active storage trends and hardware metrics:

- **Cluster Total Storage Capacity vs Used**:
  `ceph_cluster_total_bytes` vs `ceph_cluster_total_used_bytes`
- **Pool Raw Storage Usage**:
  `sum by (name) (ceph_pool_stored)`
- **OSD Disk Utilization Peaks**:
  `topk(5, ceph_osd_stat_bytes_used / ceph_osd_stat_bytes) * 100`
- **Degraded Placement Group Count**:
  `ceph_pg_degraded + ceph_pg_underspecified`

---

## 3. Storage Maintenance, Volume & Snapshot Cleanup Workflows

### 3.1 Repository Taskfile Utilities (`.taskfiles/rook.yml`)

Use the established `task` shortcuts for common storage maintenance operations:

- **Collect Unused & Dangling RBD Images**:
  `task rook:get-unused-images`
  _Correlates all `csi-vol-` RBD images in `ceph-blockpool` against active Kubernetes PVs and lists orphaned storage images in `image_list.txt`._
- **Clean Up Released PVs**:
  `task rook:clean-up-all-pv` (or single volume: `task rook:clean-up-pv -- <pv_name>`)
  _Checks for active RBD image dependencies/children before safely deleting released PVs and underlying storage images._
- **Clean Up Specific RBD Image**:
  `task rook:clean-up-img -- <img_name>`
- **Debug an Active PVC**:
  `VOLUME=<pvc_name> task rook:debug-pvc`
  _Attaches a debug container with curl, vim, and rsync to inspect files inside an active PVC._
- **Browse Volume Snapshot Contents**:
  `task rook:browse-volume-snapshot -- <pvc_name>`

### 3.2 Automated Trashed Snapshot Dependency Cleanup (`scripts/cleanup-trashed-snapshots.sh`)

When CSI snapshots are deleted, they move to the RBD trash but cannot be purged if Kubernetes previously created live clone volumes from them.

- **Run Script**: `bash scripts/cleanup-trashed-snapshots.sh`
- **What it does**: Deploys an in-memory python script to `deploy/rook-ceph-tools` that identifies live clones dependent on `csi-snap-` in the RBD trash, sorts them ascending by size, progressively flattens them (`rbd flatten`), and purges the associated snapshot (`rbd trash rm`) to reclaim storage space.
- **Monitoring Progress**: In a secondary terminal, watch I/O activity with `kubectl exec -it -n rook-ceph deploy/rook-ceph-tools -- watch ceph status` (observe `client: ... MiB/s wr`).

---

## 4. Operational Best Practices

- **Never Define CPU Limits**: Ensure all Ceph operator and plugin manifests rely on CPU requests without CPU limits to prevent IO latency spikes under heavy write operations.
- **Hardware Acceleration**: Account for dedicated storage controllers and bluefs expansion settings when analyzing node allocations.

---

## 5. OSD Decommissioning & Backfill Tuning Workflow

When removing OSDs (e.g. retiring old OS disk partitions or migrating to larger hardware), follow this workflow to safely evacuate data, optimize backfill speeds on high-bandwidth networks, and purge OSDs.

### 5.1 Safely Evacuating OSDs

1. **GitOps Update**: Update the `CephCluster` or Helm release spec to exclude the target devices first, then apply GitOps changes.
2. **Mark Out**: Mark the target OSDs as `out` inside the toolbox pod to trigger data migration:
   ```bash
   ceph osd out <OSD_ID>
   ```
3. **Safety Verification**: Before stopping or deleting OSD deployments, check if Ceph has finished remapping all placement groups off the OSDs:
   ```bash
   ceph osd safe-to-destroy <OSD_ID>
   ```
   _Do NOT scale down or purge an OSD if this command returns EBUSY (indicating PGs are still mapped). Stopping multiple OSDs prematurely can result in data loss._

### 5.2 Optimizing Backfill & Recovery Speed

If backfill is bottlenecked (e.g. on 10G links with SSDs), mClock defaults might throttle concurrency to a single active PG. Tweak these configs to speed it up:

1. **Enable Overrides**: Tell the mClock scheduler to respect manual parameters:
   ```bash
   ceph config set osd osd_mclock_override_recovery_settings true
   ceph tell osd.* injectargs --osd_mclock_override_recovery_settings true
   ```
2. **Increase Concurrency & Remove Sleep**:
   ```bash
   ceph config set osd osd_max_backfills 16
   ceph config set osd osd_recovery_max_active_ssd 32
   ceph tell osd.* injectargs \
     --osd_max_backfills 16 \
     --osd_recovery_max_active 16 \
     --osd_recovery_max_active_ssd 32 \
     --osd_recovery_sleep_ssd 0
   ```

### 5.3 Purging and Reversion

Once `safe-to-destroy` returns success:

1. **Scale Down**: Scale down the Kubernetes deployments for the retired OSDs to `0` replicas.
2. **Purge OSDs**: Run the purge command in the toolbox pod:
   ```bash
   ceph osd purge <OSD_ID> --yes-i-really-mean-it
   ```
3. **Clean Up Overrides**: Restore the default mClock performance profiles:
   ```bash
   ceph config set osd osd_mclock_override_recovery_settings false
   ceph config rm osd osd_max_backfills
   ceph config rm osd osd_recovery_max_active_ssd
   ceph tell osd.* injectargs \
     --osd_mclock_override_recovery_settings false \
     --osd_max_backfills 1 \
     --osd_recovery_max_active 0 \
     --osd_recovery_max_active_ssd 10
   ```
