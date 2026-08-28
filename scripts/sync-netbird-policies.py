#!/usr/bin/env python3
"""
sync-netbird-policies.py

Reads NBPolicy Custom Resources directly from Kubernetes API ('kubectl get nbpolicy -A -o json'),
resolves group IDs dynamically from NetBird Management API, and idempotently synchronizes
granular access control policies while removing the default all-to-all policy.
"""

import base64
import json
import os
import ssl
import subprocess
import sys
import time
import urllib.error
import urllib.request


def get_management_url() -> str:
    url = os.getenv("NB_MANAGEMENT_URL")
    if url:
        return url.rstrip("/")
    if os.getenv("SECRET_DOMAIN"):
        return f"https://nb.{os.getenv('SECRET_DOMAIN')}"
    try:
        cmd = "~/.local/bin/mise x -- kubectl get secret netbird-control-plane-secrets -n networking -o jsonpath='{.data.MANAGEMENT_URL}'"
        raw = subprocess.check_output(cmd, shell=True).decode("utf-8").strip()
        if raw:
            return base64.b64decode(raw).decode("utf-8").strip().rstrip("/")
    except Exception:
        pass
    try:
        cmd = "~/.local/bin/mise x -- kubectl get configmap cluster-settings -n flux-system -o jsonpath='{.data.SECRET_DOMAIN}'"
        domain = subprocess.check_output(cmd, shell=True).decode("utf-8").strip()
        if domain:
            return f"https://nb.{domain}"
    except Exception:
        pass
    print("Unable to resolve NetBird management URL. Set NB_MANAGEMENT_URL or SECRET_DOMAIN.", file=sys.stderr)
    sys.exit(1)


def get_api_key() -> str:
    key = os.getenv("NB_API_KEY")
    if key:
        return key.strip()
    for secret_name in ["netbird-control-plane-secrets", "netbird"]:
        try:
            cmd = f"~/.local/bin/mise x -- kubectl get secret {secret_name} -n networking -o jsonpath='{{.data.NB_API_KEY}}'"
            raw = subprocess.check_output(cmd, shell=True).decode("utf-8").strip()
            if raw:
                return base64.b64decode(raw).decode("utf-8").strip()
        except Exception:
            continue
    print("NB_API_KEY not found in environment or secret.", file=sys.stderr)
    sys.exit(1)


ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE


def api_request(url: str, key: str, method: str = "GET", payload: dict = None, retries: int = 6):
    headers = {
        "Authorization": f"Token {key}",
        "Content-Type": "application/json",
    }
    data = json.dumps(payload).encode("utf-8") if payload else None

    for attempt in range(retries):
        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, context=ctx) as resp:
                body = resp.read().decode("utf-8")
                return json.loads(body) if body else {}
        except urllib.error.HTTPError as err:
            if err.code == 429 and attempt < retries - 1:
                wait_time = (attempt + 1) * 10
                print(f"Rate limited (429). Waiting {wait_time}s before retry...", file=sys.stderr)
                time.sleep(wait_time)
                continue
            err_body = err.read().decode("utf-8")
            print(f"HTTP Error {err.code} for {method} {url}: {err_body}", file=sys.stderr)
            raise


def get_group_map(mgmt_url: str, key: str) -> dict:
    groups = api_request(f"{mgmt_url}/api/groups", key)
    group_map = {}
    for g in groups:
        group_map[g["name"]] = g["id"]
        group_map[g["name"].lower()] = g["id"]
    return group_map, groups


def get_k8s_nbpolicies() -> list:
    try:
        cmd = "~/.local/bin/mise x -- kubectl get nbpolicy -A -o json"
        out = subprocess.check_output(cmd, shell=True).decode("utf-8")
        data = json.loads(out)
        return data.get("items", [])
    except Exception as err:
        print(f"Error fetching NBPolicies from Kubernetes API: {err}", file=sys.stderr)
        sys.exit(1)


def main():
    mgmt_url = get_management_url()
    key = get_api_key()

    print(f"Connecting to NetBird Management at {mgmt_url}...")
    print("Fetching NBPolicies from Kubernetes cluster...")
    k8s_policies = get_k8s_nbpolicies()
    if not k8s_policies:
        print("No NBPolicy resources found in Kubernetes cluster.")
        return

    print(f"Found {len(k8s_policies)} NBPolicy CRs in Kubernetes.")

    print("Fetching group mappings from NetBird Management API...")
    group_map, _ = get_group_map(mgmt_url, key)

    existing_policies = api_request(f"{mgmt_url}/api/policies", key)
    existing_by_name = {p["name"]: p for p in existing_policies}

    # 1. Remove or disable default all-to-all policy to enforce Zero-Trust
    for pol in existing_policies:
        if pol.get("name", "").lower() == "default":
            pol_id = pol["id"]
            print(f"Deleting default all-to-all policy '{pol['name']}' ({pol_id}) to enforce Least Privilege...")
            try:
                api_request(f"{mgmt_url}/api/policies/{pol_id}", key, method="DELETE")
                print("Default all-to-all policy successfully deleted.")
            except Exception as err:
                print(f"Failed to delete Default policy: {err}, attempting to disable it...")
                pol["enabled"] = False
                api_request(f"{mgmt_url}/api/policies/{pol_id}", key, method="PUT", payload=pol)

    # 2. Sync declarative policies
    for item in k8s_policies:
        spec = item.get("spec", {})
        policy_name = spec.get("name") or item["metadata"]["name"]

        source_names = spec.get("sourceGroups", [])
        dest_names = spec.get("destinationGroups", [])

        source_ids = []
        for name in source_names:
            if name in group_map:
                source_ids.append(group_map[name])
            elif name.lower() in group_map:
                source_ids.append(group_map[name.lower()])
            else:
                print(f"Warning: Source group '{name}' for policy '{policy_name}' not found in NetBird API.")

        dest_ids = []
        for name in dest_names:
            if name in group_map:
                dest_ids.append(group_map[name])
            elif name.lower() in group_map:
                dest_ids.append(group_map[name.lower()])
            else:
                print(f"Warning: Destination group '{name}' for policy '{policy_name}' not found in NetBird API.")

        protocols = spec.get("protocols", [])
        protocol = protocols[0] if protocols else "all"

        ports = [str(p) for p in spec.get("ports", [])]
        bidirectional = spec.get("bidirectional", True)

        payload = {
            "name": policy_name,
            "description": f"Managed via NBPolicy '{item['metadata']['name']}'",
            "enabled": True,
            "rules": [
                {
                    "name": f"{policy_name} Rule",
                    "enabled": True,
                    "action": "accept",
                    "sources": source_ids,
                    "destinations": dest_ids,
                    "protocol": protocol,
                    "ports": ports,
                    "bidirectional": bidirectional,
                }
            ],
        }

        if policy_name in existing_by_name:
            policy_id = existing_by_name[policy_name]["id"]
            url = f"{mgmt_url}/api/policies/{policy_id}"
            print(f"Updating policy '{policy_name}' ({policy_id})...")
            api_request(url, key, method="PUT", payload=payload)
        else:
            url = f"{mgmt_url}/api/policies"
            print(f"Creating policy '{policy_name}'...")
            api_request(url, key, method="POST", payload=payload)

        time.sleep(0.5)

    print("\nPolicy synchronization complete! All granular policies applied and Zero-Trust enforced.")


if __name__ == "__main__":
    main()
