#!/usr/bin/env python3
import os
import re
import hashlib

root_dir = "/home/bwulf/myhome/GitRoot/home-cluster"

def get_staggered_minutes(app_name, doc):
    # Search for VOLSYNC_CAPACITY: e.g. "20Gi", "200Gi", "500Mi"
    cap_match = re.search(r'VOLSYNC_CAPACITY:\s*["\']?([0-9]+)\s*([a-zA-Z]+)["\']?', doc)
    capacity_gi = 0
    if cap_match:
        val = int(cap_match.group(1))
        unit = cap_match.group(2).lower()
        if 'gi' in unit:
            capacity_gi = val
        elif 'mi' in unit:
            capacity_gi = val / 1024

    # Hardcode slots for the three giant volumes >= 100Gi
    if capacity_gi >= 100:
        if "qbittorrent" in app_name:
            return "05", "35"
        elif "jellyfin" in app_name:
            return "25", "55"
        elif "plex" in app_name:
            return "45", "15"
        else:
            return "15", "45"

    # Hash-based for normal volumes
    nfs_int = int(hashlib.sha256(f"{app_name}-nfs".encode("utf-8")).hexdigest(), 16) % 60

    # Reserve giant slots (05, 25, 45 for NFS and 35, 55, 15 for B2)
    giant_slots = {5, 25, 45, 15, 35, 55}
    while nfs_int in giant_slots:
        nfs_int = (nfs_int + 7) % 60

    b2_int = (nfs_int + 25) % 60
    while b2_int in giant_slots or b2_int == nfs_int:
        b2_int = (b2_int + 7) % 60

    return f"{nfs_int:02d}", f"{b2_int:02d}"

def process_file(filepath):
    with open(filepath, "r") as f:
        content = f.read()

    # Split the multi-document YAML
    docs = content.split("\n---")
    modified = False
    new_docs = []

    for doc in docs:
        # Check if this document uses VolSync templates
        if not any(x in doc for x in ["templates/volsync/primary", "templates/volsync/init", "templates/volsync/local-only"]):
            new_docs.append(doc)
            continue

        # Find the metadata name of this Kustomization
        name_match = re.search(r'metadata:\s*\n(?:\s+.*\n)*?\s+name:\s*(?:&\w+\s+)?([a-zA-Z0-9-]+)', doc)
        if not name_match:
            new_docs.append(doc)
            continue

        app_name = name_match.group(1)

        # Calculate deterministic minutes taking capacity into account
        nfs_min, b2_min = get_staggered_minutes(app_name, doc)

        # Clean up any existing generated variables and the original VOLSYNC_START_MINUTE to avoid duplication
        doc = re.sub(r'^\s+VOLSYNC_(?:NFS|B2|MINIO)_START_MINUTE:.*?(?:\n|$)', '', doc, flags=re.MULTILINE)
        doc = re.sub(r'^\s+VOLSYNC_START_MINUTE:.*?(?:\n|$)', '', doc, flags=re.MULTILINE)

        # We will insert the new staggered variables where VOLSYNC_CAPACITY is defined
        # This keeps the placement very consistent
        pattern = r'^(\s+)VOLSYNC_CAPACITY:.*'

        def replace_fn(match):
            original_line = match.group(0)
            indent = match.group(1)
            lines = [
                original_line,
                f'{indent}VOLSYNC_NFS_START_MINUTE: "{nfs_min}"',
                f'{indent}VOLSYNC_B2_START_MINUTE: "{b2_min}"'
            ]
            return "\n".join(lines)

        new_doc, count = re.subn(pattern, replace_fn, doc, flags=re.MULTILINE)
        if count > 0:
            modified = True
            new_docs.append(new_doc)
        else:
            new_docs.append(doc)

    if modified:
        new_content = "\n---".join(new_docs)
        with open(filepath, "w") as f:
            f.write(new_content)
        print(f"Updated {os.path.relpath(filepath, root_dir)}")

def main():
    for dirpath, _, filenames in os.walk(os.path.join(root_dir, "cluster/apps")):
        for filename in filenames:
            if filename == "ks.yaml":
                process_file(os.path.join(dirpath, filename))

if __name__ == "__main__":
    main()
