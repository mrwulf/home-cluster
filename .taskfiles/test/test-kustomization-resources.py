#!/usr/bin/env python3
"""
Validate that every file listed in a kustomization.yaml `resources:` block exists on disk.
"""
import os
import sys
import yaml

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
CLUSTER_DIR = os.path.join(ROOT, 'cluster')

errors = []
kustomizations_checked = 0
resources_checked = 0

for dirpath, _, files in os.walk(CLUSTER_DIR):
    for fname in files:
        if fname != 'kustomization.yaml':
            continue
        kustom_path = os.path.join(dirpath, fname)
        try:
            with open(kustom_path) as f:
                doc = yaml.safe_load(f)
        except Exception as e:
            errors.append(f"Failed to parse {kustom_path}: {e}")
            continue

        if not isinstance(doc, dict):
            continue
        resources = doc.get('resources', []) or []
        if not resources:
            continue

        kustomizations_checked += 1
        for resource in resources:
            if not isinstance(resource, str):
                continue
            # Skip URLs and remote refs
            if resource.startswith('http://') or resource.startswith('https://') or resource.startswith('github.com'):
                continue
            resources_checked += 1
            abs_path = os.path.normpath(os.path.join(dirpath, resource))
            if not os.path.exists(abs_path):
                errors.append(f"Missing resource '{resource}' referenced in {kustom_path}")

print(f"Checked {kustomizations_checked} kustomization.yaml files, {resources_checked} resource entries")

if errors:
    for e in errors:
        print(e)
    print(f"\nFail: {len(errors)} missing resource(s) found.")
    sys.exit(1)
else:
    print("Pass: All kustomization resources exist.")
    sys.exit(0)
