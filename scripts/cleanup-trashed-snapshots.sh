#!/usr/bin/env bash
# scripts/cleanup-trashed-snapshots.sh
set -euo pipefail

# This script cleans up Ceph CSI snapshot dependency chains.
# It resolves two types of dependencies:
# 1. Orphaned Clones: Deletes 'csi-snap-*' images in Ceph that no longer have a matching VolumeSnapshotContent in Kubernetes.
# 2. Active Clones: Flattens active clone images whose parents are in the trash (smallest to largest) to release trash locks.

POOL="ceph-blockpool"

echo "=== Step 1: Reconciling Kubernetes Snapshots with Ceph Clones ==="

# Get active snapshot handles from Kubernetes
echo "Fetching active VolumeSnapshotContents from Kubernetes..."
ACTIVE_UUIDS=$(kubectl get volumesnapshotcontents -o json | jq -r '
  .items[] | .status.snapshotHandle // empty
' | awk -F'-' '{print $NF}' | tr '\n' ' ')

# Run Ceph-side reconciliation and deletion of orphaned clones
echo "Identifying and cleaning up orphaned csi-snap-* images in Ceph..."
kubectl exec -i -n rook-ceph deploy/rook-ceph-tools -- python3 -c "
import json
import subprocess
import sys

pool = '$POOL'
active_uuids = set('$ACTIVE_UUIDS'.split())

# Fetch active images from Ceph
try:
    output_ls = subprocess.check_output(['rbd', 'ls', '-l', pool, '--format', 'json'])
    images = json.loads(output_ls)
except Exception as e:
    print('Error fetching rbd info:', e)
    sys.exit(1)

# Find csi-snap-* images that do not match active Kubernetes snapshot UUIDs
orphaned = []
for img in images:
    name = img.get('image', '')
    if name.startswith('csi-snap-'):
        uuid = name.replace('csi-snap-', '')
        if uuid not in active_uuids:
            orphaned.append(name)

if not orphaned:
    print(' ✔ No orphaned snapshot clone images found.')
else:
    print(f'Found {len(orphaned)} orphaned snapshot clone images. Purging and deleting...')
    for name in orphaned:
        print(f' - Purging snapshots for {name}...')
        subprocess.run(['rbd', 'snap', 'purge', f'{pool}/{name}'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        print(f' - Deleting clone image {name}...')
        subprocess.run(['rbd', 'rm', '-p', pool, name])
"

echo ""
echo "=== Step 2: Flattening Active Clones to Release Trashed Parents ==="

# Run progressive flatten of active clones whose parents are in the trash
kubectl exec -i -n rook-ceph deploy/rook-ceph-tools -- python3 -c "
import json
import subprocess
import sys

pool = '$POOL'

try:
    output_ls = subprocess.check_output(['rbd', 'ls', '-l', pool, '--format', 'json'])
    images = json.loads(output_ls)

    output_trash = subprocess.check_output(['rbd', 'trash', 'ls', pool, '--format', 'json'])
    trash_items = json.loads(output_trash)
except Exception as e:
    print('Error fetching rbd info:', e)
    sys.exit(1)

trash_map = {t['name']: t['id'] for t in trash_items}
seen = set()
to_flatten = []

for img in images:
    name = img.get('image', '')
    if name in seen:
        continue
    if 'parent' in img and img['parent']['image'].startswith('csi-snap-'):
        parent_name = img['parent']['image']
        if parent_name in trash_map:
            img['trash_parent_id'] = trash_map[parent_name]
            to_flatten.append(img)
            seen.add(name)

to_flatten.sort(key=lambda x: x.get('size', 0))

if not to_flatten:
    print(' ✔ No active clones need flattening.')
else:
    print(f'Found {len(to_flatten)} active clones still needing flattening. Processing smallest to largest:')
    for i, img in enumerate(to_flatten):
        image_name = img['image']
        trash_id = img['trash_parent_id']
        size_gb = img['size'] / (1024**3)
        print(f'[{i+1}/{len(to_flatten)}] Flattening {size_gb:.2f}GB image {image_name}...')
        res = subprocess.run(['rbd', 'flatten', f'{pool}/{image_name}'])
        if res.returncode == 0:
            print(f'   -> Purging associated parent snapshot {trash_id} from trash...')
            subprocess.run(['rbd', 'trash', 'rm', f'{pool}/{trash_id}'])
"

echo ""
echo "=== Step 3: Purging Released Trash ==="
kubectl exec -i -n rook-ceph deploy/rook-ceph-tools -- rbd trash purge -p "$POOL" || true

echo ""
echo "=== Current Trash Status ==="
kubectl exec -i -n rook-ceph deploy/rook-ceph-tools -- rbd trash ls "$POOL"
