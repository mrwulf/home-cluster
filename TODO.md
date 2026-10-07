# TODO — known-broken / blocked items

Tracks things that are intentionally left broken, pinned, or unmerged because of a known
upstream issue or an open question — not because they were missed. **Check this file before
applying any fix or merging a Renovate PR** in an area listed here; the block may still apply.

Remove an entry once the underlying issue is resolved and the real fix is applied/merged.

## Blocked on upstream

- **Cloudflare Terraform provider pinned at `5.25.0`** (`cluster/apps/networking/ingress-vps/{eu,us}/.terraform.lock.hcl`).
  `5.26.0` regresses `modified_on` planning on `cloudflare_dns_record` updates, causing
  `Provider produced inconsistent result after apply` (other projects report it failing _every_
  DNS record apply, not only out-of-band changes). The failover Workers that exposed it first
  (they updated a record every minute) were removed on 2026-10-03, but that doesn't remove the bug:
  any update to `vps_us`/`vps_eu` (a VPS IP change, for example) would hit it, so unpinning is
  **not** safe yet. Checked 2026-10-03: upstream issue is still open, and `5.27.0` (released the same
  day) has no change to the `dns_record` resource that addresses it.
  Renovate is blocked from re-proposing `>= 5.26.0` via `allowedVersions` in `.github/renovate.json5`.
  Upstream: [cloudflare/terraform-provider-cloudflare#7387](https://github.com/cloudflare/terraform-provider-cloudflare/issues/7387) — unpin once it's closed and a release notes the fix, then verify
  with a plan-only run (`approvePlan` manual) and a harmless record update before trusting auto-apply.

## Needs a real fix (not upstream-blocked, just not done yet)

- **No BMC/IPMI check yet for node3's 2026-09-24T19:46:41Z reboot.**
  Confirmed a genuine full reboot via fresh Talos `Member`/`PlatformMetadata` resources, ruled out
  a tuppr-triggered Talos upgrade (last one completed 121 days prior) and a fatal hardware error
  (`CperHardwareErrorFatal` untouched since Feb 25). `talosctl dmesg`'s ring buffer only retains
  ~36-48h and rotates on volume, not on reboot, so the actual boot-time kernel log was already
  gone by the time this was investigated — inconclusive whether it was a clean power-cycle
  (`NodeShutdown` leans this way) or a crash. Kernel-log shipping to Vector/Loki is now fixed and
  fully rolled out across all 3 nodes (2026-09-26), so the _next_ reboot will be diagnosable from
  Loki directly; this one still needs node3's BMC/IPMI SEL log checked directly, if it's still
  retained there.
  Found: 2026-09-26.

- **Rename and relocate the `cloudflare-ddns` secret.** The dynamic DNS CronJob is gone (replaced by a
  ddup domain), but `cluster/apps/networking/cloudflare-ddns/` still exists only because the OpenTofu
  stacks in `ingress-vps` read the Cloudflare token (`CLOUDFLARE_APIKEY`) from the `cloudflare-ddns`
  secret via `varsFrom`. Rename it to something accurate, update the four `varsFrom` entries in
  `ingress-vps/app/tofu.yaml`, move the ExternalSecret next to them, delete the directory and the
  `cloudflare-ddns` dependency in `cloudflare-tunnel/ks.yaml`. That token (`api-token-external-dns`) is
  also broader than the tofu stacks need.
