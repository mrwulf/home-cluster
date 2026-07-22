#!/usr/bin/env python3
"""
sync-netbird-policies.py

Reads NBPolicy Custom Resources directly from Kubernetes API ('kubectl get nbpolicy -n networking -o json'),
resolves group IDs dynamically from NetBird Cloud API, and idempotently synchronizes access control policies.
Includes rate limit handling with backoff.
"""

import json
import os
import sys
import time
import subprocess
import urllib.request
import urllib.error


def get_api_key() -> str:
    key = os.getenv("NB_API_KEY")
    if key:
        return key.strip()
    try:
        cmd = "kubectl get secret netbird -n networking -o jsonpath='{.data.NB_API_KEY}' | base64 -d"
        out = subprocess.check_output(cmd, shell=True).decode("utf-8").strip()
        if out:
            return out
    except Exception as err:
        print(f"Error fetching NB_API_KEY from secret: {err}", file=sys.stderr)
    print("NB_API_KEY not found in environment or secret.", file=sys.stderr)
    sys.exit(1)


def api_request(url: str, key: str, method: str = "GET", payload: dict = None, retries: int = 6):
    headers = {
        "Authorization": f"Token {key}",
        "Content-Type": "application/json",
    }
    data = json.dumps(payload).encode("utf-8") if payload else None

    for attempt in range(retries):
        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req) as resp:
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


def get_group_map(key: str) -> dict:
    groups = api_request("https://api.netbird.io/api/groups", key)
    group_map = {}
    for g in groups:
        group_map[g["name"]] = g["id"]
    return group_map


def get_k8s_nbpolicies() -> list:
    try:
        cmd = "kubectl get nbpolicy -n networking -o json"
        out = subprocess.check_output(cmd, shell=True).decode("utf-8")
        data = json.loads(out)
        return data.get("items", [])
    except Exception as err:
        print(f"Error fetching NBPolicies from Kubernetes API: {err}", file=sys.stderr)
        sys.exit(1)


def main():
    key = get_api_key()

    print("Fetching NBPolicies from Kubernetes cluster...")
    k8s_policies = get_k8s_nbpolicies()
    if not k8s_policies:
        print("No NBPolicy resources found in namespace 'networking'.")
        return

    print(f"Found {len(k8s_policies)} NBPolicy CRs in Kubernetes.")

    print("Fetching group mappings from NetBird Cloud API...")
    group_map = get_group_map(key)
    time.sleep(1)

    existing_policies = api_request("https://api.netbird.io/api/policies", key)
    existing_by_name = {p["name"]: p for p in existing_policies}
    time.sleep(1)

    for item in k8s_policies:
        spec = item.get("spec", {})
        policy_name = spec.get("name") or item["metadata"]["name"]

        source_names = spec.get("sourceGroups", [])
        dest_names = spec.get("destinationGroups", [])

        source_ids = []
        for name in source_names:
            if name in group_map:
                source_ids.append(group_map[name])
            else:
                print(f"Warning: Source group '{name}' for policy '{policy_name}' not found in NetBird Cloud API.")

        dest_ids = []
        for name in dest_names:
            if name in group_map:
                dest_ids.append(group_map[name])
            else:
                print(f"Warning: Destination group '{name}' for policy '{policy_name}' not found in NetBird Cloud API.")

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
            url = f"https://api.netbird.io/api/policies/{policy_id}"
            print(f"Updating policy '{policy_name}' ({policy_id})...")
            api_request(url, key, method="PUT", payload=payload)
        else:
            url = "https://api.netbird.io/api/policies"
            print(f"Creating policy '{policy_name}'...")
            api_request(url, key, method="POST", payload=payload)

        time.sleep(1)

    print("Policy synchronization complete.")


if __name__ == "__main__":
    main()
