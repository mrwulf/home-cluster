---
name: rook-ceph
description: Instructions for monitoring, diagnosing, and cleaning up Rook-Ceph storage clusters, OSDs, pools, block storage, and crash dumps in Kubernetes.
---

# Rook-Ceph Operational & Maintenance Handbook

This skill provides standardized operational workflows for inspecting, monitoring, and maintaining Rook-Ceph storage clusters across the Kubernetes environment.

---

## 1. Quick Diagnostics via Toolbox

The `rook-ceph-tools` pod runs continuously in the `rook-ceph` namespace with full administrative CLI privileges.

### Standard Status Checks
When investigating cluster state or responding to alerts, run the following commands via the `rook-ceph-tools` deployment pod:
- **Cluster Health Summary**: `ceph status` or `ceph health detail`
- **OSD Status & Map Tree**: `ceph osd status` and `ceph osd tree`
- **Storage Pool Utilization**: `ceph df` and `ceph df detail`
- **Active Placement Groups**: `ceph pg stat`

### Crash Dump Inspection & Resolution
If Ceph health reports `RECENT_CRASH` warnings:
1. List recent crash dumps: `ceph crash ls`
2. Inspect crash details: `ceph crash info <crash_id>`
3. Archive resolved crashes: `ceph crash archive-all` or `ceph crash archive <crash_id>`

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

## 3. Storage Maintenance & Cleanup Workflows

### VolSync Snapshot & Trash Cleanup
When cleaning up stale backup snapshots or unreferenced persistent volume claims:
1. Identify unattached PVCs across namespaces:
   `kubectl get pvc --all-namespaces | grep -i Bound | grep -v Attached` (or inspect via `mcp-kubernetes`).
2. Verify snapshot replication status before purging orphaned snapshot objects.

---

## 4. Operational Best Practices
- **Never Define CPU Limits**: Ensure all Ceph operator and plugin manifests rely on CPU requests without CPU limits to prevent IO latency spikes under heavy write operations.
- **Hardware Acceleration**: Account for dedicated storage controllers and bluefs expansion settings when analyzing node allocations.
