<!-- markdownlint-disable MD013 -->

# TripIt Replacement — Trip Ingestion Pipeline

**What this is**: a self-hosted replacement for TripIt-style trip aggregators. Forward any booking confirmation email to a dedicated address; it gets parsed, matched or created as a trip, and written into [Trek](https://github.com/Kurea/trek) (a self-hosted travel-planning app) — no third party ever sees your itinerary.

**Status**: live and in daily use. See the [features checklist](#features-checklist) for what's built vs. not.

**Audience for this doc**: someone implementing this pattern in their own cluster, or extending this one. It's a from-scratch architecture reference, not a build log — for the detailed decision-by-decision history (what was tried, what broke, exact live-test evidence), see git history on the docs this one replaces: `trip_ingestion_pipeline_tdd_sdd.md`, `kitinerary_mcp_server_spec.md`, `trip_ingest_kitinerary_integration_spec.md`.

---

## Why this exists

Commercial trip aggregators are convenient but come with real costs: your travel dates, confirmation numbers, traveler names, and payment details flow through a third party's ad-supported business model; core features sit behind a subscription; and there's no way to own or self-host your own data. This pipeline gets the same convenience — forward a confirmation email, watch a trip build itself — without any of that.

## Architecture

```mermaid
graph TD
    Family["Family member"] -->|forwards booking email| CFRouting["Cloudflare Email Routing"]
    CFRouting --> CFWorker["Cloudflare Worker<br/>(sender allowlist, out-of-repo)"]
    CFWorker -->|"POST raw MIME<br/>+ shared-secret header"| Webhook["n8n webhook<br/>/webhook/trip-ingest"]

    Webhook --> Auth{"shared secret<br/>valid?"}
    Auth -->|no| Reject["401, no further work"]
    Auth -->|yes| MimeParse["MIME parse<br/>(Code node, hand-rolled)"]

    MimeParse --> PdfText["Extract PDF Text<br/>(per attachment)"]
    PdfText --> Kitinerary["Kitinerary Extract<br/>calls mcp-kitinerary"]

    Kitinerary -->|"structured JSON-LD found"| Mapped["mapped ex item(s)<br/>(deterministic)"]
    Kitinerary -->|"nothing found"| Ollama["Ollama extraction<br/>(LLM, structured JSON schema)"]
    Ollama --> Mapped2["mapped ex item<br/>(probabilistic)"]

    Mapped --> TrekResolve["Trek Resolve<br/>(one Trek booking per item)"]
    Mapped2 --> TrekResolve

    TrekResolve -->|"cruise item, empty stops"| OllamaEnrich["targeted Ollama call<br/>(stops[] only)"]
    OllamaEnrich -.-> TrekResolve

    TrekResolve --> TrekMCP["Trek native /mcp<br/>list_trips, create_trip,<br/>create_reservation/transport/accommodation"]
    TrekMCP --> Notify["Notify<br/>(one email per booking)"]
    Notify --> Family
```

**Namespace map** (this cluster; adjust for your own):

| Component                            | Namespace       | Notes                                                                                                                |
| :----------------------------------- | :-------------- | :------------------------------------------------------------------------------------------------------------------- |
| Cloudflare Email Routing + Worker    | Cloudflare edge | Out-of-repo — lives in the Worker's own deploy pipeline                                                              |
| n8n (orchestration)                  | `household`     | Workflow content synced from git, see [Deployment](#deployment--how-to-change-it)                                    |
| `mcp-kitinerary` MCP server          | `ai`            | [Standalone repo](https://github.com/mrwulf/kitinerary-mcp), registered via [ToolHive](../cluster/apps/ai/toolhive/) |
| `ollama` (LLM fallback + enrichment) | `ai`            | Already deployed for other purposes                                                                                  |
| `trek` (trip store)                  | `household`     | Speaks MCP natively — no wrapper needed                                                                              |
| `smtp-relay` (outbound notification) | `system`        | Already deployed for other purposes                                                                                  |

## Components

### 1. Email ingestion — Cloudflare Worker

A Cloudflare Worker already bound to Email Routing traffic gets one extra rule: if the recipient matches the trip-ingest alias, stream the raw RFC-822 MIME (headers + body + attachments, unparsed) as the POST body to the n8n webhook, with `Content-Type: message/rfc822`. Two headers ride along: `X-Trip-Ingest-Secret` (the real auth gate — see below) and `X-Envelope-From` (n8n needs this to know who to notify; it isn't reliably present in the forwarded MIME's own `From:` header).

The Worker also does a cheap sender-allowlist check before forwarding anything — not real auth (envelope `from` is trivially spoofable), just a deterrent against opportunistic scanner traffic. **The real gate is the shared secret**: the webhook route has zero auth at the ingress/proxy level (it has to stay open — it's shared infrastructure for every external trigger n8n handles), so the workflow's first node validates `X-Trip-Ingest-Secret` and returns a bare 401 with no further processing on mismatch. This is not optional — without it, the endpoint is an open door to both arbitrary compute consumption and arbitrary data injection.

### 2. n8n workflow — `cluster/apps/household/n8n/app/workflows/trip-ingest.json`

The whole pipeline is one n8n workflow. Node chain:

```text
Webhook → Code in JavaScript (secret check, MIME parse) → If (401 branch)
        → Respond Success (fires immediately — see below)
        → Extract PDF Text (per attachment) → Kitinerary Extract → Code in JavaScript1 (Ollama fallback + cruise enrichment)
        → Trek Resolve (one Trek booking per item) → Notify (one email per booking)
```

Two things worth calling out about this shape:

- **The HTTP response fires before the real work finishes.** `Respond Success` returns immediately after the secret check (the only fast-path check that exists); everything downstream (extraction, Trek writes, notification) continues asynchronously in the same execution via n8n's `responseMode: "responseNode"`. This exists because the full chain (LLM extraction + retries + Trek MCP round-trips + SMTP) can legitimately take minutes, and neither the sending mail server's SMTP timeout nor Cloudflare's Worker subrequest budget should have to survive that. Trade-off: only the secret check can still bounce the inbound SMTP transaction; everything past that relies entirely on the notification email as the signal, since the HTTP response is long gone by the time those run.
- **`Trek Resolve` runs once per mapped reservation, not once per email.** A single confirmation email can yield more than one bona fide booking (a non-connecting round-trip, a hotel + rental car in one itinerary PDF) — see [Multi-item support](#multi-item-support-multi-leg-flights-and-multiple-bookings-per-email) below.

### 3. Extraction: kitinerary first, Ollama as fallback and narrow enrichment

This is the part worth understanding in detail, since it's the least obvious design choice.

**Primary path — deterministic**: most real airline/hotel confirmation emails already embed `schema.org` `Reservation` JSON-LD markup (the same markup Gmail parses for its own "smart" trip cards). KDE's [`kitinerary-extractor`](https://invent.kde.org/pim/kitinerary) reads it out deterministically — no LLM, no hallucination risk — and also handles structured PDF tickets and Apple/Google Wallet `.pkpass` files the same way. It runs as its own small MCP server, [`kitinerary-mcp`](https://github.com/mrwulf/kitinerary-mcp) (a separate, standalone, publishable repo — see that repo's README for the server itself). `Kitinerary Extract` calls it with the raw email as a `.eml` file, maps every reservation it returns into the pipeline's flat `ex` shape (see [the mapping table](#json-ld--ex-mapping-table) below), and groups connecting flight legs into one booking.

**Fallback path — probabilistic**: when kitinerary finds nothing (no structured markup in the source, or an `@type` its mapping doesn't cover), the pipeline falls through unchanged to an Ollama call against a local LLM (`mistral:latest`, structured JSON-schema output) — the pipeline's original, only extraction method before kitinerary existed. Same `ex` shape, but the model's own document understanding does the work instead of a deterministic parser. Extraction quality here is inconsistent run to run (confirmed via repeated live tests) — accepted as a known trade-off, mitigated by the confirmation-email human-in-the-loop.

**A third, narrow path — targeted enrichment**: kitinerary cannot structurally extract multi-port cruise itineraries (`BoatReservation` carries no per-port stops in its data model at all). When a mapped item is a cruise with empty `stops`, the pipeline makes one supplementary Ollama call — reusing the same extraction prompt — and harvests _only_ `.stops` from the result, keeping every other kitinerary-derived field (dates, confirmation code, amount) as the deterministic source of truth. **A blanket "always also ask the LLM" policy was considered and rejected** — it would reintroduce latency and hallucination risk on the ~90% of emails kitinerary already handles completely, for no benefit on those. Scoping the LLM call to the one case it's actually needed for is the whole point.

#### JSON-LD → `ex` mapping table

Reverse-engineered from Trek's own `kitinerary-mapper.js` (its built-in AI Booking Import feature runs the same CLI) — `r` is the raw reservation object, `r.reservationFor` is the nested thing being reserved (schema.org's own nesting convention).

Common to every type: `total_amount`/`currency` come from the same field-name ladder regardless of `@type` — check `r.price`, `r.priceAmount`, `r.totalPrice`, `r.total` (first non-null wins) on both the top-level object and `r.reservationFor`, since different providers nest it differently. `confirmation_code` is always `r.reservationNumber`.

| `@type`                                      | `booking_type` | `provider_name`                                                | dates live on...                                           | destination                                      |
| -------------------------------------------- | -------------- | -------------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------ |
| `FlightReservation`                          | `flight`       | `reservationFor.airline.name`/`.iataCode`                      | `reservationFor.departureTime`/`.arrivalTime`              | `reservationFor.arrivalAirport.name`/`.iataCode` |
| `TrainReservation`                           | `transit`      | `reservationFor.trainNumber`/`.trainName`                      | `reservationFor.departureTime`/`.arrivalTime`              | `reservationFor.arrivalStation.name`             |
| `BusReservation`                             | `transit`      | `reservationFor.busNumber`/`.busName`                          | `reservationFor.departureTime`/`.arrivalTime`              | `reservationFor.arrivalBusStop.name`             |
| `BoatReservation`                            | `cruise`       | `reservationFor.name`                                          | `reservationFor.departureTime`/`.arrivalTime`              | `reservationFor.arrivalBoatTerminal.name`        |
| `LodgingReservation`                         | `lodging`      | `reservationFor.name`                                          | **`r.checkinTime`/`.checkoutTime`** (not `reservationFor`) | `reservationFor.address` (formatted)             |
| `FoodEstablishmentReservation`               | `restaurant`   | `reservationFor.name`                                          | `r.startTime`/`.endTime`                                   | `reservationFor.address` (formatted)             |
| `RentalCarReservation`                       | `rental_car`   | `reservationFor.rentalCompany.name` + `.name`/`.make`/`.model` | **`r.pickupTime`/`.dropoffTime`** (not `reservationFor`)   | `r.dropoffLocation.name`/`.address`              |
| `EventReservation`, `TouristAttractionVisit` | `activity`     | `reservationFor.name`                                          | `reservationFor.startDate` or `r.startTime` (try both)     | `reservationFor.location.address`/`.name`        |
| anything else                                | —              | —                                                              | —                                                          | not handled — falls through to Ollama            |

**Two data-shape traps, found the hard way:**

1. **Some datetime fields come back wrapped**: `{"@type":"QDateTime","@value":"2031-09-10T08:00:00-05:00","timezone":"America/Chicago"}` rather than a plain ISO string. Confirmed live: `FlightReservation` departure/arrival times are always wrapped once an airport is timezone-resolved; `LodgingReservation` check-in/out times came back as plain strings for an otherwise-equivalent source. Unwrap defensively (check for a string first, fall back to `.@value`) on every date field, not just the ones observed broken — an unwrapped object silently produces `NaN` out of `new Date(...)` rather than throwing at the point of the actual bug.
2. **kitinerary's own result validation rejects an under-specified reservation outright** — `items: []`, not a partial extraction. A synthetic `BoatReservation` with only a name and times (no terminal objects) produced nothing at all; adding proper `BoatTerminal` objects with address data made it extract correctly. Worth knowing before assuming kitinerary "should have" found something from a minimal source.

#### Multi-item support: multi-leg flights and multiple bookings per email

A single email can describe more than one real booking, and the pipeline handles two distinct cases:

- **Connecting flight legs** (same confirmation number, arrival airport of leg N == departure airport of leg N+1, gap under 24h and forward in time) are grouped into **one** flight booking, with the intermediate airports carried in `stops[]` — matching Trek's own mapper, and avoiding N separate disconnected-looking bookings for what's really one itinerary.
- **Genuinely separate reservations** in the same email (a non-connecting outbound + return, a hotel + rental car in one itinerary PDF) each become their own mapped item, fanned out into separate n8n items, each producing its own Trek booking and its own confirmation email.

**A real bug found building this**: multi-passenger bookings commonly emit one near-identical `FlightReservation` per passenger per leg, all sharing the same confirmation number. Grouped naively (sort by time, chain consecutive legs), this can merge leg N of one passenger's itinerary onto leg N+1 of a _different_ passenger's, purely because the times line up — Trek's schema has no per-passenger tracking, so the fix is deduping identical legs (same route + times) down to one representative before grouping, not trying to track passengers through the pipeline.

`Trek Resolve` runs in n8n's `mode: runOnceForEachItem` to process each mapped item independently. Two n8n-specific traps surfaced getting this right, both confirmed live before touching the production workflow:

- `$input.first()`/`$input.all()` are disallowed entirely in that mode (`Can't use .first() here`) — use `$json` for the current item, or `$('OtherNode').first()` for a cross-node reference (still valid). The final `return` must be a bare `{ json: {...} }`, not `[{ json: {...} }]` — the array form throws `A 'json' property isn't an object`.
- n8n's each-item-mode validator does a **naive text scan** for disallowed method names, not AST analysis — a code _comment_ that literally contains the text `.first()` gets the node rejected, with no actual call anywhere in the code.

### 4. Trip resolution — Trek's native MCP endpoint

Trek ships its own `/mcp` endpoint natively (bearer-token auth, independent of its human-login OIDC mode) — call it directly over cluster-internal DNS. **Do not wrap an already-MCP-native app behind a gateway like ToolHive**; that's a redundant hop and a second thing to keep in sync for no capability gained.

Resolution algorithm, run once per mapped booking item:

1. `list_trips`, then match against existing trips within a ±3 day window of the booking's start date. No match → `create_trip`.
2. If the booking's dates fall outside the matched trip's current `start_date`/`end_date`, extend it via `update_trip` first (a trip should grow to fit its bookings, not the other way around).
3. Dedup: exact match on `confirmation_code` first; if that doesn't match, a same-type + overlapping-date-window fallback (flight/transit/cruise/lodging only — other types don't have a reliable duplicate signal) that also requires the provider names to share a word before it's allowed to fire. That second requirement exists because bare type+date overlap alone matched a genuine new booking against a completely unrelated existing record in production once real household data hit it — see git history for the exact incident.
4. Not a duplicate → `create_transport` (flight/transit) or the accommodation/place-resolution flow (`search_place → create_place → create_accommodation`, falling back to a bare `create_reservation` if no place match) for lodging, or `create_reservation` for everything else. Also links the booking to the trip's day-by-day itinerary (`assign_place_to_day` for accommodations) and files a linked cost entry when the currency matches the trip's own.

Trek's MCP has no server-side "search reservations by confirmation code" tool — dedup is done by pulling the full `get_trip_summary` and scanning client-side.

### 5. Notification

One email per created/duplicate/failed booking (n8n's default per-item behavior for a non-Code node downstream of a per-item execution) via the cluster's existing outbound relay — no new SMTP credential. Every notification ends with a `Ref: n8n-exec-<id>` correlation ID, a direct key into n8n's own execution history for diagnosis. A failure anywhere in the chain (extraction, Trek write) still produces a notification — the pipeline never fails silently.

## Deployment — how to change it

There's no file-mount or CLI-import path into a running n8n instance; the live workflow lives in n8n's own DB. The chain from a git commit to a live change:

```text
git commit → git push → Flux GitRepository reconcile → Flux Kustomization reconcile
  → ConfigMap (n8n-trip-ingest-workflow) updated → CronJob PUTs it into n8n's own DB via its Public API
  → only then does a live webhook execution reflect the change
```

Every arrow can lag independently, and the sync CronJob runs on its own 15-minute schedule regardless of who last touched the workflow — **editing live via the UI or API without updating the git file first gets silently reverted on the next tick.** Git is genuinely the source of truth; treat the CronJob as adversarial to any uncommitted live edit. When timing matters (active testing), trigger both Flux reconciles explicitly and a one-off `kubectl create job --from=cronjob/n8n-workflow-sync`, and confirm the node list matches via n8n's own API before testing against it.

**Testing methodology**: there's no staging n8n or staging Trek — testing means testing against the real instance. The pattern used throughout this pipeline's development: build a synthetic fixture with a distinctive marker (`ZZTEST`) and dates far in the future, `kubectl exec` into the n8n pod and drive everything through `node -e '...fetch...'` (no `curl` in the image), and for anything riskier than a read — a change to node execution mode, a new branch in the logic — first push it to a **disposable duplicate n8n workflow** (same content, a different webhook path, created via the Public API, deleted after) rather than the live one. This avoids both the 15-minute sync-CronJob clobbering problem and any chance of leaving broken state in production mid-test. Every test trip gets deleted via Trek's own `delete_trip` MCP tool and confirmed gone via a follow-up DB read before moving on.

## Known limitations

- **No dead-letter/reprocess mechanism.** A failed email's only recovery today is manually finding the `.eml` and resubmitting by hand.
- **The n8n editor UI's WebSocket is broken on this cluster** (`[WebSocketClient] Connection lost, code=1006`) — the backend executes nodes fine, but "Execute step" never shows a result in the UI. Suspected cause: the forward-auth middleware chain doesn't cleanly pass the WebSocket upgrade through. Worked around entirely by testing through the Public API and live webhook calls instead of the UI's manual node executor.
- **The SMTP notification credential isn't GitOps-tracked** — created once via n8n's own API, referenced by ID in the workflow JSON. If n8n's DB is ever rebuilt, this needs recreating by hand.
- **Concurrent duplicate-trip creation is an accepted risk, not solved.** Two near-simultaneous forwards for the same not-yet-existing trip can race past the matching check before either has created one. At household scale (a handful of forwards per trip, from a handful of people), this is judged not worth distributed locking for — the failure mode is cheap to fix by hand.
- **Ollama extraction quality varies run to run** on the fallback path — inherent to LLM-based extraction, mitigated (not eliminated) by the always-on confirmation email giving a human a chance to catch a bad extraction.

## Features checklist

- [x] Email ingestion via existing Cloudflare Worker, shared-secret auth gate
- [x] Raw MIME parsing (multipart, quoted-printable/base64, nested `message/rfc822` forwards), HTML/plain-text body extraction
- [x] PDF attachment text extraction (all attachments, not just the first)
- [x] Deterministic extraction via kitinerary — lodging, flight, train, bus, cruise, restaurant, rental car, activity
- [x] Multi-leg flight grouping (connecting legs → one booking)
- [x] Multi-passenger booking dedup (identical legs collapsed before grouping)
- [x] Multiple genuinely-separate bookings per email (fan-out, one Trek booking each)
- [x] LLM fallback extraction (Ollama) when kitinerary finds nothing
- [x] Scoped LLM enrichment for cruise multi-port stops (kitinerary's one structural gap)
- [x] Trip matching/creation via Trek's native MCP, ±3 day window
- [x] Trip auto-expansion when a booking falls outside the matched trip's date range
- [x] Duplicate detection: exact confirmation match, plus a provider-name-correlated date-overlap fallback
- [x] Accommodation day-linkage (`assign_place_to_day`) and linked cost tracking
- [x] Retry-with-backoff on both Ollama and Trek MCP calls
- [x] Always-on notification (success, duplicate, and failure all produce an email) with a correlation ID
- [x] Fast synchronous webhook response, async continuation for the real work
- [x] Declarative workflow in git, synced into the running n8n instance via a CronJob
- [ ] Dead-letter/reprocess mechanism for failed emails
- [ ] n8n editor UI WebSocket fix (workaround in place, root cause not fixed)
- [ ] SMTP credential brought under GitOps tracking
- [ ] Distributed locking for concurrent duplicate-trip creation (accepted risk, not planned)

## Related

- [`kitinerary-mcp`](https://github.com/mrwulf/kitinerary-mcp) — the standalone MCP server this pipeline's deterministic extraction path runs on
- [ToolHive README](../cluster/apps/ai/toolhive/README.md) — how `mcp-kitinerary` (and every other MCP server in this cluster) is registered and reached
- `cluster/apps/household/n8n/app/workflows/trip-ingest.json` — the actual workflow, source of truth
