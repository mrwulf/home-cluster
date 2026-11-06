# TODO — known-broken / blocked items

Tracks things that are intentionally left broken, pinned, or unmerged because of a known
upstream issue or an open question — not because they were missed. **Check this file before
applying any fix or merging a Renovate PR** in an area listed here; the block may still apply.

Remove an entry once the underlying issue is resolved and the real fix is applied/merged.

## Blocked on upstream

- **Cloudflare Terraform provider pinned at `5.25.0`** (`cluster/apps/networking/ingress-vps/{eu,us}/.terraform.lock.hcl`).
  `5.26.0`/`5.27.0` regressed `modified_on` planning on `cloudflare_dns_record` updates, causing
  `Provider produced inconsistent result after apply`. Checked 2026-11-06: upstream issue is
  **closed** — fixed in `5.28.0` (confirmed by a reporter on the thread). `.github/renovate.json5`
  now only excludes the two broken `5.26.x`/`5.27.x` versions, so Renovate can propose `5.28.0`+
  directly. Still pinned at `5.25.0` pending that Renovate PR; when it lands, verify with a
  plan-only run (`approvePlan` manual) and a harmless record update before trusting auto-apply,
  then remove this entry.
  Upstream: [cloudflare/terraform-provider-cloudflare#7387](https://github.com/cloudflare/terraform-provider-cloudflare/issues/7387) (closed 2026-10-14, fixed in [v5.28.0](https://github.com/cloudflare/terraform-provider-cloudflare/releases/tag/v5.28.0)).

## Needs a real fix (not upstream-blocked, just not done yet)

- **Gatus keeps connections open forever, so its external checks stop following DNS.** Gatus v5.37.0
  builds its shared HTTP transport with `MaxIdleConns: 100` and no `IdleConnTimeout`, so every
  connection it opens is reused indefinitely and a hostname is only resolved when a new connection is
  needed. A check therefore keeps talking to whichever address it first got, and its duration is the
  request time on that warm connection, not a fresh one. Seen 2026-10-14: "Fast Ingress via ddup" sat at
  a flat 335 ms (the EU VPS path) and "Cloudflare Tunnel Direct" at 650 ms, while a fresh connection
  from inside the cluster took 55 ms and 45 ms; after restarting the Gatus pod they read 50 to 58 ms and
  42 to 52 ms. "VPS-Primary Ingress via ddup" showed 128 ms (the US VPS) for days and, after the
  restart, 333 ms (the EU VPS), because `ingress-lb` publishes both addresses. Consequence: these checks
  do not verify what ddup currently publishes, so a failover that ddup performs is invisible to Gatus
  until its connection drops. Options: a `Connection: close` header on each affected check (reported to work in the
  upstream Gatus issues TwiN/gatus#1824 and #1539; applied to the external checks in PR #5567 and
  confirmed on the live cluster on 2026-10-14: no connections to the Cloudflare edge or the VPSs stay
  open, `fast-lb` reads 115 to 126 ms and the tunnel 61 to 147 ms on fresh connections, and the
  `ingress-lb` check now alternates between about 280 ms and 690 ms as DNS round-robins the two VPSs), a periodic restart of the Gatus
  pod, or an upstream change to Gatus (a client option for idle timeout or disabling keep-alives).
  Related upstream issues with the same cause: #1824 and #856 (certificate checks showing an old cert).
  Filed upstream to close connections by default, with an explicit option to reuse them: TwiN/gatus#1857.
  Checked 2026-11-06: still open, no maintainer response since 2026-10-16. Latest proposal in the
  thread (from this repo's maintainer) is a bounded per-host connection-reuse count (default 3) instead
  of always closing, with an offer to send a PR — no PR opened yet. The in-repo `Connection: close`
  workaround above is the current fix; this entry stays open only for the upstream default.
  Found: 2026-10-14.
