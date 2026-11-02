"""Count cloud instances per ingress VPS region and push the counts to VictoriaMetrics.

An instance that Tofu no longer tracks (e.g. leaked by a killed tf-runner during a hung
create) keeps running with the same WireGuard identity as the real VPS and silently breaks
the tunnel, so the provider-side count is the only reliable signal.
"""

import base64
import hashlib
import json
import os
import time
import urllib.request

E = os.environ


def req(url, headers=None, method="GET", body=None):
    r = urllib.request.Request(url, headers=headers or {}, method=method, data=body)
    with urllib.request.urlopen(r, timeout=20) as f:
        return f.read().decode()


def ovh_names():
    base = {"ovh-us": "https://api.us.ovhcloud.com/1.0"}.get(
        E["OVH_ENDPOINT"], "https://eu.api.ovh.com/1.0"
    )
    url = f"{base}/cloud/project/{E['OVH_SERVICE_NAME']}/instance"
    ts = req(f"{base}/auth/time").strip()
    raw = "+".join([E["OVH_APPLICATION_SECRET"], E["OVH_CONSUMER_KEY"], "GET", url, "", ts])
    hdr = {
        "X-Ovh-Application": E["OVH_APPLICATION_KEY"],
        "X-Ovh-Consumer": E["OVH_CONSUMER_KEY"],
        "X-Ovh-Timestamp": ts,
        "X-Ovh-Signature": "$1$" + hashlib.sha1(raw.encode()).hexdigest(),
    }
    return [i["name"] for i in json.loads(req(url, hdr))]


def hcloud_names():
    hdr = {"Authorization": "Bearer " + E["HCLOUD_TOKEN"]}
    return [s["name"] for s in json.loads(req("https://api.hetzner.cloud/v1/servers?per_page=50", hdr))["servers"]]


regions = {"us": (ovh_names, "ingress-vps-us"), "eu": (hcloud_names, "ingress-vps-eu")}
lines = []
for region, (fn, prefix) in regions.items():
    count = sum(1 for n in fn() if n.startswith(prefix))
    print(f"{region}: {count} instance(s)")
    lines.append(f'ingress_vps_cloud_instances{{region="{region}"}} {count}')
lines.append(f"ingress_vps_cloud_instances_last_success_timestamp_seconds {int(time.time())}")
req(E["VM_IMPORT_URL"], method="POST", body=("\n".join(lines) + "\n").encode())
