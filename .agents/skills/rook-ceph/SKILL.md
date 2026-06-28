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
