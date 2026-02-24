#!/usr/bin/env python3
"""
Validate that every OCIRepository/HelmRepository name referenced in a sourceRef/chartRef
is either:
  1. Defined inline (as a separate YAML document) in the same file, OR
  2. Present as a shared definition in cluster/flux/meta/repositories/oci|helm/

Also checks:
  - Shared OCIRepository references via chartRef must include namespace: flux-system
  - Inline OCIRepository references must NOT include namespace:
"""
import os
import re
import sys
import yaml

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

APPS_DIR    = os.path.join(ROOT, 'cluster', 'apps')
OCI_SHARED  = os.path.join(ROOT, 'cluster', 'flux', 'meta', 'repositories', 'oci')
HELM_SHARED = os.path.join(ROOT, 'cluster', 'flux', 'meta', 'repositories', 'helm')

# Shared definitions available
shared_oci  = {f.replace('.yaml','') for f in os.listdir(OCI_SHARED)  if f.endswith('.yaml') and f != 'kustomization.yaml'}
shared_helm = {f.replace('.yaml','') for f in os.listdir(HELM_SHARED) if f.endswith('.yaml') and f != 'kustomization.yaml'} if os.path.isdir(HELM_SHARED) else set()

errors = []
oci_refs_total = 0
helm_refs_total = 0

for root, _, files in os.walk(APPS_DIR):
    if '.backup' in root:
        continue
    for fname in sorted(files):
        if not (fname.endswith('.yaml') or fname.endswith('.yml')):
            continue
        filepath = os.path.join(root, fname)

        try:
            raw = open(filepath).read()
            # Files may contain multiple YAML documents separated by ---
            docs = list(yaml.safe_load_all(raw))
        except Exception as e:
            errors.append(f"Failed to parse {filepath}: {e}")
            continue

        # Collect names of OCIRepository/HelmRepository objects defined inline
        inline_oci_names  = set()
        inline_helm_names = set()
        for doc in docs:
            if not isinstance(doc, dict):
                continue
            kind = doc.get('kind', '')
            name = (doc.get('metadata') or {}).get('name', '')
            if kind == 'OCIRepository' and name:
                inline_oci_names.add(name)
            elif kind == 'HelmRepository' and name:
                inline_helm_names.add(name)

        # Check all HelmRelease chartRef / sourceRef usages
        for doc in docs:
            if not isinstance(doc, dict) or doc.get('kind') != 'HelmRelease':
                continue
            spec = doc.get('spec', {}) or {}

            # chartRef style
            chart_ref = spec.get('chartRef')
            if isinstance(chart_ref, dict) and chart_ref.get('kind') == 'OCIRepository':
                name = chart_ref.get('name', '')
                ns   = chart_ref.get('namespace')
                oci_refs_total += 1
                is_shared = name in shared_oci
                is_inline = name in inline_oci_names
                if not is_shared and not is_inline:
                    errors.append(f"Missing OCIRepository '{name}' in {filepath}")
                elif is_shared and ns != 'flux-system':
                    errors.append(f"Shared OCIRepository '{name}' missing 'namespace: flux-system' in {filepath}")
                elif is_inline and ns is not None:
                    errors.append(f"Inline OCIRepository '{name}' should not have namespace '{ns}' in {filepath}")

            # chart.spec.sourceRef style
            chart = spec.get('chart', {}) or {}
            chart_spec = chart.get('spec', {}) or {}
            source_ref = chart_spec.get('sourceRef', {}) or {}
            if source_ref.get('kind') == 'OCIRepository':
                name = source_ref.get('name', '')
                ns   = source_ref.get('namespace')
                oci_refs_total += 1
                is_shared = name in shared_oci
                is_inline = name in inline_oci_names
                if not is_shared and not is_inline:
                    errors.append(f"Missing OCIRepository '{name}' in {filepath}")
                elif is_shared and ns != 'flux-system':
                    errors.append(f"Shared OCIRepository '{name}' missing 'namespace: flux-system' in {filepath}")
                elif is_inline and ns is not None:
                    errors.append(f"Inline OCIRepository '{name}' should not have namespace '{ns}' in {filepath}")
            elif source_ref.get('kind') == 'HelmRepository':
                name = source_ref.get('name', '')
                helm_refs_total += 1
                if name not in inline_helm_names and name not in shared_helm:
                    errors.append(f"Missing HelmRepository '{name}' in {filepath}")

print(f"Found OCIRepository references: {oci_refs_total}")
print(f"Found HelmRepository references: {helm_refs_total}")

if errors:
    for e in errors:
        print(e)
    print(f"\nFail: {len(errors)} issue(s) found.")
    sys.exit(1)
else:
    print("Pass: All repository definitions found and namespaces correct.")
    sys.exit(0)
