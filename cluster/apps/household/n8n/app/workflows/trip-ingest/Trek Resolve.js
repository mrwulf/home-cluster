const item = $json // mode: runOnceForEachItem - $input helpers are disallowed here (verified live)
const ex = item.extracted || {}
const extractionError = item.extractionError || null
const pdfExtractionWarning = item.pdfExtractionWarning || null
const helpers = this.helpers

const TREK_URL = "http://trek.household.svc.cluster.local:3000/mcp"
const TREK_TOKEN = $env.TREK_API_TOKEN
// Maps a passenger's first name (lowercased) to the Trek account email that
// should be added as a real trip member instead of a guest - e.g. a booking's
// underName "Chelsea Gordon" needs to resolve to a Trek account whose own
// username is just "Chelsea", which no amount of fuzzy name matching against
// the trip roster alone would find. Household emails are PII and this repo is
// public, so the map itself lives in Bitwarden, not here - see
// docs/tripit_replacement.md #passenger-capture-and-trip-ownership.
let FAMILY_MEMBER_EMAILS = {}
try {
  FAMILY_MEMBER_EMAILS = JSON.parse(
    $env.TRIP_INGEST_FAMILY_MEMBERS_JSON || "{}"
  )
} catch (e) {
  // Malformed secret value - fall through to guest creation for everyone rather
  // than fail every booking in the trip.
}

function baseHeaders(sessionId) {
  const h = {
    Authorization: "Bearer " + TREK_TOKEN,
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    "X-Forwarded-Proto": "https",
    Host: "${TREK_SUBDOMAIN}.${SECRET_DOMAIN}",
  }
  if (sessionId) h["Mcp-Session-Id"] = sessionId
  return h
}

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

async function mcpRpc(sessionId, method, params) {
  // Retry is scoped to this HTTP call only, not to callers - it only fires when the
  // request/response cycle itself fails (pod restart, connection reset), which is the
  // dominant home-lab failure mode. A response Trek actually sent back - success or a
  // JSON-RPC/application error - is never retried, to avoid re-issuing a write Trek may
  // have already applied.
  const res = await withRetry(
    function () {
      return helpers.httpRequest({
        method: "POST",
        url: TREK_URL,
        headers: baseHeaders(sessionId),
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: Date.now(),
          method: method,
          params: params || {},
        }),
        returnFullResponse: true,
      })
    },
    3,
    1000
  )
  return { parsed: parseMcpBody(String(res.body)), headers: res.headers }
}

async function mcpTool(sessionId, toolName, args) {
  const r = await mcpRpc(sessionId, "tools/call", {
    name: toolName,
    arguments: args || {},
  })
  if (r.parsed.error) {
    throw new Error(
      "Trek MCP error calling " +
        toolName +
        ": " +
        JSON.stringify(r.parsed.error)
    )
  }
  const content = (r.parsed.result && r.parsed.result.content) || []
  const textPart = content[content.length - 1]
  const raw = textPart ? textPart.text : "{}"
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    throw new Error(
      "Trek tool " + toolName + " returned a non-JSON response: " + raw
    )
  }
  return parsed
}

async function resolveCoords(sessionId, query) {
  if (!query) return null
  try {
    const searchResult = await mcpTool(sessionId, "search_place", {
      query: query,
    })
    const places = searchResult.places || []
    const best = places[0]
    if (best && best.lat != null && best.lng != null) {
      return { lat: best.lat, lng: best.lng }
    }
  } catch (e) {
    // no match / lookup failure - endpoint will be created without coordinates
  }
  return null
}

function toDate(s) {
  return s ? new Date(s) : null
}

function overlaps(aStart, aEnd, bStart, bEnd) {
  if (aStart == null || bStart == null) return false
  const aE = aEnd != null ? aEnd : aStart
  const bE = bEnd != null ? bEnd : bStart
  return aStart <= bE && bStart <= aE
}

// Trek's Costs tab only recognizes these 14 free-text category labels (anything
// else lands in "Other") - see budget.mcp.js create_budget_item.
const BUDGET_CATEGORY_BY_TYPE = {
  flight: "Flights",
  lodging: "Accommodation",
  rental_car: "Transport",
  transit: "Transport",
  cruise: "Transport",
  restaurant: "Food & drink",
  activity: "Activities",
  general: "Other",
}

// create_reservation/create_transport only accept a bare `price` (no currency) -
// it is always booked in the trip's own currency. When the email states a
// different currency, linking through that field would silently misrecord the
// amount, so those cases fall back to a standalone create_budget_item call
// (which does take `currency` and freezes its own FX rate) instead of the
// native "linked" price.
function planCost(ex, tripCurrency) {
  if (typeof ex.total_amount !== "number" || !(ex.total_amount > 0)) return null
  const currency = ex.currency ? ex.currency.toUpperCase() : null
  const linked =
    !currency || !tripCurrency || currency === tripCurrency.toUpperCase()
  return {
    amount: ex.total_amount,
    currency: currency,
    category: BUDGET_CATEGORY_BY_TYPE[ex.booking_type] || "Other",
    linked: linked,
  }
}

let tripId = null
let createdNewTrip = false
let isDuplicate = false
let duplicateMatch = null
let duplicateMatchReason = null
let createdBooking = null
let placeSearchNote = null
let trekError = null
let costError = null
let costPlan = null
let memberAddWarning = null
let travelerWarning = null
let resolvedTravelerIds = []

if (!extractionError) {
  try {
    const initRes = await mcpRpc(null, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "n8n-trip-ingest", version: "1.0" },
    })
    const sessionId =
      initRes.headers["mcp-session-id"] || initRes.headers["Mcp-Session-Id"]

    const tripsData = await mcpTool(sessionId, "list_trips", {})
    const trips = tripsData.trips || []

    const startDt = toDate(ex.start_datetime)
    const endDt = toDate(ex.end_datetime) || startDt
    const startDateOnly = startDt ? startDt.toISOString().slice(0, 10) : null
    const endDateOnly = endDt ? endDt.toISOString().slice(0, 10) : startDateOnly

    let matchedTrip = null
    if (startDt) {
      const windowMs = 3 * 24 * 60 * 60 * 1000
      for (const t of trips) {
        const tStart = new Date(t.start_date + "T00:00:00")
        const tEnd = new Date(t.end_date + "T23:59:59")
        if (
          startDt.getTime() >= tStart.getTime() - windowMs &&
          startDt.getTime() <= tEnd.getTime() + windowMs
        ) {
          matchedTrip = t
          break
        }
      }
    }

    if (matchedTrip) {
      tripId = matchedTrip.id
      // A booking can land outside the trip's recorded window (an extra night tacked
      // on, a longer drive home) even though it matched within the +/-3 day fuzz above -
      // keep the trip's own date range accurate so future list_trips window-matching
      // (and the Trek UI) reflects reality instead of just whichever booking created it.
      const curStart = matchedTrip.start_date
      const curEnd = matchedTrip.end_date
      const newStart =
        startDateOnly && (!curStart || startDateOnly < curStart)
          ? startDateOnly
          : curStart
      const newEnd =
        endDateOnly && (!curEnd || endDateOnly > curEnd) ? endDateOnly : curEnd
      if (newStart !== curStart || newEnd !== curEnd) {
        await mcpTool(sessionId, "update_trip", {
          tripId: tripId,
          start_date: newStart,
          end_date: newEnd,
        })
      }
    } else {
      const destName =
        ex.destination_name || ex.destination_code || ex.provider_name || "Trip"
      const createArgs = { title: "Trip to " + destName, currency: "USD" }
      if (startDateOnly) createArgs.start_date = startDateOnly
      if (endDateOnly) createArgs.end_date = endDateOnly
      const created = await mcpTool(sessionId, "create_trip", createArgs)
      tripId = created.trip ? created.trip.id : created.id
      createdNewTrip = true
    }

    const tripCurrency = matchedTrip ? matchedTrip.currency || "USD" : "USD"
    costPlan = planCost(ex, tripCurrency)

    // Only ever called from the non-duplicate creation branch below. Covers two
    // cases: a currency that doesn't match the trip's (create_reservation/
    // create_transport can't take one) and create_accommodation, which has no
    // price field at all - linking through place_id there instead.
    async function recordBudgetItem(name, placeId) {
      try {
        const budgetArgs = {
          tripId: tripId,
          name: name,
          category: costPlan.category,
          total_price: costPlan.amount,
        }
        if (costPlan.currency) budgetArgs.currency = costPlan.currency
        if (placeId) budgetArgs.place_id = placeId
        await mcpTool(sessionId, "create_budget_item", budgetArgs)
      } catch (e) {
        costError = "Could not record cost: " + (e.message || String(e))
      }
    }

    const summary = await mcpTool(sessionId, "get_trip_summary", {
      tripId: tripId,
    })
    const days = summary.days || []

    function findDayId(dateStr) {
      if (!dateStr) return null
      const day = days.find(function (d) {
        return d.date === dateStr
      })
      return day ? day.id : null
    }

    // Trip creation auto-generates days for its own date range, but a booking that
    // lands outside that range (see update_trip above) still needs its own day row -
    // Trek has no bulk "extend days" call, so missing ones are created on demand.
    // Scoped to the non-duplicate branch below so a duplicate never creates orphan days.
    async function ensureDayId(dateStr) {
      if (!dateStr) return null
      const existing = findDayId(dateStr)
      if (existing != null) return existing
      const createdDay = await mcpTool(sessionId, "create_day", {
        tripId: tripId,
        date: dateStr,
      })
      const newDay = createdDay.day || createdDay
      days.push({ id: newDay.id, date: dateStr, day_number: newDay.day_number })
      return newDay.id
    }

    function timeOnly(isoDateTime) {
      if (!isoDateTime || isoDateTime.length < 16) return null
      return isoDateTime.slice(11, 16)
    }

    function dayNumberById(id) {
      const d = days.find(function (x) {
        return x.id === id
      })
      return d ? d.day_number : null
    }

    const existingReservations = summary.reservations || []
    const existingAccommodations = summary.accommodations || []

    // Every trip this pipeline creates is owned by whichever Trek account
    // TREK_API_TOKEN belongs to - not the person who actually forwarded the
    // email. Best-effort add them as a real collaborator so the trip shows up
    // under their own account too. envelopeFrom (not mimeFrom) is used because
    // it's the reliable one - see 'Code in JavaScript' upstream. This is
    // intentionally silent-fail: most forwards come from a household member
    // who already has a TREK account, but a sender with none, or a forward
    // from a non-household address, must not block booking creation.
    if (
      createdNewTrip &&
      item.envelopeFrom &&
      item.envelopeFrom.indexOf("@") !== -1
    ) {
      try {
        await mcpTool(sessionId, "add_trip_member", {
          tripId: tripId,
          identifier: item.envelopeFrom,
        })
      } catch (e) {
        memberAddWarning =
          "Could not add " +
          item.envelopeFrom +
          " as a trip member: " +
          (e.message || String(e))
      }
    }

    // Trip roster (members + guests) used to resolve ex.passenger_names below.
    // get_trip_summary's `members` is { owner, collaborators }, not a flat list
    // (confirmed live - the flat-array assumption threw "tripMembers.find is
    // not a function" against the real API) - flatten owner + collaborators
    // into one array. Mutated in place as new guests are created so repeated
    // names within the same email (e.g. one passenger on two separate mapped
    // items) resolve to the same guest instead of creating a duplicate each time.
    const rosterData = summary.members || {}
    let tripMembers = [rosterData.owner]
      .concat(rosterData.collaborators || [])
      .filter(Boolean)

    async function resolveTravelerIds(names) {
      const ids = []
      for (const rawName of names || []) {
        const name = (rawName || "").trim()
        if (!name) continue
        const lowerName = name.toLowerCase()
        const firstName = lowerName.split(/\s+/)[0]
        // A Trek account's own username is typically just a first name, while a
        // booking's underName usually carries a full name - match either way so an
        // already-added family member (from an earlier booking on this same trip)
        // is recognized here instead of hitting add_trip_member again every time.
        let member = tripMembers.find(function (m) {
          const uname = (m.username || "").trim().toLowerCase()
          return uname === lowerName || uname === firstName
        })
        // Not already on this trip's roster - a known family member (by first
        // name, since a Trek account's own username is typically just that, while
        // a booking's underName usually carries a full name) gets added as a real
        // member; anyone else falls through to a guest below.
        if (!member) {
          const knownEmail = FAMILY_MEMBER_EMAILS[firstName]
          if (knownEmail) {
            try {
              const added = await mcpTool(sessionId, "add_trip_member", {
                tripId: tripId,
                identifier: knownEmail,
              })
              member = added.member || added
              tripMembers.push(member)
            } catch (e) {
              travelerWarning =
                (travelerWarning ? travelerWarning + "; " : "") +
                'Could not add known family member "' +
                name +
                '": ' +
                (e.message || String(e))
            }
          }
        }
        if (!member) {
          try {
            const created = await mcpTool(sessionId, "create_trip_guest", {
              tripId: tripId,
              name: name,
            })
            member = created.member || created
            tripMembers.push(member)
          } catch (e) {
            travelerWarning =
              (travelerWarning ? travelerWarning + "; " : "") +
              'Could not add "' +
              name +
              '" as a traveler: ' +
              (e.message || String(e))
          }
        }
        if (member) ids.push(member.id)
      }
      return ids
    }

    const isLodging = ex.booking_type === "lodging"
    const transportTypeMap = {
      flight: "flight",
      transit: "train",
      cruise: "cruise",
    }
    const expectedTransportType = transportTypeMap[ex.booking_type] || null

    // A lodging booking that couldn't be matched to a place (no search_place hit) falls
    // back to a plain type:'hotel' reservation instead of an accommodation record (see
    // the creation branch below) - scan both shapes so that downgraded booking is still
    // found as the existing match on a later duplicate email.
    if (ex.confirmation_code) {
      duplicateMatch = isLodging
        ? existingAccommodations.find(function (a) {
            return a.confirmation === ex.confirmation_code
          }) ||
          existingReservations.find(function (r) {
            return (
              r.type === "hotel" &&
              r.confirmation_number === ex.confirmation_code
            )
          })
        : existingReservations.find(function (r) {
            return r.confirmation_number === ex.confirmation_code
          })
      if (duplicateMatch) duplicateMatchReason = "matching confirmation number"
    }

    // Confirmation numbers can legitimately differ for the same real booking (travel
    // agency code vs. the airline/cruise line's own code, especially on TripIt-migrated
    // data) - fall back to type + overlapping date window, which a same-trip sender is
    // very unlikely to hit twice for an unrelated booking.
    function normalizeWords(s) {
      return (s || "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .trim()
        .split(" ")
        .filter(function (w) {
          return w.length > 2
        })
    }
    function providerNamesRelated(a, b) {
      const wordsA = normalizeWords(a)
      const wordsB = normalizeWords(b)
      if (!wordsA.length || !wordsB.length) return false
      return wordsA.some(function (w) {
        return wordsB.indexOf(w) !== -1
      })
    }

    if (!duplicateMatch && isLodging && startDt) {
      const dayDateById = {}
      days.forEach(function (d) {
        dayDateById[d.id] = d.date
      })
      const lodgingStartMs = startDt.getTime()
      const lodgingEndMs = (endDt || startDt).getTime()
      // Overlapping dates alone are not a duplicate signal for lodging - the household
      // routinely books more than one real thing for the same dates (multiple rooms,
      // a companion's separate hotel, an unrelated "Home"/placeholder entry). Require a
      // plausible name relation to the booking's own provider before date overlap counts;
      // an exact confirmation match is already handled by the check above this one.
      duplicateMatch =
        existingAccommodations.find(function (a) {
          if (!providerNamesRelated(ex.provider_name, a.place_name))
            return false
          const aStart = toDate(dayDateById[a.start_day_id])
          if (!aStart) return false
          const aEnd = toDate(dayDateById[a.end_day_id]) || aStart
          return overlaps(
            lodgingStartMs,
            lodgingEndMs,
            aStart.getTime(),
            aEnd.getTime()
          )
        }) ||
        existingReservations.find(function (r) {
          if (r.type !== "hotel") return false
          if (!providerNamesRelated(ex.provider_name, r.title)) return false
          // A hotel-type reservation (the placeId-not-found fallback below) carries the full
          // stay in reservation_time/reservation_end_time - prefer that over day_id, which is
          // only ever a single check-in day and would under-match a multi-night stay. Fall
          // back to day_id for any older record created before reservation_time was added.
          const rStart = toDate(r.reservation_time)
          if (rStart) {
            const rEnd = toDate(r.reservation_end_time) || rStart
            return overlaps(
              lodgingStartMs,
              lodgingEndMs,
              rStart.getTime(),
              rEnd.getTime()
            )
          }
          const rDayDate = toDate(dayDateById[r.day_id])
          if (!rDayDate) return false
          const rDayEnd = toDate(dayDateById[r.end_day_id]) || rDayDate
          return overlaps(
            lodgingStartMs,
            lodgingEndMs,
            rDayDate.getTime(),
            rDayEnd.getTime()
          )
        })
      if (duplicateMatch) duplicateMatchReason = "overlapping stay dates"
    }

    if (!duplicateMatch && expectedTransportType && startDt) {
      const startMs = startDt.getTime()
      const endMs = (endDt || startDt).getTime()
      duplicateMatch = existingReservations.find(function (r) {
        if (r.type !== expectedTransportType) return false
        // Same rationale as the lodging overlap fallback above: two genuinely different
        // same-day bookings of the same transport type (e.g. two separate flights, or one
        // traveler's outbound flight and another's on the same day) are common, not a
        // duplicate - require a plausible name relation before date overlap counts; an
        // exact confirmation match is already handled by the check above this one.
        if (!providerNamesRelated(ex.provider_name, r.title)) return false
        const rStart = toDate(r.reservation_time)
        if (!rStart) return false
        const rEnd = toDate(r.reservation_end_time) || rStart
        return overlaps(startMs, endMs, rStart.getTime(), rEnd.getTime())
      })
      if (duplicateMatch)
        duplicateMatchReason = "same transport type with overlapping dates"
    }

    isDuplicate = Boolean(duplicateMatch)

    if (!isDuplicate) {
      const startDayId = await ensureDayId(startDateOnly)
      const endDayId = (await ensureDayId(endDateOnly)) || startDayId

      // Resolved once per booking and attached below via attachTravelers - shared
      // across every branch since a booking can only take one type of creation call.
      const travelerIds = await resolveTravelerIds(ex.passenger_names)
      resolvedTravelerIds = travelerIds
      async function attachTravelers(bookingResult) {
        const reservationId =
          bookingResult &&
          bookingResult.reservation &&
          bookingResult.reservation.id
        if (!travelerIds.length || !reservationId) return
        try {
          await mcpTool(sessionId, "set_reservation_travelers", {
            tripId: tripId,
            reservationId: reservationId,
            user_ids: travelerIds,
          })
        } catch (e) {
          travelerWarning =
            (travelerWarning ? travelerWarning + "; " : "") +
            "Could not attach travelers to booking: " +
            (e.message || String(e))
        }
      }

      // create_reservation always lands as pending (it has no status field at all) and
      // create_transport defaults to pending too - but the forwarded email itself IS the
      // confirmation of the booking, so every booking this pipeline creates should read
      // as confirmed rather than sit as an unconfirmed draft.
      async function confirmReservation(bookingResult) {
        const reservationId =
          bookingResult &&
          bookingResult.reservation &&
          bookingResult.reservation.id
        if (!reservationId) return
        await mcpTool(sessionId, "update_reservation", {
          tripId: tripId,
          reservationId: reservationId,
          status: "confirmed",
        })
      }

      if (
        ex.booking_type === "flight" ||
        ex.booking_type === "transit" ||
        ex.booking_type === "cruise"
      ) {
        const transportTypeMap = {
          flight: "flight",
          transit: "train",
          cruise: "cruise",
        }
        const transportType = transportTypeMap[ex.booking_type]
        const args = {
          tripId: tripId,
          type: transportType,
          title:
            (ex.provider_name || transportType) +
            (ex.confirmation_code ? " (" + ex.confirmation_code + ")" : ""),
          status: "confirmed",
        }
        if (startDayId) args.start_day_id = startDayId
        if (endDayId) args.end_day_id = endDayId
        if (ex.start_datetime) args.reservation_time = ex.start_datetime
        if (ex.end_datetime) args.reservation_end_time = ex.end_datetime
        if (ex.confirmation_code)
          args.confirmation_number = ex.confirmation_code
        if (costPlan && costPlan.linked) {
          args.price = costPlan.amount
          args.budget_category = costPlan.category
        }
        const stops = (ex.stops || []).filter(function (s) {
          return (
            s &&
            s.name &&
            !/^cruising$|^at sea$|^day at sea$|^sea day$/i.test(s.name.trim())
          )
        })
        // Build endpoints whenever a full route (origin + destination) is known,
        // not only when there are 2+ intermediate stops - the single-layover and
        // direct-flight cases (the overwhelming majority of real bookings) previously
        // got no route/layover recorded on the booking at all. Confirmed live: a real
        // 1-layover Expedia booking landed with empty endpoints under the old gate.
        const hasRoute = Boolean(
          (ex.origin_name || ex.origin_code) &&
          (ex.destination_name || ex.destination_code)
        )
        if (hasRoute) {
          const endpointSpecs = [
            { name: ex.origin_name || ex.origin_code, code: ex.origin_code },
          ]
            .concat(
              stops.map(function (s) {
                return { name: s.name, code: s.code, date: s.date }
              })
            )
            .concat([
              {
                name: ex.destination_name || ex.destination_code,
                code: ex.destination_code,
              },
            ])
          const endpoints = []
          for (let i = 0; i < endpointSpecs.length; i++) {
            const spec = endpointSpecs[i]
            const endpoint = {
              role:
                i === 0
                  ? "from"
                  : i === endpointSpecs.length - 1
                    ? "to"
                    : "stop",
              sequence: i,
              name: spec.name,
              local_date: spec.date || undefined,
            }
            // Flights resolve coordinates server-side from the IATA code - more
            // reliable than free-text geocoding and confirmed live; everything else
            // still geocodes by name as before.
            if (transportType === "flight" && spec.code) {
              endpoint.code = spec.code
            } else {
              const coords = await resolveCoords(sessionId, spec.name)
              if (coords) {
                endpoint.lat = coords.lat
                endpoint.lng = coords.lng
              }
            }
            endpoints.push(endpoint)
          }
          args.endpoints = endpoints
        }
        if (transportType === "flight") {
          const flightMetadata = {}
          if (ex.provider_name) flightMetadata.airline = ex.provider_name
          if (ex.flight_number) flightMetadata.flight_number = ex.flight_number
          if (ex.origin_code) flightMetadata.departure_airport = ex.origin_code
          if (ex.destination_code)
            flightMetadata.arrival_airport = ex.destination_code
          if (Object.keys(flightMetadata).length > 0)
            args.metadata = flightMetadata
          // Disambiguates arrival-at vs departure-from the same connecting airport -
          // see the comment on leg_details in Kitinerary Extract for why endpoints
          // alone can't carry both times for a shared stop.
          // Each leg needs its OWN day id (Trek's applyLegs falls back to the
          // booking's overall start/end day only when a leg omits one entirely) -
          // without this, a connection that crosses into a new calendar day (an
          // overnight layover) would have both legs clamped onto the departure day.
          if (ex.leg_details && ex.leg_details.length > 0) {
            args.legs = []
            for (const leg of ex.leg_details) {
              const depDayId = leg.dep_date
                ? await ensureDayId(leg.dep_date)
                : startDayId
              const arrDayId = leg.arr_date
                ? await ensureDayId(leg.arr_date)
                : depDayId
              args.legs.push({
                from: leg.from,
                to: leg.to,
                airline: leg.airline,
                flight_number: leg.flight_number,
                dep_day_id: depDayId,
                dep_time: leg.dep_time,
                arr_day_id: arrDayId,
                arr_time: leg.arr_time,
                // Trek's own docs say an unset leg confirmation_number falls back to
                // the booking's own - set it explicitly anyway rather than depend on
                // that inheritance actually surfacing wherever it's displayed. Every
                // leg shares one confirmation here since kitinerary/Ollama don't
                // currently distinguish a per-segment reference from the booking's own.
                confirmation_number: ex.confirmation_code || undefined,
              })
            }
          }
        }
        createdBooking = await mcpTool(sessionId, "create_transport", args)
        await attachTravelers(createdBooking)
        if (costPlan && !costPlan.linked)
          await recordBudgetItem(args.title, null)
      } else if (isLodging && startDayId && endDayId) {
        const searchQuery = [
          ex.provider_name,
          ex.destination_name || ex.destination_code,
        ]
          .filter(Boolean)
          .join(" ")
        let placeId = null
        if (searchQuery) {
          const searchResult = await mcpTool(sessionId, "search_place", {
            query: searchQuery,
          })
          const places = searchResult.places || []
          const best = places[0]
          if (best) {
            const placeArgs = {
              tripId: tripId,
              name: best.name || ex.provider_name || "Hotel",
            }
            if (best.lat != null) placeArgs.lat = best.lat
            if (best.lng != null) placeArgs.lng = best.lng
            if (best.address) placeArgs.address = best.address
            if (best.google_place_id)
              placeArgs.google_place_id = best.google_place_id
            if (best.google_ftid) placeArgs.google_ftid = best.google_ftid
            if (best.osm_id) placeArgs.osm_id = best.osm_id
            const createdPlace = await mcpTool(
              sessionId,
              "create_place",
              placeArgs
            )
            placeId = createdPlace.place
              ? createdPlace.place.id
              : createdPlace.id
          } else {
            placeSearchNote = 'No place match found for "' + searchQuery + '"'
          }
        }
        if (placeId) {
          const accomArgs = {
            tripId: tripId,
            place_id: placeId,
            start_day_id: startDayId,
            end_day_id: endDayId,
          }
          const checkInTime = timeOnly(ex.start_datetime)
          const checkOutTime = timeOnly(ex.end_datetime)
          if (checkInTime) accomArgs.check_in = checkInTime
          if (checkOutTime) accomArgs.check_out = checkOutTime
          if (ex.confirmation_code)
            accomArgs.confirmation = ex.confirmation_code
          // create_accommodation has no traveler-list tool the way create_transport/
          // create_reservation do (set_reservation_travelers only takes a reservationId,
          // and an accommodation is a separate table, not a reservation row) - fold
          // passenger names into notes instead so they aren't silently dropped.
          const accomNotesParts = [
            ex.notes,
            (ex.passenger_names || []).length
              ? "Travelers: " + ex.passenger_names.join(", ")
              : null,
          ].filter(Boolean)
          if (accomNotesParts.length)
            accomArgs.notes = accomNotesParts.join(" - ")
          createdBooking = await mcpTool(
            sessionId,
            "create_accommodation",
            accomArgs
          )
          // create_accommodation has no price field at all (unlike create_reservation/
          // create_transport), so its cost always goes through a separate budget item,
          // linked back to the place instead of the booking.
          if (costPlan) {
            await recordBudgetItem(
              (ex.provider_name || "Hotel") +
                (ex.confirmation_code ? " (" + ex.confirmation_code + ")" : ""),
              placeId
            )
          }
          // Assign the place to every day of the stay, not just the accommodation record's
          // own date span - the day-by-day itinerary view (used for transport planning)
          // only shows what's assigned to each day.
          const startDayNum = dayNumberById(startDayId)
          const endDayNum = dayNumberById(endDayId)
          if (startDayNum != null && endDayNum != null) {
            const stayDayIds = days
              .filter(function (d) {
                return (
                  d.day_number != null &&
                  d.day_number >= startDayNum &&
                  d.day_number <= endDayNum
                )
              })
              .map(function (d) {
                return d.id
              })
            for (const stayDayId of stayDayIds) {
              await mcpTool(sessionId, "assign_place_to_day", {
                tripId: tripId,
                dayId: stayDayId,
                placeId: placeId,
              })
            }
          }
        } else {
          const args = {
            tripId: tripId,
            type: "hotel",
            title:
              (ex.provider_name || "Hotel") +
              (ex.confirmation_code ? " (" + ex.confirmation_code + ")" : ""),
          }
          if (startDayId) args.day_id = startDayId
          if (ex.start_datetime) args.reservation_time = ex.start_datetime
          if (ex.end_datetime) args.reservation_end_time = ex.end_datetime
          if (ex.confirmation_code)
            args.confirmation_number = ex.confirmation_code
          if (ex.notes) args.notes = ex.notes
          if (placeSearchNote)
            args.notes =
              (args.notes ? args.notes + " - " : "") + placeSearchNote
          if (costPlan && costPlan.linked) {
            args.price = costPlan.amount
            args.budget_category = costPlan.category
          }
          createdBooking = await mcpTool(sessionId, "create_reservation", args)
          await confirmReservation(createdBooking)
          await attachTravelers(createdBooking)
          if (costPlan && !costPlan.linked)
            await recordBudgetItem(args.title, null)
        }
      } else {
        const typeMap = {
          lodging: "hotel",
          rental_car: "other",
          restaurant: "restaurant",
          activity: "activity",
          general: "other",
        }
        const args = {
          tripId: tripId,
          type: typeMap[ex.booking_type] || "other",
          title:
            (ex.provider_name || ex.booking_type || "Booking") +
            (ex.confirmation_code ? " (" + ex.confirmation_code + ")" : ""),
        }
        if (startDayId) args.day_id = startDayId
        if (ex.start_datetime) args.reservation_time = ex.start_datetime
        if (ex.end_datetime) args.reservation_end_time = ex.end_datetime
        if (ex.confirmation_code)
          args.confirmation_number = ex.confirmation_code
        if (ex.notes) args.notes = ex.notes
        if (costPlan && costPlan.linked) {
          args.price = costPlan.amount
          args.budget_category = costPlan.category
        }
        createdBooking = await mcpTool(sessionId, "create_reservation", args)
        await confirmReservation(createdBooking)
        await attachTravelers(createdBooking)
        if (costPlan && !costPlan.linked)
          await recordBudgetItem(args.title, null)
      }
    }
  } catch (e) {
    trekError = e.message || String(e)
  }
}

const execRef =
  "n8n-exec-" + ($execution && $execution.id ? $execution.id : "unknown")

const costLine = costPlan
  ? "\nCost: " +
    costPlan.amount.toFixed(2) +
    " " +
    (costPlan.currency || "(trip currency)") +
    (costPlan.linked
      ? ""
      : " - recorded as a separate expense, not shown on the booking")
  : ""
const costWarning = costError ? "\n\nWarning: " + costError : ""
const memberAddWarningLine = memberAddWarning
  ? "\n\nWarning: " + memberAddWarning
  : ""
const travelerWarningLine = travelerWarning
  ? "\n\nWarning: " + travelerWarning
  : ""

let notifySubject
let notifyText
if (extractionError) {
  notifySubject =
    "Could not process trip email: " + (item.subject || "no subject")
  notifyText =
    "I could not process this email automatically.\n\n" +
    "Error: " +
    extractionError +
    "\n\n" +
    "Original subject: " +
    (item.subject || "n/a") +
    "\n" +
    "From: " +
    (item.mimeFrom || "n/a") +
    "\n\n" +
    "Please add this to Trek manually if it is a real booking.\n\n" +
    "Ref: " +
    execRef
} else if (trekError) {
  notifySubject =
    "Trek add failed: " + (ex.provider_name || ex.booking_type || "Booking")
  notifyText =
    "I could not add this to Trek automatically - please add it manually.\n\n" +
    "Error: " +
    trekError +
    "\n\n" +
    "Type: " +
    (ex.booking_type || "unknown") +
    "\n" +
    "Provider: " +
    (ex.provider_name || "n/a") +
    "\n" +
    "Confirmation: " +
    (ex.confirmation_code || "n/a") +
    (pdfExtractionWarning ? "\n\nWarning: " + pdfExtractionWarning : "") +
    "\n\nRef: " +
    execRef
} else if (isDuplicate) {
  const matchedTitle = duplicateMatch
    ? duplicateMatch.title ||
      duplicateMatch.reservation_title ||
      duplicateMatch.place_name ||
      "existing record"
    : "existing record"
  const matchedConfirmation = duplicateMatch
    ? duplicateMatch.confirmation_number || duplicateMatch.confirmation || "n/a"
    : "n/a"
  notifySubject =
    "Already in Trek: " + (ex.provider_name || ex.booking_type || "Booking")
  notifyText =
    "This booking was already in Trek (matched by " +
    (duplicateMatchReason || "confirmation code") +
    ") - no duplicate created.\n\n" +
    "Matched: " +
    matchedTitle +
    " (confirmation: " +
    matchedConfirmation +
    ")\n" +
    "Trip: https://${TREK_SUBDOMAIN}.${SECRET_DOMAIN}/trips/" +
    tripId +
    "\n" +
    "Type: " +
    (ex.booking_type || "unknown") +
    "\n" +
    "Provider: " +
    (ex.provider_name || "n/a") +
    "\n" +
    "Confirmation: " +
    (ex.confirmation_code || "n/a") +
    (pdfExtractionWarning ? "\n\nWarning: " + pdfExtractionWarning : "") +
    "\n\nRef: " +
    execRef
} else {
  notifySubject =
    "Added to Trek: " + (ex.provider_name || ex.booking_type || "Booking")
  notifyText =
    (createdNewTrip
      ? "Created a new trip and added this booking."
      : "Added this booking to an existing trip.") +
    "\n\n" +
    "Trip: https://${TREK_SUBDOMAIN}.${SECRET_DOMAIN}/trips/" +
    tripId +
    "\n" +
    "Type: " +
    (ex.booking_type || "unknown") +
    "\n" +
    "Provider: " +
    (ex.provider_name || "n/a") +
    "\n" +
    "Confirmation: " +
    (ex.confirmation_code || "n/a") +
    costLine +
    (pdfExtractionWarning ? "\n\nWarning: " + pdfExtractionWarning : "") +
    costWarning +
    memberAddWarningLine +
    travelerWarningLine +
    "\n\nRef: " +
    execRef
}

// mode: runOnceForEachItem requires a bare {json:...}, not [{json:...}]
// (verified live: the array form throws "A 'json' property isn't an object").
return {
  json: Object.assign({}, item, {
    trekTripId: tripId,
    trekCreatedNewTrip: createdNewTrip,
    trekIsDuplicate: isDuplicate,
    trekDuplicateMatchReason: duplicateMatchReason,
    trekCreatedBooking: createdBooking,
    trekPlaceSearchNote: placeSearchNote,
    trekCostPlan: costPlan,
    trekCostError: costError,
    trekTravelerIds: resolvedTravelerIds,
    trekTravelerWarning: travelerWarning,
    trekMemberAddWarning: memberAddWarning,
    trekError: trekError,
    extractionError: extractionError,
    notifySubject: notifySubject,
    notifyText: notifyText,
  }),
}
