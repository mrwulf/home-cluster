# Ceph node1 OSD swap and node3 OS-disk swap

Replace node1's Micron 512 GB OSD (`osd.5`) with the PNY CS2241 1 TB that is
currently node3's OS disk, and use the Micron as node3's OS disk.

**Status:** planned. `storage.nodes` in
[helm-release.yaml](../cluster/apps/rook-ceph/rook-ceph/cluster/helm-release.yaml)
and [node3.home.yaml](../talos/patches/nodes/node3.home.yaml) already describe
the target. The hardware does not until the phases below are done.

## Why

Measured on 2026-10-07 unless marked inferred.

- **Capacity cliff.** node1 holds 548 GiB of pool data but `osd.5` is 477 GiB.
  If `osd.4` (Kingston, 954 GiB) failed, its data could not be re-homed on the
  same host and the pool would run on two copies until the drive is replaced
  (inferred from capacity math). node2 and node3 have two ~1 TB OSDs each and
  do not have this problem.
- **Wear.** `osd.4` is at 65% of rated endurance, about 5 months from 100% at
  the pre-rebalance write share (SMART trend, linear extrapolation). CRUSH
  splits a host's writes in proportion to OSD size, so two ~1 TB OSDs take
  50/50 of node1's writes, against 67/33 with a 512 GB sibling.
- **OS disk.** The Micron is 5% worn with the lowest OSD commit latency in the
  cluster (1.5-2.3 ms), and 512 GB is twice node1's and node2's OS disks.

## Decision gate: the PNY CS2241 as an OSD

Verified from node3's kernel log and sysfs:

- DRAM-less: `nvme: allocated 64 MiB host memory buffer`.
- Phison controller (PCI vendor `0x1987`), firmware `CS224N00`.
- Same class as the three Kingston OM8PGP41024N-A0 OSDs, which also use a host
  memory buffer.

Not verified: PNY's own pages do not list a 1 TB endurance figure and retail
listings disagree (250 TBW and 320 TBW). The Kingston is believed to be rated
about 600 TBW (check before relying on it).

Expectation (inferred): at roughly half of node1's writes (about 220 GB/day,
80 TB/year) the PNY reaches 100% of rated endurance in about 9 to 22 months,
depending on whether its wear per TB matches the Kingstons or scales with its
lower rating. Treat it as a stopgap and budget a power-loss-protected NVMe.

**Plan B.** If one drive can be bought now, buy a power-loss-protected NVMe for
node1 and skip Phase 3. node3 keeps the PNY as its OS disk and is never rebuilt.
Phases 1, 2 and 4 are otherwise identical with the new drive in place of the
PNY.

## Preconditions

All must hold before each phase. `ceph` below means
`kubectl -n rook-ceph exec -i deploy/rook-ceph-tools -- ceph`.

- `ceph status` is `HEALTH_OK` with all PGs `active+clean` and no recovery.
- `ceph osd df` shows `REWEIGHT 1.00000` on every OSD.
- `talosctl -n 10.0.1.51 etcd members` lists three members and all nodes are
  `Ready`.
- This change is merged and Flux has applied it. Merging early is safe: Rook
  does not remove an OSD because its device left the spec, the PNY by-id does
  not exist on node1 yet so it is skipped, and Flux does not apply Talos
  config. Do not run `task talos:apply-config` against node3 before Phase 3.
- Only one node is down at any time. etcd and the three mons need two of three.

## Phase 1: drain `osd.5` (no downtime)

Confirm `osd.4` can hold all of node1's data. It must stay well under the 85%
nearfull ratio (about 57% expected).

```bash
ceph osd df tree
ceph osd out 5
ceph -w   # until every PG is active+clean again; ~180 GiB moves to osd.4
ceph osd safe-to-destroy 5
kubectl -n rook-ceph scale deploy rook-ceph-osd-5 --replicas=0
ceph osd purge 5 --yes-i-really-mean-it
kubectl -n rook-ceph delete deploy rook-ceph-osd-5   # if it still exists
```

Rook auto-adopts residual BlueStore signatures (see the decommission log in
[storage.md](storage.md)), so wipe the Micron before anything can re-adopt it.
Confirm the device by serial first. The wrong disk here is data loss.

```bash
talosctl -n 10.0.1.51 get disks -o json \
  | jq -r 'select(.spec.serial=="21222F83A25B") | .metadata.id'
talosctl -n 10.0.1.51 wipe disk <device-from-above>
```

## Phase 2: node1, pull the Micron (about 15 minutes down)

```bash
ceph osd set noout
kubectl drain node1 --ignore-daemonsets --delete-emptydir-data
talosctl -n 10.0.1.51 shutdown
# remove the Micron (serial ends 83A25B), leave its slot empty, power on
kubectl uncordon node1
ceph -w                  # osd.4 up, PGs clean again
ceph osd unset noout
```

While node1 is down every PG runs on two copies and stays active (`min_size 2`).

## Phase 3: node3, swap the OS disk (skip with Plan B)

```bash
task talos:generate-configs      # renders node3 with the Micron selector
ceph osd set noout
talosctl -n 10.0.1.53 reset --graceful --reboot=false --wipe-mode system-disk
```

`--graceful` drains the node and leaves etcd. Never use `--wipe-mode all` or
`user-disks`: the T-Force and Kingston OSD disks on node3 are user disks.

1. Remove the PNY (keep it for Phase 4) and install the Micron.
2. Boot the Talos installer for the current schematic (`task talos:schematic`
   gives the ID; a factory USB is the safe choice, since the PXE files were
   removed from the repo).
3. Apply the config. `task talos:apply-config` does not pass `--insecure`, so
   use talosctl directly for the first apply:

   ```bash
   talosctl apply-config --insecure -n 10.0.1.53 \
     -f talos/clusterconfig/<cluster>-node3.home.yaml
   ```

4. Verify:

   ```bash
   talosctl -n 10.0.1.51 etcd members   # three members, new ID for node3
   kubectl get nodes                    # node3 Ready
   ceph status                          # HEALTH_OK, mon-h back, osd.2/3 up
   ceph osd unset noout
   ```

Expected side effects (not yet tested here, watch for them):

- **mon-h** keeps its store under `/var`, which was wiped. It cannot rejoin as
  is. Quorum stays 2 of 3 while Rook fails it over (default about 10 minutes),
  or follow the Rook mon failover guide.
- **osd.2 and osd.3** should re-activate from their on-disk labels.
- **59 `openebs-hostpath` PVs on node3** are all VolSync source caches. They
  come back empty, so the first backups from node3 run cold and slow. No data
  is lost.

## Phase 4: node1, install the PNY (about 20 minutes down)

```bash
ceph osd set noout
kubectl drain node1 --ignore-daemonsets --delete-emptydir-data
talosctl -n 10.0.1.51 shutdown
# install the PNY, power on
kubectl uncordon node1
talosctl -n 10.0.1.51 get disks -o json \
  | jq -r 'select(.spec.serial=="PNY25412510070100159") | .metadata.id'
talosctl -n 10.0.1.51 wipe disk <device-from-above>   # drop the old Talos partitions
ceph osd unset noout
kubectl -n rook-ceph rollout restart deploy/rook-ceph-operator
```

Rook will not use a disk that still has partitions, hence the wipe. The
operator restart triggers the OSD prepare job for the PNY by-id in
`storage.nodes`. Expect a new OSD, then about 270 GiB of backfill (about 45
minutes at the recovery rate seen on 2026-10-07).

Verify:

```bash
ceph osd df tree      # node1: both OSDs ~29% used
ceph osd perf         # new OSD in line with the others
ceph device ls        # record the PNY's WEAR as the baseline
```

## Rollback

- Before Phase 3 has run `reset`: put the Micron back in node1, wipe it, revert
  the `storage.nodes` change and Rook creates a fresh OSD on it.
- After Phase 3: node3 runs on the Micron. Reinstalling the PNY elsewhere is
  just a Talos install; nothing on it is needed.

## Follow-ups

- Retire `osd.4` (Kingston, 65% worn) when the next drive arrives.
- Alert on OSD drive wear so the next 65% is noticed early.
- Codify or remove the imperative Ceph overrides found on 2026-10-07
  (`osd_max_backfills`, `osd_recovery_max_active_ssd`, the mClock override and
  snap-trim concurrency).
