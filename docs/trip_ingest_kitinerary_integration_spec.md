<!-- markdownlint-disable MD013 -->

# Wiring the `kitinerary` MCP Server into Trip Ingest — Integration & Test Guide

**Status**: Done — implemented in PR [#5045](https://github.com/mrwulf/home-cluster/pull/5045), deployed, and live-tested end to end (execution 62: a synthetic `LodgingReservation` email correctly short-circuited Ollama in 7ms, created a real Trek trip/reservation with the right confirmation code/dates/cost, verified directly against Trek's own SQLite DB, then deleted via `delete_trip`). See [§8](#8-acceptance-checklist) — every item checked.
**Owning feature**: Trip Ingest pipeline (TripIt replacement) — see [trip_ingestion_pipeline_tdd_sdd.md](trip_ingestion_pipeline_tdd_sdd.md).
**Current live state**: `cluster/apps/household/n8n/app/workflows/trip-ingest.json` calls `mcp-kitinerary`'s `extract_booking` first (new `Kitinerary Extract` node); Ollama only runs as a fallback when kitinerary returns nothing usable. `mcp-kitinerary`'s ToolHive proxy turned out to speak a **stateless** per-request MCP variant (`params._meta` envelope), not the stateful `initialize`+session pattern `Trek Resolve` uses — see [§2](#2-before-writing-any-workflow-code-verify-the-new-servers-own-contract), confirmed live before any workflow code was written.

This document is everything a fresh session needs to pick this back up: what to build (the mapping + node wiring), how to deploy it into this specific cluster without silently testing stale code, and how to test it safely against live production data with zero cleanup risk.

---

## 1. What this integration does

Once the kitinerary MCP server ([spec](kitinerary_mcp_server_spec.md)) is deployed, add ONE new step to the trip-ingest workflow, before the existing Ollama extraction: call the new server's `extract_booking` tool with the raw email. If it returns structured items, map them into the pipeline's existing flat `ex` shape (the same shape the Ollama step already produces — `booking_type`, `confirmation_code`, `provider_name`, `start_datetime`, `end_datetime`, `origin_name`/`origin_code`, `destination_name`/`destination_code`, `stops`, `notes`, `total_amount`, `currency`) and skip Ollama entirely. If it returns nothing, fall through to the existing Ollama call unchanged. Nothing downstream of extraction (`Trek Resolve`, dedup, `create_trip`/`create_reservation`/`create_transport`/`create_budget_item`, `Notify`) changes at all — this only replaces how the `ex` object gets populated, deterministically, for the common case.

This is the design chosen specifically to avoid the dead end already hit once: every write stays on the `TREK_API_TOKEN` MCP calls already proven working. No Trek REST API, no session JWT, no new credential.

## 2. Before writing any workflow code: verify the new server's own contract

Don't trust the spec document's suggested shapes as gospel — the implementer may have deviated. Before touching `trip-ingest.json`, confirm live:

1. **Tool name and args.** `mcp-kitinerary`'s actual registered tool name and its exact input schema (may not be literally `extract_booking(file_base64, filename, context_date?)` as spec'd — check what shipped).
2. **Endpoint and auth.** ToolHive gives every server its own per-server proxy Service, `mcp-mcp-<name>-proxy.<namespace>.svc.cluster.local:8080` (verified pattern: `mcp-searxng`'s manifest → Service `mcp-mcp-searxng-proxy`). There's also an aggregated gateway at `vmcp-toolhive-gateway.ai.svc.cluster.local:4483/sse` that multiplexes every registered server behind one MCP connection. **Which one to call from n8n, and whether either requires a bearer token for a same-cluster caller, was not verified this session** — the README documents the aggregated gateway as "LAN-only for MCP paths, Pocket ID OIDC for anything else," which is a browser/external-access description, not necessarily what an in-cluster pod hits internally. Confirm with a plain `curl`/`fetch` MCP `initialize` call from inside the n8n pod (same technique as [§6](#6-safe-live-testing-playbook)) before wiring anything into the real workflow — don't assume it's open just because Trek's own `/mcp` is.
3. If the new server does need a token, it'll need its own `ExternalSecret`/`envFrom` wiring into n8n's `n8n-trip-ingest-secrets` (or a new secret) — out of scope for the spec doc since that server is designed to need none, but verify it actually shipped that way.

## 3. JSON-LD → `ex` mapping table

Reverse-engineered from Trek's own `kitinerary-mapper.js` (`/app/server/dist/nest/booking-import/kitinerary-mapper.js` inside the running Trek container) — this is exactly what Trek's own AI Booking Import does with the same CLI output, so it's a known-correct reference, not a guess. `kitinerary-extractor` emits an array of `schema.org` `Reservation` objects; dispatch on `@type`. `r` = the reservation object, `r.reservationFor` = the nested thing being reserved (flight/hotel/train/etc — schema.org's own nesting convention).

Common to every type: `total_amount`/`currency` come from the **same field-name ladder** regardless of `@type` — check `r.price`, `r.priceAmount`, `r.totalPrice`, `r.total` (first non-null wins) for the amount, and `r.priceCurrency`, `r.priceCurrencyISO4217Code`, `r.currency` for the currency — checking **both the top-level reservation object and `r.reservationFor`** for each, since different providers nest it differently. `confirmation_code` is always `r.reservationNumber`.

| `@type`                                      | `booking_type` | `provider_name`                                                | `start_datetime`                            | `end_datetime`                          | destination                                      | notes                                                                                                                                                                                                                                          |
| -------------------------------------------- | -------------- | -------------------------------------------------------------- | ------------------------------------------- | --------------------------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FlightReservation`                          | `flight`       | `reservationFor.airline.name` (or `.iataCode`)                 | `reservationFor.departureTime`              | `reservationFor.arrivalTime`            | `reservationFor.arrivalAirport.name`/`.iataCode` | Consecutive `FlightReservation` items sharing a PNR with a same-airport, <24h, forward-in-time connection are one multi-leg trip — see [§3.1](#31-multi-leg-flights-a-real-wrinkle).                                                           |
| `TrainReservation`                           | `transit`      | `reservationFor.trainNumber` or `.trainName`                   | `reservationFor.departureTime`              | `reservationFor.arrivalTime`            | `reservationFor.arrivalStation.name`             | —                                                                                                                                                                                                                                              |
| `BusReservation`                             | `transit`      | `reservationFor.busNumber` or `.busName`                       | `reservationFor.departureTime`              | `reservationFor.arrivalTime`            | `reservationFor.arrivalBusStop.name`             | —                                                                                                                                                                                                                                              |
| `BoatReservation`                            | `cruise`       | `reservationFor.name`                                          | `reservationFor.departureTime`              | `reservationFor.arrivalTime`            | `reservationFor.arrivalBoatTerminal.name`        | KItinerary doesn't structurally model multi-port cruise itineraries the way our current Ollama prompt's `stops[]` does — a `BoatReservation` alone won't give you intermediate ports. Leave `stops` empty on this path; don't try to force it. |
| `LodgingReservation`                         | `lodging`      | `reservationFor.name`                                          | `r.checkinTime`                             | `r.checkoutTime`                        | `reservationFor.address` (formatted)             | This is the one type with genuinely different top-level date fields (`checkinTime`/`checkoutTime` on `r`, not `reservationFor`) — don't copy the flight pattern here.                                                                          |
| `FoodEstablishmentReservation`               | `restaurant`   | `reservationFor.name`                                          | `r.startTime`                               | `r.endTime`                             | `reservationFor.address` (formatted)             | —                                                                                                                                                                                                                                              |
| `RentalCarReservation`                       | `rental_car`   | `reservationFor.rentalCompany.name` + `.name`/`.make`/`.model` | `r.pickupTime`                              | `r.dropoffTime`                         | `r.dropoffLocation.name`/`.address`              | Pickup/dropoff live on `r` directly, not `reservationFor` — same trap as lodging.                                                                                                                                                              |
| `EventReservation`, `TouristAttractionVisit` | `activity`     | `reservationFor.name`                                          | `reservationFor.startDate` or `r.startTime` | `reservationFor.endDate` or `r.endTime` | `reservationFor.location.address`/`.name`        | Two possible date sources — try `reservationFor.startDate` first, `r.startTime` as fallback.                                                                                                                                                   |
| anything else                                | —              | —                                                              | —                                           | —                                       | —                                                | Not handled by Trek's own mapper either (`warnings.push("Unknown type...")`) — treat as "no match," fall through to Ollama for that item rather than guessing a mapping.                                                                       |

### 3.1 Multi-leg flights: a real wrinkle

Trek's mapper groups connecting `FlightReservation` legs (same reservation number, arrival airport of leg N === departure airport of leg N+1, gap under 24h and forward in time) into ONE booking with a `legs[]` array, rather than N separate flight bookings. Our existing `ex` schema's `stops[]` field (used today for cruise ports) is a reasonable place to carry this same idea for multi-leg flights too, but it's not currently populated for `flight`/`transit` types in the Ollama prompt — this mapping work is where that would need to be added, or deliberately scoped out (each leg becomes its own separate `flight` `ex` item, letting the existing per-item Trek Resolve loop create N separate transport bookings — simpler, and arguably fine, just less polished than Trek's own single-multi-leg-booking result). **Decide this explicitly rather than defaulting into it** — it changes how many items downstream dedup/creation sees per email.

### 3.2 Fields the mapping does NOT need to carry

`origin_name`/`origin_code` (departure side) is used by our existing extraction for context but isn't load-bearing for trip creation the way destination is — populate it when convenient (`reservationFor.departureAirport`/`.departureStation`/etc, mirroring the destination column above), but don't block on it.

## 4. Node wiring plan

In `cluster/apps/household/n8n/app/workflows/trip-ingest.json`, the relevant chain today is:

```text
Respond Success → Extract PDF Text → Code in JavaScript1 (Ollama extraction) → Trek Resolve → Notify
```

Insert one new Code node between `Extract PDF Text` and `Code in JavaScript1`:

```text
Respond Success → Extract PDF Text → Kitinerary Extract (new) → Code in JavaScript1 (Ollama, now conditional) → Trek Resolve → Notify
```

- **`Kitinerary Extract`**: calls the new MCP server's tool with the raw MIME buffer (base64-encoded — reuse the same `getBinaryDataBuffer` pattern already in `Code in JavaScript`, no need to re-derive it), gets back structured items, and runs the §3 mapping. Output a `kitineraryExtracted` field (mapped `ex`-shaped object, or `null` if nothing came back) onto the item alongside everything already flowing through (`item`, `pdfExtractionWarning`, etc.) — don't drop the existing fields, this node is additive.
- **`Code in JavaScript1`**: add one line at the very top — `if (item.kitineraryExtracted) { return [{ json: { ...item, extracted: item.kitineraryExtracted, extractionError: null, pdfExtractionWarning: item.pdfExtractionWarning } }]; }` (adjust field names to match whatever the actual node emits) — short-circuit before the Ollama HTTP call entirely when kitinerary already produced a usable result. Everything after that line (the Ollama call, the schema, the validation) is unchanged and still runs for anything kitinerary didn't handle.
- Reuse the existing `mcpRpc`/`mcpTool`/`withRetry` helper functions already duplicated across `Trek Resolve` and (in the reverted hybrid) `Trek Preview` — same pattern, just pointed at the new server's endpoint instead of Trek's. Don't invent a third variant.
- **Multi-item emails**: today, one email → one `ex` object → one booking. If §3.1 decides multi-leg flights become multiple mapped items, `Kitinerary Extract`'s output needs to become an array and `Trek Resolve` needs a loop instead of a single `ex` — that's a bigger structural change than a first pass should take on. **Recommended first cut: keep it one-item-per-email for now** (map only the first/primary reservation kitinerary returns, same as today), and treat "handle multiple items per email" as an explicit follow-up once the single-item path is proven live.

## 5. Deployment mechanics — how to not test stale code

This bit cost real time this session and will cost it again if skipped. **Editing the workflow JSON and committing does not make the change live.** The full path is:

```text
git commit → git push → Flux GitRepository reconcile → Flux Kustomization reconcile
  → ConfigMap (n8n-trip-ingest-workflow) updated → CronJob PUTs it into n8n's own DB
  → only THEN does a live webhook execution reflect the change
```

Every one of those arrows can lag independently. The CronJob runs every 15 minutes on its own schedule (`*/15 * * * *`), and `flux reconcile source git` does **not** automatically imply the Kustomization has re-applied yet — they're separately-scheduled controllers. Concretely, after pushing:

```sh
mise x -- flux reconcile source git flux-system
mise x -- flux reconcile kustomization cluster-apps --with-source   # NOT implied by the line above
kubectl get configmap -n household n8n-trip-ingest-workflow \
  -o jsonpath='{.data.trip-ingest\.json}' | python3 -c "import json,sys; print([n['name'] for n in json.load(sys.stdin)['nodes']])"
# confirm the node list matches what you just committed BEFORE going further
kubectl create job -n household n8n-workflow-sync-manual --from=cronjob/n8n-workflow-sync
kubectl wait --for=condition=complete -n household job/n8n-workflow-sync-manual --timeout=60s
kubectl exec -n household deploy/n8n -- node -e '
fetch("http://localhost:8080/api/v1/workflows/VPRsjZRxTBmywAdW", {
  headers: { "X-N8N-API-KEY": process.env.N8N_API_KEY },
}).then(async r => console.log((await r.json()).nodes.map(n => n.name).join(", ")));
'
# confirm THIS ALSO matches before firing any test
kubectl delete job -n household n8n-workflow-sync-manual
```

Skipping the "confirm it matches" steps is exactly how the first hybrid test run this session executed a stale workflow and produced a misleading result. Don't skip them.

## 6. Safe live-testing playbook

There is no staging Trek or staging n8n — testing means testing against the real household instance. This is the exact, low-risk methodology used (and refined) this session; reuse it rather than reinventing it.

**No secrets are ever read or printed.** `TRIP_INGEST_SHARED_SECRET`, `TREK_API_TOKEN`, and `N8N_API_KEY` all live as env vars inside the n8n pod already (via its `envFrom: n8n-trip-ingest-secrets`). Every test command below runs _inside_ that pod via `kubectl exec` and references the env vars symbolically (`process.env.X`) — the shell/Node process substitutes them locally; the value never appears in agent output or terminal scrollback.

1. **No `curl` in the n8n container** (confirmed this session — `exit code 127`). Use Node's built-in `fetch` (n8n's image ships Node 26) via `kubectl exec ... -- node -e '...'` instead.
2. **Build a synthetic fixture, not a real email.** Use a distinctive, greppable marker in every field (this session used `ZZTEST`) and dates far in the future (this session used 2031) so it can never collide with real household trip data and is trivial to find and confirm-delete afterward. For a kitinerary-path test specifically, embed real `schema.org` JSON-LD matching the [§3](#3-json-ld--ex-mapping-table) shape for whichever `@type` you're testing — plain prose text will NOT exercise kitinerary at all (it has no structured data to find), only the Ollama fallback path. See the [MCP server spec's §10](kitinerary_mcp_server_spec.md#10-acceptance-test-the-implementer-should-run-before-calling-this-done) for a ready-to-copy `LodgingReservation` fixture.
3. **Copy the fixture into the pod, then fire it:**

   ```sh
   cat test-booking.eml | kubectl exec -i -n household deploy/n8n -- sh -c 'cat > /tmp/zztest.eml'
   kubectl exec -n household deploy/n8n -- node -e '
   const fs = require("fs");
   const body = fs.readFileSync("/tmp/zztest.eml");
   fetch("http://localhost:8080/webhook/trip-ingest", {
     method: "POST",
     headers: {
       "Content-Type": "message/rfc822",
       "X-Trip-Ingest-Secret": process.env.TRIP_INGEST_SHARED_SECRET,
       "X-Envelope-From": "zztest-forwarder@example.invalid",
     },
     body,
   }).then(async r => { console.log(r.status); console.log(await r.text()); });
   '
   ```

   `example.invalid` (RFC 2606 reserved TLD) guarantees no real mail is delivered anywhere for the `Notify` step's send attempt, and no bounce backscatter to a real domain.

4. **Inspect the actual execution, not just the 200 response** — the webhook responds immediately (`respondMode: responseNode`) while the real work continues async. Poll `GET /api/v1/executions?limit=1` for `status: "success"`/`"error"`, then `GET /api/v1/executions/{id}?includeData=true` for the full per-node `runData` — this is where you actually see whether `Kitinerary Extract` got a real match, what it mapped, whether `Trek Resolve` created something, and the exact `notifyText` that would have been emailed. Same `node -e '...fetch...'` pattern, `X-N8N-API-KEY` header. This was how the `require('form-data')` sandbox failure and the Trek REST 401 were both actually diagnosed this session — the top-level execution status alone ("success"/finished in under 100ms) was actively misleading both times; always read the per-node data.
5. **Verify against Trek directly**, not just n8n's self-report — read-only, no secrets involved:

   ```sh
   kubectl exec -n household deploy/trek -- node -e "
   const db = require('better-sqlite3')('/app/data/travel.db', {readonly: true});
   console.log(JSON.stringify(db.prepare(\"SELECT id, title, currency FROM trips WHERE title LIKE '%ZZTEST%'\").all()));
   "
   ```

## 7. Consolidated gotchas (read this before you start)

Every one of these was discovered by testing, not by reading docs — treat this list as load-bearing.

- **n8n's Code node sandbox disallows `require()` of external npm packages** (confirmed: `require('form-data')` → `Module 'form-data' is disallowed`). No `NODE_FUNCTION_ALLOW_EXTERNAL` is set on this instance. Node built-ins (`Buffer`, `fetch`, etc.) are fine; anything from `node_modules` is not. If the new node ever needs to build a request body from scratch, do it with `Buffer`/string concatenation, not a library — see the multipart-by-hand code in `Trek Resolve`'s git history (commit `63982980b`) for the exact pattern if a reference is useful, even though that specific call site got reverted.
- **Trek's `trek_`-prefixed MCP API tokens (`TREK_API_TOKEN`) are a completely different credential from a login session** — stored hashed in Trek's own `mcp_tokens` table, checked by a code path (`JwtAuthGuard`, used by Trek's REST API) that never queries that table at all. Confirmed live via a 401 against `/api/trips/:id/reservations/import/booking` with a token that worked fine against `/mcp` seconds earlier. **This is exactly why the kitinerary MCP server approach exists at all** — don't re-attempt calling Trek's own REST booking-import API from this pipeline; it structurally cannot work with the credential this pipeline is scoped to hold.
- **`flux reconcile source git` does not imply the Kustomization has re-applied.** Reconcile both explicitly when timing matters for a test (see [§5](#5-deployment-mechanics--how-to-not-test-stale-code)).
- **The n8n workflow-sync CronJob runs on its own 15-minute schedule** — don't wait for it during active testing; trigger a one-off `kubectl create job --from=cronjob/n8n-workflow-sync` and clean it up (`kubectl delete job ...`) afterward.
- **No `curl` in the n8n container image** — use `node -e` with `fetch`.
- **A 200 from the webhook, or a fast "success" execution status, proves nothing about what actually happened downstream** — the response comes back before the async continuation runs, and the top-level execution record doesn't surface per-node errors. Always pull `?includeData=true` and read `runData` per node.
- **The new MCP server's own auth model over internal cluster DNS was not verified this session** — see [§2](#2-before-writing-any-workflow-code-verify-the-new-servers-own-contract). Don't assume it's open.

## 8. Acceptance checklist

- [x] ~~`mcp-kitinerary`'s actual tool name/args/endpoint/auth confirmed live (§2), not assumed from the build spec.~~ Matches spec exactly (`extract_booking(file_base64, filename, context_date?)`, no auth) — but the transport contract didn't: the ToolHive proxy speaks a stateless per-request `params._meta` envelope, not Trek's stateful `initialize`+session pattern. Confirmed via a live `tools/call` from inside the `n8n` pod before writing any workflow code.
- [x] ~~§3 mapping implemented for at least `LodgingReservation` and one transport type~~ — implemented for all 8 types in the table. `mapKitineraryItem` unit-tested standalone against real `LodgingReservation` (date fields on `r`) and `FlightReservation` (date fields on `reservationFor`) shapes, both correct, plus an unknown-`@type` fallthrough to `null`.
- [x] ~~§3.1 (multi-leg flights) explicitly decided, not defaulted into.~~ First cut: one mapped item per email, same cardinality as the Ollama path. Each leg of a multi-leg flight becomes its own separate `flight` item. Documented as an explicit follow-up in the node's own code comment, not a silent default.
- [x] ~~Ollama fallback still fires correctly for a fixture with no structured markup~~ — live-verified (execution 63, isolated test trip 182, deleted after): a plain-text ZZTEST marketing email correctly produced `kitineraryExtracted: null` / `kitineraryWarning: "no reservation data found in file"`, and `Code in JavaScript1` took 18.8s (a real Ollama round-trip, not the 7ms short-circuit), correctly classifying it `general`. The short-circuit did not break the fallback path.
- [x] ~~`mise x -- task test:all` green.~~
- [x] ~~Deployed per §5, confirmed live in n8n's own API (not just git) before testing.~~ All three checkpoints matched before any test fired: git → `n8n-trip-ingest-workflow` ConfigMap → n8n's own `/api/v1/workflows/:id` (post `n8n-workflow-sync` Job run).
- [x] ~~Live end-to-end test per §6 against a `ZZTEST`-marked fixture~~ — execution 62: a synthetic `LodgingReservation` email matched in 7ms, correctly skipping Ollama entirely (execution time, not just a fast response, proves the short-circuit fired). Created trip 181 / reservation 518, `confirmation_number: "ZZTEST-0001"`, `type: "hotel"`, correct 2031-09-10→09-12 dates, $450.50 USD — all confirmed directly against Trek's own SQLite DB, not just `notifyText`.
- [x] ~~Test trip deleted via `delete_trip` MCP tool; confirmed gone via a follow-up DB read; scratch pod files and any manual sync Jobs removed.~~ Both test trips (181, 182) deleted this way and confirmed gone via a follow-up DB read; all scratch pod files (`/tmp/zztest*.eml`, `/tmp/exec*.json`) and the manual `n8n-workflow-sync-manual` Job removed.

Real gotcha found calling Trek's `delete_trip` directly (not through `Trek Resolve`, which already gets this right): its MCP endpoint's auth guard is sensitive to the `Host`/`X-Forwarded-Proto` headers `Trek Resolve` already sends (`Host: plans.sysinfra.pro`, `X-Forwarded-Proto: https`) — omitting them gets a `401 Access token required` on `initialize` itself, even with a valid bearer token. The tool's own arg name is `tripId`, not `trip_id`.
