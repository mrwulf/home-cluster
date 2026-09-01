<!-- markdownlint-disable MD013 -->

# `kitinerary-extractor` MCP Server — Build Spec

**Status**: Done — built, published, and deployed. Image lives at [github.com/mrwulf/kitinerary-mcp](https://github.com/mrwulf/kitinerary-mcp) (option 1 from [§6](#6-image-source-location), `ghcr.io/mrwulf/kitinerary-mcp:v0.1.0`), registered in this repo via PR [#5044](https://github.com/mrwulf/home-cluster/pull/5044) (`cluster/apps/ai/toolhive/servers/mcp-kitinerary.yaml`). Wired into the trip-ingest pipeline per [trip_ingest_kitinerary_integration_spec.md](trip_ingest_kitinerary_integration_spec.md), which is also done and live-verified.
**Owning feature**: Trip Ingest pipeline (TripIt replacement) — see [trip_ingestion_pipeline_tdd_sdd.md](trip_ingestion_pipeline_tdd_sdd.md).
**Repository target**: this repo (`home-cluster`) for the ToolHive registration; the image itself can live in a new small repo or a `docker/` subtree — implementer's call, see [§6](#6-image-source-location).

---

## 0. Why this exists

The trip-ingest n8n workflow (`cluster/apps/household/n8n/app/workflows/trip-ingest.json`) currently extracts booking data from forwarded confirmation emails with an LLM call to in-cluster Ollama. That works, but it's non-deterministic and worse than it needs to be: most real airline/hotel confirmation emails already embed structured `schema.org` `Reservation` JSON-LD markup (the same markup Gmail uses for its own "smart" trip cards), and KDE's `kitinerary-extractor` CLI parses that deterministically — no LLM guesswork, no hallucination risk, and it also reads structured PDF tickets and Apple/Google Wallet `.pkpass` files that our current MIME/regex extraction doesn't touch at all.

We evaluated routing this through Trek's own built-in AI Booking Import feature instead (it already runs `kitinerary-extractor` internally), but its REST API (`/api/trips/:tripId/reservations/import/booking`) requires a real login-session JWT, not the `trek_`-prefixed MCP API token this pipeline already uses — confirmed by a live test (401, traced to a completely separate `mcp_tokens` table that the REST guard never queries). Provisioning a login credential for automation was the alternative; this spec is the one we chose instead: run `kitinerary-extractor` ourselves, as a small MCP server, and keep every write on the MCP token we already have.

No community image or MCP server for this exists (checked Docker Hub, GitHub code search, and the Smithery/mcp.so/awesome-mcp-servers directories on 2026-09-01 — nothing). This is new, from scratch.

## 1. What this component is (and isn't)

**Is**: a thin, stateless MCP server wrapping the `kitinerary-extractor` CLI. One job: take a file, return whatever structured `Reservation` JSON-LD `kitinerary-extractor` can pull out of it (or nothing, if it can't).

**Isn't**:

- Not a booking-type mapper. It must NOT translate the JSON-LD into Trek's `create_reservation`/`create_transport` vocabulary, our own `booking_type` enum, or anything consumer-specific. That mapping stays in the n8n workflow (mirrors how Trek's own `kitinerary-mapper.js` is a separate layer on top of the same CLI). Keeping this tool dumb keeps it reusable and avoids coupling it to one caller's schema.
- Not talking to Trek, n8n, Ollama, or anything else. No outbound network calls at all, no secrets, no credentials. Purely: file bytes in, JSON-LD out.
- Not stateful. No database, no PVC. Each call is an isolated CLI invocation against a temp file, cleaned up immediately after.

## 2. Interface

One MCP tool. Suggested shape (the implementer may refine names/fields, but keep the tool minimal and generic):

```text
extract_booking(file_base64: string, filename: string, context_date?: string) -> {
  items: object[],       // the raw JSON-LD array kitinerary-extractor emitted (possibly empty)
  warnings: string[],    // e.g. "extractor timed out", "unsupported file type"
}
```

- `file_base64` — the file's raw bytes, base64-encoded (MCP tool args are JSON; there's no multipart/binary transport at this layer).
- `filename` — needed so the extractor can infer format from the extension (`.eml`, `.pdf`, `.pkpass`, `.html`, `.txt` — same set Trek's own booking-import accepts, see `ACCEPTED_EXTS` in Trek's `reservation-import.controller.js` for precedent). Reject anything else with a clear warning rather than passing it through.
- `context_date` (optional, ISO date) — maps to `kitinerary-extractor --context-date`, which helps it resolve dates that don't state a year or are relative to "today." Pass the email's own `Date:` header when the caller has it.
- Return the extractor's own JSON-LD verbatim, parsed into an array, not restructured. `kitinerary-extractor -o JsonLd` is the default output format — use it explicitly rather than relying on the CLI default in case that ever changes upstream.
- Empty/no-match input is not an error: return `items: []` with a warning, exit cleanly. Reserve MCP tool errors for genuine failures (extractor binary missing, process crash, file too large).
- Enforce a size cap on `file_base64` (10 MB decoded, matching Trek's own booking-import limit — no reason to diverge) and a process timeout (60s is generous for a single-file CLI extraction; kill and return a warning past that, don't hang the caller).

## 3. Runtime shape

- **Transport**: `stdio`, wrapped by ToolHive with `proxyMode: streamable-http` — this repo's existing pattern for a CLI-backed MCP server. See `cluster/apps/ai/toolhive/servers/mcp-searxng.yaml` for the shape to copy, and `CLAUDE.md`'s "Adding an MCP server (ToolHive)" section for the full checklist (register in `servers/kustomization.yaml`, update the Active MCP Tool Inventory table in `cluster/apps/ai/toolhive/README.md`, no per-server `HTTPRoute`/OIDC/dashboard needed — the operator-level ones already cover it).
- **Server language**: Python, using the official `mcp` SDK (`pip install mcp`) — simplest way to speak MCP over stdio with minimal code; the tool body is just: base64-decode → write to a `tempfile.NamedTemporaryFile` with the right extension → `subprocess.run(["kitinerary-extractor", "-o", "JsonLd", path], timeout=60)` → parse stdout as JSON → clean up the temp file (use a `with`/`finally` so it's removed even on a timeout or crash).
- **State**: none. No volumes needed beyond the container's own `/tmp` for the transient extraction file (default `emptyDir`, not a PVC — matches the repo's stated default for disposable state).
- **Secrets**: none. Don't add a `spec.secrets[]` to the `MCPServer` at all — this tool has nothing to authenticate.
- **Concurrency**: `kitinerary-extractor` is a one-shot CLI process per call; nothing about the server needs to serialize calls, but note in the code that each call spawns its own subprocess (no shared extractor state to worry about).

## 4. Base image and dependency footprint

Verified live inside Trek's own container (which already runs this successfully), so this combination is known-good:

- **OS**: Debian 13 (trixie).
- **Packages**: `libkitinerary-bin` and `libkitinerary-data`, version `24.12.3-1` at time of writing (KDE Gear 24.12 release train — `libkitinerary-bin`'s version tracks KDE's own `kitinerary` release tags 1:1, see `invent.kde.org/pim/kitinerary`).
- **Binary path**: `/usr/local/bin/kitinerary-extractor` in Trek's image (a symlink Trek's own Dockerfile creates — on a plain Debian trixie + apt install, expect it at the standard `/usr/bin/kitinerary-extractor` instead; verify at build time rather than assuming the symlinked path).
- **Real dependency weight — this is not a lightweight single binary.** `apt-get install libkitinerary-bin` pulls in a genuine KDE Frameworks 6 + Qt 6 chain: `libqt6core6t64`, `libqt6gui6`, `libqt6network6`, `libqt6qml6`, `libqt6dbus6`, `libkf6archive6`, `libkf6calendarcore6`, `libkf6codecs6`, `libkf6config*`, `libkf6contacts6`, `libkf6coreaddons6`, `libkf6i18n*`, and their transitive deps. Yes, `libqt6gui6`/`libqt6qml6` show up even though this is a headless CLI tool — don't be surprised by it, and don't spend time trying to find a slimmer package; there isn't one upstream. Budget for a multi-hundred-MB image; a multi-stage build won't shrink the runtime dependency closure, only the build-time layer.
- **License**: LGPL (KDE convention for its libraries) — verify the exact SPDX identifier from `/usr/share/doc/libkitinerary-bin/copyright` at build time before publishing the image, don't assume.
- **Locale note**: `kitinerary-extractor` prints a Qt locale warning to stderr on a non-UTF-8 locale (`Detected locale "C"... Qt has switched to "C.UTF-8"`) — harmless, but set `LANG=C.UTF-8`/`LC_ALL=C.UTF-8` in the image to suppress the noise, and make sure the wrapper only parses stdout, never stderr, as the JSON payload.

Suggested Dockerfile shape (illustrative, not literal):

```dockerfile
FROM debian:trixie-slim AS runtime
ENV LANG=C.UTF-8 LC_ALL=C.UTF-8
RUN apt-get update && apt-get install -y --no-install-recommends \
      libkitinerary-bin=<PIN> libkitinerary-data=<PIN> \
      python3 python3-pip \
    && rm -rf /var/lib/apt/lists/*
RUN useradd --system --no-create-home --uid 10001 mcp
WORKDIR /app
COPY server.py requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
USER 10001
ENTRYPOINT ["python3", "server.py"]
```

## 5. Rootless / hardening requirements

Non-negotiable, matching this cluster's baseline for every other workload:

- Runs as a **non-root, unprivileged UID** (`USER` set in the Dockerfile, not left to the runtime `securityContext` alone — belt and suspenders).
- `MCPServer.podTemplateSpec.spec.securityContext` / container `securityContext`: `runAsNonRoot: true`, `allowPrivilegeEscalation: false`, drop `ALL` capabilities, `readOnlyRootFilesystem: true` where the temp-file write path allows it (point `TMPDIR` at a small `emptyDir` mount if the root fs is read-only — `kitinerary-extractor` and Python's `tempfile` both need somewhere writable for the extraction temp file).
- No network egress needed at all — this tool never makes an outbound call. If this cluster's Kyverno/CNI policy model supports a default-deny egress annotation per workload, apply it; if not, at minimum don't grant anything beyond what's already implied by ToolHive's own operator-level wiring.
- **CPU**: request only, no limit, per this repo's rule 6 (never set CPU limits).
- **Memory**: a call is a single short-lived subprocess parsing one small file — a modest limit (e.g. 256Mi) should be plenty; the implementer should validate against real extraction runs rather than guessing higher.

## 6. Image source location

Two reasonable options — implementer's call, but pick one and document it in the `MCPServer` manifest's comments:

1. A new small standalone repo (e.g. `kitinerary-mcp`), built and published via its own GitHub Actions workflow to `ghcr.io/<owner>/kitinerary-mcp`, tagged with exact version pins.
2. A `docker/kitinerary-mcp/` subtree inside this repo, with a GitHub Actions workflow scoped to that path.

Either way, the published image tag must be pinned exactly in the `OCIRepository`/`MCPServer` manifest here — never `latest` (repo rule 11).

## 7. Renovate maintainability

This is the trickiest part of keeping this component from silently going stale, since it has two independently-versioned things to track that Renovate doesn't handle the same way:

1. **The published `kitinerary-mcp` image tag itself** — this is a normal OCI image reference in a `MCPServer`/`OCIRepository` manifest, so Renovate's existing `flux`/`kubernetes` managers already track it exactly like every other image in this repo. No new config needed for this part.
2. **The `libkitinerary-bin`/`libkitinerary-data` apt package versions pinned inside the Dockerfile** — Renovate has no native Debian-apt datasource. Do NOT leave these unpinned (`apt-get install libkitinerary-bin` with no `=version` silently drifts to whatever trixie has on the day of a build, defeating the whole "track everything" rule). Instead:
   - Pin the exact apt version in the `RUN apt-get install` line.
   - Annotate it for a Renovate `customManagers` regex entry, datasource `github-releases` (or `github-tags`) against `KDE/kitinerary` (mirrored on GitHub from `invent.kde.org/pim/kitinerary`), since the Debian package version tracks the upstream KDE Gear release train closely enough to use as a freshness signal even though the exact version strings won't match 1:1 (Debian appends its own revision suffix, e.g. `24.12.3-1`). Example comment shape, following this repo's existing `customManagers.json5` convention (see `.github/renovate/customManagers.json5` for the regex pattern to extend):

     ```dockerfile
     # renovate: depName=KDE/kitinerary datasource=github-releases
     ARG KITINERARY_VERSION=24.12.3
     RUN apt-get install -y --no-install-recommends libkitinerary-bin=${KITINERARY_VERSION}-1 libkitinerary-data=${KITINERARY_VERSION}-1
     ```

   - A Renovate bump here won't auto-verify the pinned Debian revision suffix (`-1`, `-2`, etc.) still matches what's actually in the `trixie` archive on build day — the image's CI build will simply fail loudly on an apt version that doesn't exist, which is an acceptable (visible, not silent) failure mode. Note this tradeoff in the new repo/subtree's own README rather than trying to fully automate it.
3. **The Python `mcp` SDK version** — pin in `requirements.txt`/`pyproject.toml`; Renovate's `pip`/`poetry` managers already track this natively, no extra config.

After landing, verify the new dependency actually shows up on the **Renovate Dashboard** issue (repo rule 2) — if it doesn't, the customManager regex needs fixing.

## 8. Registering it in this repo

Once the image exists and is published:

1. `cluster/apps/ai/toolhive/servers/mcp-kitinerary.yaml` — `MCPServer` (`toolhive.stacklok.dev/v1beta1`), `groupRef.name: toolhive-servers`, `transport: stdio`, `proxyMode: streamable-http`, no `spec.secrets`, no persistent volume. Copy `mcp-searxng.yaml`'s shape.
2. Register it in `cluster/apps/ai/toolhive/servers/kustomization.yaml`.
3. Update the "Active MCP Tool Inventory" table in `cluster/apps/ai/toolhive/README.md`.
4. `mise x -- task test:all` must pass before commit (repo rule 1).

## 9. Consuming it from trip-ingest (not this agent's job, but context for why the interface matters)

The eventual plan is a new step in `cluster/apps/household/n8n/app/workflows/trip-ingest.json`'s "Trek Preview" node (or a renamed/restructured equivalent): call `extract_booking` first; if `items` is non-empty, map the JSON-LD `Reservation` objects into the same flat `ex` shape (`booking_type`, `confirmation_code`, `provider_name`, `start_datetime`, `end_datetime`, `total_amount`, `currency`, etc.) the pipeline's Ollama-based extraction already produces, and skip the Ollama call entirely; if `items` is empty, fall back to the existing Ollama extraction unchanged. This keeps every write on the already-working MCP-token path (`create_trip`/`create_reservation`/`create_transport`/`create_budget_item`) — no Trek REST/session-JWT dependency anywhere in the pipeline. That mapping code is out of scope for this spec; it's n8n workflow work for whoever picks this back up once the server exists.

## 10. Acceptance test the implementer should run before calling this done

A minimal end-to-end smoke test, independent of Trek or n8n:

1. Build the image locally.
2. Run it, call `extract_booking` with this fixture (a synthetic hotel confirmation with embedded `schema.org` `LodgingReservation` JSON-LD — the same shape used to live-test the trip-ingest pipeline on 2026-09-01):

   ```html
   <html>
     <body>
       <p>Thank you for booking Test Hotel Sandbox.</p>
       <script type="application/ld+json">
         {
           "@context": "http://schema.org",
           "@type": "LodgingReservation",
           "reservationNumber": "TEST-0001",
           "reservationStatus": "http://schema.org/ReservationConfirmed",
           "underName": { "@type": "Person", "name": "Test Traveler" },
           "reservationFor": {
             "@type": "LodgingBusiness",
             "name": "Test Hotel Sandbox",
             "address": {
               "@type": "PostalAddress",
               "addressLocality": "Austin",
               "addressRegion": "TX",
               "addressCountry": "US"
             }
           },
           "checkinTime": "2031-09-10T15:00:00-05:00",
           "checkoutTime": "2031-09-12T11:00:00-05:00",
           "totalPrice": "450.50",
           "priceCurrency": "USD"
         }
       </script>
     </body>
   </html>
   ```

   Expect a non-empty `items` array containing that `LodgingReservation` object back.

3. Call it again with a plain marketing email (no structured markup). Expect `items: []`, no error, a warning noting nothing was found.
4. Call it with a file just over the size cap. Expect a clean rejection, not a hang or crash.
