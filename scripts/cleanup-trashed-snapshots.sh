#!/usr/bin/env bash
set -e

# This script cleans up orphaned Ceph CSI snapshot dependency chains.
# When CSI snapshots are deleted, they go to the RBD trash but cannot be purged
# if K8s previously created live clone volumes from them.
# This script identifies those live clones, flattens them sequentially (smallest to largest),
# and immediately purges the associated snapshot from the trash to free space.

echo "Deploying script to rook-ceph-tools pod..."

kubectl exec -i -n rook-ceph deploy/rook-ceph-tools -- bash -c "cat << 'EOF' > /tmp/flatten_and_purge.py
import json
import subprocess
import sys

pool = 'ceph-blockpool'

print('Gathering image and trash info...')
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
    name = img['image']
    if name in seen:
        continue

    if 'parent' in img and img['parent']['image'].startswith('csi-snap-'):
        parent_name = img['parent']['image']
        if parent_name in trash_map:
            img['trash_parent_id'] = trash_map[parent_name]
            to_flatten.append(img)
            seen.add(name)

# Sort ascending by size to reclaim space quickly on small clones
to_flatten.sort(key=lambda x: x.get('size', 0))

print(f'\nFound {len(to_flatten)} orphaned clones still to flatten in {pool}. Sorted by size:')
for img in to_flatten:
    print(f\"{img['size'] / (1024**3):.2f} GB - {img['image']}\")

if not to_flatten:
    print('\nNo snapshot-dependent clones found. Trash purge handles the rest.')
    sys.exit(0)

print('\nStarting progressive flatten and purge process...')
for i, img in enumerate(to_flatten):
    image_name = img['image']
    trash_id = img['trash_parent_id']
    size_gb = img['size'] / (1024**3)

    print(f'[{i+1}/{len(to_flatten)}] Flattening {size_gb:.2f}GB image {image_name}...', flush=True)
    res = subprocess.run(['rbd', 'flatten', f'{pool}/{image_name}'])

    if res.returncode == 0:
        print(f'  -> Flatten complete. Purging associated snapshot {trash_id} from trash...', flush=True)
        subprocess.run(['rbd', 'trash', 'rm', f'{pool}/{trash_id}'])
    else:
        print(f'  -> Flatten failed (might be already flattened). Attempting purge anyway...', flush=True)
        subprocess.run(['rbd', 'trash', 'rm', f'{pool}/{trash_id}'])

print('\nAll done! Remaining trash items:')
subprocess.run(['rbd', 'trash', 'ls', pool])
EOF

# Using PYTHONUNBUFFERED so the output actually streams to the terminal instead of hanging!
PYTHONUNBUFFERED=1 python3 /tmp/flatten_and_purge.py
"

# -----------------------------------------------------------------------------
# How to monitor progress:
# 1. The script output will stream to the terminal, and 'rbd flatten' natively prints % progress.
# 2. To watch the cluster's I/O load during this operation, run in a separate terminal:
#    kubectl exec -it -n rook-ceph deploy/rook-ceph-tools -- watch ceph status
#    (Look at the "client: ... MiB/s wr" metric to see the background copy speed)
# -----------------------------------------------------------------------------
