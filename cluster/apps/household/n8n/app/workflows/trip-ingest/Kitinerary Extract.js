const item = $("Code in JavaScript").first().json
const helpers = this.helpers

const KITINERARY_URL =
  "http://mcp-mcp-kitinerary-proxy.ai.svc.cluster.local:8080/mcp"

function parseMcpBody(bodyText) {
  const match = bodyText.match(/data:\s*(\{[\s\S]*\})/)
  const jsonText = match ? match[1] : bodyText
  return JSON.parse(jsonText)
}

async function withRetry(fn, attempts, baseDelayMs) {
  let lastErr
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn()
    } catch (e) {
      lastErr = e
      if (i < attempts - 1) {
        await new Promise(function (resolve) {
          setTimeout(resolve, baseDelayMs * Math.pow(2, i))
        })
      }
    }
  }
  throw lastErr
}

// mcp-kitinerary's ToolHive proxy speaks the stateless per-request MCP variant
// (no initialize handshake / session id - each call carries its own protocol
// envelope in params._meta), unlike Trek's stateful initialize+session pattern
// in 'Trek Resolve'. Confirmed live against mcp-mcp-kitinerary-proxy before
// writing this - see docs/trip_ingest_kitinerary_integration_spec.md §2.
async function mcpToolStateless(toolName, args) {
  const res = await withRetry(
    function () {
      return helpers.httpRequest({
        method: "POST",
        url: KITINERARY_URL,
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: Date.now(),
          method: "tools/call",
          params: {
            name: toolName,
            arguments: args || {},
            _meta: {
              "io.modelcontextprotocol/protocolVersion": "2026-07-28",
              "io.modelcontextprotocol/clientCapabilities": {},
            },
          },
        }),
        timeout: 65000,
        returnFullResponse: true,
      })
    },
    3,
    1000
  )
  const parsed = parseMcpBody(String(res.body))
  if (parsed.error) {
    throw new Error(
      "kitinerary MCP error calling " +
        toolName +
        ": " +
        JSON.stringify(parsed.error)
    )
  }
  const content = (parsed.result && parsed.result.content) || []
  const textPart = content[content.length - 1]
  const raw = textPart ? textPart.text : "{}"
  try {
    return JSON.parse(raw)
  } catch (e) {
    throw new Error(
      "kitinerary tool " + toolName + " returned a non-JSON response: " + raw
    )
  }
}

// kitinerary-extractor wraps some (not all) datetime fields as a QDateTime
// object ({"@type":"QDateTime","@value":"...","timezone":"..."}) rather than
// a plain ISO string - confirmed live: FlightReservation departureTime/
// arrivalTime are always wrapped once an airport is timezone-resolved,
// while LodgingReservation checkinTime/checkoutTime came back as plain
// strings for the same source shape. Apply this everywhere a date value is
// read from the raw kitinerary object, not just where it's been observed
// broken - an unwrapped QDateTime object silently produces NaN out of
// `new Date(...)` (no exception at grouping time) and an "Invalid time
// value" crash much later inside Trek Resolve.
function extractDateTime(v) {
  if (v == null) return null
  if (typeof v === "string") return v
  if (typeof v === "object" && typeof v["@value"] === "string")
    return v["@value"]
  return null
}

function firstNonNull() {
  for (let i = 0; i < arguments.length; i++) {
    if (arguments[i] != null) return arguments[i]
  }
  return null
}

function getAmountAndCurrency(r, rf) {
  let amount = firstNonNull(
    r.price,
    r.priceAmount,
    r.totalPrice,
    r.total,
    rf.price,
    rf.priceAmount,
    rf.totalPrice,
    rf.total
  )
  let currency = firstNonNull(
    r.priceCurrency,
    r.priceCurrencyISO4217Code,
    r.currency,
    rf.priceCurrency,
    rf.priceCurrencyISO4217Code,
    rf.currency
  )
  if (typeof amount === "string") {
    const n = parseFloat(amount)
    amount = isNaN(n) ? null : n
  }
  if (typeof amount !== "number" || !(amount > 0)) {
    amount = null
    currency = null
  }
  if (currency) currency = String(currency).toUpperCase()
  return { total_amount: amount, currency: currency }
}

function formatAddress(addr) {
  if (!addr) return null
  if (typeof addr === "string") return addr
  const parts = [
    addr.streetAddress,
    addr.addressLocality,
    addr.addressRegion,
    addr.addressCountry,
  ].filter(Boolean)
  return parts.length ? parts.join(", ") : null
}

// schema.org Reservation.underName is usually a single Person, but the spec
// technically allows Person|Organization and kitinerary has been seen to emit
// an array for a group booking - handle both defensively rather than assuming
// the common single-object shape.
function extractPassengerNames(r) {
  const under = r && r.underName
  if (!under) return []
  const people = Array.isArray(under) ? under : [under]
  const names = []
  for (const p of people) {
    const name = p && typeof p.name === "string" ? p.name.trim() : null
    if (name && names.indexOf(name) === -1) names.push(name)
  }
  return names
}

// docs/trip_ingest_kitinerary_integration_spec.md §3.1: Trek's own mapper
// groups connecting FlightReservation legs (same reservationNumber, leg N's
// arrival airport === leg N+1's departure airport, gap under 24h and forward
// in time) into one booking. We do the same here rather than the originally-
// deferred "one item per email" shortcut, now that the single-item path is
// proven live - see docs/trip_ingestion_pipeline_tdd_sdd.md §9.1.
// A multi-passenger booking commonly emits one near-identical
// FlightReservation per passenger per leg, all sharing the same
// reservationNumber - kitinerary has no per-passenger dedup of its own.
// Left as-is, grouping would sort every passenger's legs into one
// timeline and could chain leg N of one passenger's itinerary onto leg
// N+1 of a *different* passenger's, purely because the times happen to
// line up (confirmed live with a synthetic 2-passenger, 2-leg fixture).
// Trek's own schema has no per-passenger tracking either, so the
// correct fix is collapsing duplicate legs (same route + times) down to
// one representative before grouping, not trying to track passengers.
// Collapses identical legs down to one representative (see rationale above),
// but a booking's identity - who is actually travelling - shouldn't disappear
// along with the duplicates it collapses. Every dropped leg's underName is
// folded onto the kept representative's `_passengerNames` before it's
// discarded, so mapFlightGroup can still report every traveler even though
// only one leg object survives grouping.
function dedupeIdenticalLegs(flights) {
  const seen = {}
  const keptByKey = {}
  const result = []
  for (const r of flights) {
    const rf = r.reservationFor || {}
    const dep = rf.departureAirport || {}
    const arr = rf.arrivalAirport || {}
    const key = [
      r.reservationNumber,
      dep.iataCode,
      arr.iataCode,
      extractDateTime(rf.departureTime),
      extractDateTime(rf.arrivalTime),
    ].join("|")
    const names = extractPassengerNames(r)
    if (!seen[key]) {
      seen[key] = true
      r._passengerNames = names.slice()
      keptByKey[key] = r
      result.push(r)
    } else {
      const kept = keptByKey[key]
      for (const name of names) {
        if (kept._passengerNames.indexOf(name) === -1)
          kept._passengerNames.push(name)
      }
    }
  }
  return result
}

function groupFlightLegs(flightsIn) {
  const flights = dedupeIdenticalLegs(flightsIn)
  const byReservation = {}
  for (const r of flights) {
    const key = r.reservationNumber || "__no_confirmation__" + Math.random()
    ;(byReservation[key] = byReservation[key] || []).push(r)
  }
  const groups = []
  for (const key of Object.keys(byReservation)) {
    const legs = byReservation[key].slice().sort(function (a, b) {
      const at =
        extractDateTime(a.reservationFor && a.reservationFor.departureTime) ||
        ""
      const bt =
        extractDateTime(b.reservationFor && b.reservationFor.departureTime) ||
        ""
      return at < bt ? -1 : at > bt ? 1 : 0
    })
    let current = [legs[0]]
    for (let i = 1; i < legs.length; i++) {
      const prevRf = current[current.length - 1].reservationFor || {}
      const curRf = legs[i].reservationFor || {}
      const prevArrCode =
        prevRf.arrivalAirport && prevRf.arrivalAirport.iataCode
      const curDepCode =
        curRf.departureAirport && curRf.departureAirport.iataCode
      const prevArrStr = extractDateTime(prevRf.arrivalTime)
      const curDepStr = extractDateTime(curRf.departureTime)
      const prevArr = prevArrStr ? new Date(prevArrStr).getTime() : null
      const curDep = curDepStr ? new Date(curDepStr).getTime() : null
      const gapMs =
        prevArr != null && curDep != null && !isNaN(prevArr) && !isNaN(curDep)
          ? curDep - prevArr
          : null
      const connects =
        prevArrCode &&
        curDepCode &&
        prevArrCode === curDepCode &&
        gapMs != null &&
        gapMs >= 0 &&
        gapMs < 24 * 60 * 60 * 1000
      if (connects) {
        current.push(legs[i])
      } else {
        groups.push(current)
        current = [legs[i]]
      }
    }
    groups.push(current)
  }
  return groups
}

function mapFlightGroup(legs) {
  const first = legs[0]
  const last = legs[legs.length - 1]
  const firstRf = first.reservationFor || {}
  const lastRf = last.reservationFor || {}
  const dep = firstRf.departureAirport || {}
  const arr = lastRf.arrivalAirport || {}
  const money = getAmountAndCurrency(first, firstRf)
  const airlineNames = []
  const flightNumbers = []
  // One entry per real flight segment - mirrors Trek's own legs[] input shape
  // (from/to IATA codes, HH:mm local times) so Trek Resolve can pass it straight
  // through. Only meaningful for a stopover (2+ legs): Trek's own endpoint model
  // stores a single local_time per physical stop, so the connecting airport's
  // arrival and departure times can only be told apart via legs[], not endpoints.
  const legDetails = []
  for (const leg of legs) {
    const legRf = leg.reservationFor || {}
    const name = legRf.airline && (legRf.airline.name || legRf.airline.iataCode)
    if (name && airlineNames.indexOf(name) === -1) airlineNames.push(name)
    const num = legRf.flightNumber
    if (num) flightNumbers.push(String(num))
    const depTime = extractDateTime(legRf.departureTime)
    const arrTime = extractDateTime(legRf.arrivalTime)
    legDetails.push({
      from: (legRf.departureAirport && legRf.departureAirport.iataCode) || null,
      to: (legRf.arrivalAirport && legRf.arrivalAirport.iataCode) || null,
      airline: name || null,
      flight_number: num ? String(num) : null,
      dep_time: depTime ? depTime.slice(11, 16) : null,
      arr_time: arrTime ? arrTime.slice(11, 16) : null,
      // Dates only (Trek Resolve turns these into day ids) - kept separate from
      // dep_time/arr_time since Trek's own legs[] schema wants HH:mm there. Uses
      // UTC .toISOString() rather than slicing the local ISO string, to agree with
      // how Trek Resolve derives the booking's own start/end day (new Date(iso).
      // toISOString().slice(0,10)) - a late-night departure/arrival in a negative
      // UTC offset can land on a different calendar day under one method than the
      // other, and Trek rejects a leg whose day disagrees with the booking's own
      // (confirmed live: 'end_day_id does not match legs[N].arr_day_id').
      dep_date: depTime ? new Date(depTime).toISOString().slice(0, 10) : null,
      arr_date: arrTime ? new Date(arrTime).toISOString().slice(0, 10) : null,
    })
  }
  const stops = []
  for (let i = 0; i < legs.length - 1; i++) {
    const legRf = legs[i].reservationFor || {}
    const connectionAirport = legRf.arrivalAirport || {}
    const legArrival = extractDateTime(legRf.arrivalTime)
    stops.push({
      name: connectionAirport.name || connectionAirport.iataCode || null,
      code: connectionAirport.iataCode || null,
      date: legArrival ? legArrival.slice(0, 10) : null,
    })
  }
  // Every leg's _passengerNames was populated by dedupeIdenticalLegs (each
  // leg here is already a kept representative, so this recovers the full
  // traveler list even though duplicate per-passenger legs were collapsed).
  const passengerNames = []
  for (const leg of legs) {
    for (const name of leg._passengerNames || []) {
      if (passengerNames.indexOf(name) === -1) passengerNames.push(name)
    }
  }
  return {
    booking_type: "flight",
    confirmation_code: first.reservationNumber || null,
    provider_name: airlineNames.length ? airlineNames.join(" / ") : null,
    flight_number: flightNumbers.length ? flightNumbers.join(" / ") : null,
    // Empty for a direct flight: with no shared connecting stop there is nothing
    // for legs[] to disambiguate that reservation_time/reservation_end_time don't
    // already cover.
    leg_details: legs.length > 1 ? legDetails : [],
    start_datetime: extractDateTime(firstRf.departureTime),
    end_datetime: extractDateTime(lastRf.arrivalTime),
    origin_name: dep.name || dep.iataCode || null,
    origin_code: dep.iataCode || null,
    destination_name: arr.name || arr.iataCode || null,
    destination_code: arr.iataCode || null,
    // Intermediate connection airports only (not origin/final destination) -
    // mirrors how cruise stops[] already carries multi-port itineraries.
    stops: stops,
    notes: legs.length > 1 ? legs.length + "-leg itinerary" : null,
    total_amount: money.total_amount,
    currency: money.currency,
    passenger_names: passengerNames,
  }
}

// docs/trip_ingest_kitinerary_integration_spec.md §3 mapping table, reverse-
// engineered from Trek's own kitinerary-mapper.js. Any @type not listed here
// returns null - same as Trek's own mapper ("Unknown type"), and is dropped
// rather than passed through.
function mapNonFlightItem(r) {
  const type = r["@type"]
  const rf = r.reservationFor || {}
  const money = getAmountAndCurrency(r, rf)
  const base = {
    confirmation_code: r.reservationNumber || null,
    total_amount: money.total_amount,
    currency: money.currency,
    origin_name: null,
    origin_code: null,
    destination_name: null,
    destination_code: null,
    stops: [],
    notes: null,
    passenger_names: extractPassengerNames(r),
  }

  if (type === "TrainReservation") {
    return Object.assign({}, base, {
      booking_type: "transit",
      provider_name: rf.trainNumber || rf.trainName || null,
      start_datetime: extractDateTime(rf.departureTime),
      end_datetime: extractDateTime(rf.arrivalTime),
      destination_name: (rf.arrivalStation && rf.arrivalStation.name) || null,
    })
  }
  if (type === "BusReservation") {
    return Object.assign({}, base, {
      booking_type: "transit",
      provider_name: rf.busNumber || rf.busName || null,
      start_datetime: extractDateTime(rf.departureTime),
      end_datetime: extractDateTime(rf.arrivalTime),
      destination_name: (rf.arrivalBusStop && rf.arrivalBusStop.name) || null,
    })
  }
  if (type === "BoatReservation") {
    // kitinerary doesn't structurally model multi-port cruise itineraries -
    // stays empty here. Code in JavaScript1 makes one targeted supplementary
    // Ollama call to fill this specific gap when it's the only thing
    // missing - see docs/trip_ingest_kitinerary_integration_spec.md §3.
    return Object.assign({}, base, {
      booking_type: "cruise",
      provider_name: rf.name || null,
      start_datetime: extractDateTime(rf.departureTime),
      end_datetime: extractDateTime(rf.arrivalTime),
      destination_name:
        (rf.arrivalBoatTerminal && rf.arrivalBoatTerminal.name) || null,
    })
  }
  if (type === "LodgingReservation") {
    // checkinTime/checkoutTime live on r, not reservationFor - unlike every
    // transport type above.
    return Object.assign({}, base, {
      booking_type: "lodging",
      provider_name: rf.name || null,
      start_datetime: extractDateTime(r.checkinTime),
      end_datetime: extractDateTime(r.checkoutTime),
      destination_name: formatAddress(rf.address),
    })
  }
  if (type === "FoodEstablishmentReservation") {
    return Object.assign({}, base, {
      booking_type: "restaurant",
      provider_name: rf.name || null,
      start_datetime: extractDateTime(r.startTime),
      end_datetime: extractDateTime(r.endTime),
      destination_name: formatAddress(rf.address),
    })
  }
  if (type === "RentalCarReservation") {
    // pickup/dropoff live on r, not reservationFor - same trap as lodging.
    const vehicleBits = [
      rf.rentalCompany && rf.rentalCompany.name,
      rf.name,
      rf.make,
      rf.model,
    ].filter(Boolean)
    return Object.assign({}, base, {
      booking_type: "rental_car",
      provider_name: vehicleBits.length ? vehicleBits.join(" ") : null,
      start_datetime: extractDateTime(r.pickupTime),
      end_datetime: extractDateTime(r.dropoffTime),
      destination_name:
        (r.dropoffLocation &&
          (r.dropoffLocation.name ||
            formatAddress(r.dropoffLocation.address))) ||
        null,
    })
  }
  if (type === "EventReservation" || type === "TouristAttractionVisit") {
    return Object.assign({}, base, {
      booking_type: "activity",
      provider_name: rf.name || null,
      start_datetime:
        extractDateTime(rf.startDate) || extractDateTime(r.startTime),
      end_datetime: extractDateTime(rf.endDate) || extractDateTime(r.endTime),
      destination_name:
        (rf.location &&
          (formatAddress(rf.location.address) || rf.location.name)) ||
        null,
    })
  }
  return null
}

// Map every reservation kitinerary returns, not just the first - connecting
// FlightReservation legs are grouped into one booking each first (above),
// so a 2-leg connection still produces exactly one flight item, while two
// genuinely separate reservations (e.g. outbound + return flights that don't
// connect, or a hotel + rental car in one itinerary PDF) each become their
// own item. Code in JavaScript1 fans these out into separate n8n items and
// Trek Resolve (mode: runOnceForEachItem) creates one booking per item.
let kitineraryExtractedItems = []
let kitineraryWarning = null
try {
  if (item.rawEmailBase64) {
    const result = await mcpToolStateless("extract_booking", {
      file_base64: item.rawEmailBase64,
      filename: "email.eml",
    })
    const items = result.items || []
    const flights = items.filter(function (r) {
      return r["@type"] === "FlightReservation"
    })
    const nonFlights = items.filter(function (r) {
      return r["@type"] !== "FlightReservation"
    })

    for (const group of groupFlightLegs(flights)) {
      kitineraryExtractedItems.push(mapFlightGroup(group))
    }
    for (const r of nonFlights) {
      const mapped = mapNonFlightItem(r)
      if (mapped) kitineraryExtractedItems.push(mapped)
    }

    if (result.warnings && result.warnings.length) {
      kitineraryWarning = result.warnings.join("; ")
    }
  }
} catch (e) {
  kitineraryWarning =
    "kitinerary extraction failed: " + (e.message || String(e))
}

// Preserve every input item (Extract PDF Text emits one per PDF attachment,
// or none) - Code in JavaScript1 still needs all of them for its own
// $input.all() pdfText aggregation regardless of which extraction path wins.
return $input.all().map(function (inp) {
  return {
    json: Object.assign({}, inp.json, {
      kitineraryExtractedItems: kitineraryExtractedItems,
      kitineraryWarning: kitineraryWarning,
    }),
  }
})
