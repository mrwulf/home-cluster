const item = $("Code in JavaScript").first().json
const allExtractions = $input.all()
const MAX_PER_PDF = 4000
const MAX_TOTAL_PDF_TEXT = 12000
const pdfTexts = allExtractions
  .map(function (inp) {
    const j = inp.json || {}
    return (j.text || j.data || "").toString().trim().slice(0, MAX_PER_PDF)
  })
  .filter(function (t) {
    return t.length > 0
  })
const pdfText = pdfTexts
  .join("\n\n--- next attached PDF ---\n\n")
  .slice(0, MAX_TOTAL_PDF_TEXT)
const pdfAttachmentCount = item.pdfAttachmentCount || 0
const pdfExtractionWarning =
  pdfAttachmentCount > 0 && pdfTexts.length < pdfAttachmentCount
    ? pdfTexts.length +
      " of " +
      pdfAttachmentCount +
      " attached PDF(s) had no extractable text (likely a scanned image with no text layer) - double-check the extraction below."
    : null

const emailText =
  "From: " +
  (item.mimeFrom || "") +
  "\nSubject: " +
  (item.subject || "") +
  "\n\n" +
  (item.bodyPreview || "") +
  (pdfText
    ? "\n\n--- Attached PDF itinerary (text extract) ---\n" + pdfText
    : "")
const systemPrompt =
  'You extract structured travel booking data from an email, optionally with an attached PDF itinerary appended after it. Return null for any field not present in the source - never invent data.\n\nbooking_type classification, in order of precedence:\n- flight: has an airline name, a flight number, or a departure/arrival airport.\n- lodging: has a hotel, resort, Airbnb, or check-in/check-out date - even if it also mentions a city or airport nearby.\n- cruise: a cruise line booking (Royal Caribbean, Carnival, etc), usually multi-day with several ports of call.\n- rental_car: a car rental agency (Hertz, Avis, Enterprise, etc).\n- transit: ground or short-hop water transport between cities that is NOT a flight, rental car, or cruise - train, bus, ferry.\n- restaurant: a dining reservation.\n- activity: a tour, ticket, or event booking.\n- general: anything else, including newsletters and emails with no booking details.\n\nIATA or station codes go in the _code fields; the human-readable name goes in the _name fields. For lodging, destination_name/destination_code refer to the hotel\'s city, not the hotel itself - the hotel name goes in provider_name. Dates must be ISO-8601 (YYYY-MM-DDTHH:mm:ss) when a date is present in the source; if only a date with no time is given, use T00:00:00. If a year is not stated, infer it from context (e.g. a date later than any date already mentioned) rather than defaulting to the current year.\n\nFor lodging bookings, capture any room type, bed configuration, or smoking preference mentioned in the source (e.g. "2 Queen Beds, Non-Smoking") in the notes field - never invent one if it is not stated.\n\nFor cruise bookings: start_datetime/end_datetime are the embarkation/disembarkation date and time. Populate the stops array with every port of call in visit order, including embarkation and disembarkation as the first and last entries - skip pure sea/cruising days that have no port. Each stop needs a name and a date (YYYY-MM-DD). For all other booking types, leave stops empty.\n\ntotal_amount is the single total amount actually charged or due for this booking (the number next to "Total", "Amount Charged", "Grand Total", or similar) - never a per-night/per-person rate, a subtotal before taxes/fees, a "starting from" marketing price, or a loyalty-points value. Leave it null if no total is stated. currency is the ISO-4217 3-letter code for that amount, inferred from a currency symbol or code in the source ($/USD, €/EUR, £/GBP, etc) - null if total_amount is null or the currency cannot be determined.\n\nflight_number is the airline\'s own flight number(s) for a flight booking (e.g. "6550"; for a multi-leg itinerary list each leg\'s number in order joined by " / ", e.g. "6550 / 3245") - null for every other booking_type.\n\nWhen more than one reference number appears in the source (e.g. both an airline confirmation code and a travel agency/OTA itinerary number), confirmation_code is the airline or provider\'s own confirmation code, never the agency\'s itinerary number - mention any additional itinerary/booking number in notes instead of discarding it.\n\npassenger_names is every traveler explicitly named in the booking (e.g. "Passenger: Jane Doe", a list of travelers on a multi-person itinerary) - an empty array if no name is stated, never invent one.'
// Flight-specific rules live in their own block (rather than inline above) so the
// per-leg contract is easy to find. Without it a 4B model collapses a round trip
// into ONE booking (outbound departure -> return arrival), which is how the first
// real forward (an airline round trip) lost its return flight, every arrival
// time, and both seat assignments.
const flightPrompt =
  '\n\nFor flight bookings, flight_legs lists EVERY individual flight in the source - one entry per flight number, in chronological order, INCLUDING the return flight of a round trip. Never merge an outbound and a return flight, and never merge a connection into one entry. Each entry: airline, flight_number (e.g. "AS 24"), from_code/to_code (IATA), from_name/to_name (city), dep_datetime and arr_datetime (ISO-8601, local time at that airport, using the date printed for THAT flight), aircraft (the aircraft type exactly as printed for that flight, e.g. "Boeing 737 MAX 9", without trailing words like "Passenger" - null if not shown), seats (one {traveler, seat, fare_class} per traveler on THAT flight, e.g. {"traveler": "Pat Lee", "seat": "12C", "fare_class": "Y COACH"} - an empty array if no seats are shown), and notes (anything else worth keeping about that flight - null if none). tickets lists every e-ticket number in the source as {traveler, number}, using the traveler name printed next to the ticket - an empty array if none is shown. Set start_datetime/origin_* from the first leg and end_datetime/destination_* from the last leg. total_amount is the grand total for the whole confirmation (all flights and travelers together), not a per-person or per-leg figure. For non-flight bookings flight_legs is an empty array.'
const fullSystemPrompt = systemPrompt + flightPrompt
const schema = {
  type: "object",
  properties: {
    booking_type: {
      type: "string",
      enum: [
        "flight",
        "lodging",
        "rental_car",
        "transit",
        "cruise",
        "restaurant",
        "activity",
        "general",
      ],
    },
    confirmation_code: { type: ["string", "null"] },
    provider_name: { type: ["string", "null"] },
    start_datetime: { type: ["string", "null"] },
    end_datetime: { type: ["string", "null"] },
    origin_name: { type: ["string", "null"] },
    origin_code: { type: ["string", "null"] },
    destination_name: { type: ["string", "null"] },
    destination_code: { type: ["string", "null"] },
    stops: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          date: { type: ["string", "null"] },
        },
        required: ["name"],
      },
    },
    notes: { type: ["string", "null"] },
    total_amount: { type: ["number", "null"] },
    currency: { type: ["string", "null"] },
    passenger_names: { type: "array", items: { type: "string" } },
    flight_number: { type: ["string", "null"] },
    tickets: {
      type: "array",
      items: {
        type: "object",
        properties: {
          traveler: { type: "string" },
          number: { type: "string" },
        },
        required: ["traveler", "number"],
      },
    },
    flight_legs: {
      type: "array",
      items: {
        type: "object",
        properties: {
          airline: { type: ["string", "null"] },
          flight_number: { type: ["string", "null"] },
          from_code: { type: ["string", "null"] },
          from_name: { type: ["string", "null"] },
          to_code: { type: ["string", "null"] },
          to_name: { type: ["string", "null"] },
          dep_datetime: { type: ["string", "null"] },
          arr_datetime: { type: ["string", "null"] },
          aircraft: { type: ["string", "null"] },
          seats: {
            type: "array",
            items: {
              type: "object",
              properties: {
                traveler: { type: "string" },
                seat: { type: "string" },
                fare_class: { type: ["string", "null"] },
              },
              required: ["traveler", "seat"],
            },
          },
          notes: { type: ["string", "null"] },
        },
        required: [
          "flight_number",
          "from_code",
          "from_name",
          "to_code",
          "to_name",
          "dep_datetime",
        ],
      },
    },
  },
  required: ["booking_type"],
}
const exampleEmail =
  "From: jane@example.com\nSubject: Your Hilton Reservation - Confirmation HH1234\n\nThank you for booking the Hilton Garden Inn Austin Downtown.\n\nConfirmation Number: HH1234\nCheck-in: June 3, 2027\nCheck-out: June 5, 2027\nTotal Charged: $450.50"
const exampleAnswer = JSON.stringify({
  booking_type: "lodging",
  confirmation_code: "HH1234",
  provider_name: "Hilton Garden Inn Austin Downtown",
  start_datetime: "2027-06-03T00:00:00",
  end_datetime: "2027-06-05T00:00:00",
  origin_name: null,
  origin_code: null,
  destination_name: "Austin",
  destination_code: null,
  stops: [],
  notes: null,
  total_amount: 450.5,
  currency: "USD",
  passenger_names: [],
  flight_number: null,
  flight_legs: [],
})
const cruiseExample =
  "From: agent@example.com\nSubject: Your Cruise Confirmation - ABC999\n\n--- Attached PDF itinerary (text extract) ---\nCruise Confirmation\nConfirmation: ABC999\nRoyal Caribbean\nEmbark: May 1, 2028\nDisembark: May 5, 2028\nDay 1: Miami, Florida - May 1, 2028 | Depart 06:00 PM\nDay 2: Cruising - May 2, 2028\nDay 3: Nassau, Bahamas - May 3, 2028 | 08:00 AM To 05:00 PM\nDay 4: CocoCay, Bahamas - May 4, 2028 | 08:00 AM To 04:00 PM\nDay 5: Miami, Florida - May 5, 2028 | Arrive 06:00 AM"
const cruiseAnswer = JSON.stringify({
  booking_type: "cruise",
  confirmation_code: "ABC999",
  provider_name: "Royal Caribbean",
  start_datetime: "2028-05-01T18:00:00",
  end_datetime: "2028-05-05T06:00:00",
  origin_name: null,
  origin_code: null,
  destination_name: null,
  destination_code: null,
  stops: [
    { name: "Miami, Florida", date: "2028-05-01" },
    { name: "Nassau, Bahamas", date: "2028-05-03" },
    { name: "CocoCay, Bahamas", date: "2028-05-04" },
    { name: "Miami, Florida", date: "2028-05-05" },
  ],
  notes: null,
  total_amount: null,
  currency: null,
  passenger_names: [],
  flight_number: null,
  flight_legs: [],
})
const flightExample =
  "From: sam@example.com\nSubject: Fwd: Your trip is confirmed - ZX81QP\n\nConfirmation code: ZX81QP\nFlight 1 - Mon Mar 2\nSkyJet SJ 410 - Airbus A320\nAUS  DEN\nAustin  Denver\n8:15 AM  9:50 AM\nTraveler: Pat Lee - Seat 12C - Class: Y\nFlight 2 - Fri Mar 6\nSkyJet SJ 733 - Boeing 737-800\nDEN  AUS\nDenver  Austin\n2:05 PM  5:40 PM\nTraveler: Pat Lee - Seat 9A - Class: Y\nPat Lee - Ticket 0011234567890\nTotal charges for air travel $512.30"
const flightAnswer = JSON.stringify({
  booking_type: "flight",
  confirmation_code: "ZX81QP",
  provider_name: "SkyJet",
  start_datetime: "2027-03-02T08:15:00",
  end_datetime: "2027-03-06T17:40:00",
  origin_name: "Austin",
  origin_code: "AUS",
  destination_name: "Austin",
  destination_code: "AUS",
  stops: [],
  notes: null,
  total_amount: 512.3,
  currency: "USD",
  passenger_names: ["Pat Lee"],
  flight_number: "SJ 410 / SJ 733",
  tickets: [{ traveler: "Pat Lee", number: "0011234567890" }],
  flight_legs: [
    {
      airline: "SkyJet",
      flight_number: "SJ 410",
      from_code: "AUS",
      from_name: "Austin",
      to_code: "DEN",
      to_name: "Denver",
      dep_datetime: "2027-03-02T08:15:00",
      arr_datetime: "2027-03-02T09:50:00",
      aircraft: "Airbus A320",
      seats: [{ traveler: "Pat Lee", seat: "12C", fare_class: "Y" }],
      notes: null,
    },
    {
      airline: "SkyJet",
      flight_number: "SJ 733",
      from_code: "DEN",
      from_name: "Denver",
      to_code: "AUS",
      to_name: "Austin",
      dep_datetime: "2027-03-06T14:05:00",
      arr_datetime: "2027-03-06T17:40:00",
      aircraft: "Boeing 737-800",
      seats: [{ traveler: "Pat Lee", seat: "9A", fare_class: "Y" }],
      notes: null,
    },
  ],
})
const helpers = this.helpers

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

async function callOllamaExtract(promptEmailText) {
  let extracted = null
  let extractionError = null
  try {
    const response = await withRetry(
      function () {
        return helpers.httpRequest({
          method: "POST",
          url: "http://ollama.ai.svc.cluster.local:11434/api/chat",
          body: {
            model: "qwen3.5:4b",
            messages: [
              { role: "system", content: fullSystemPrompt },
              { role: "user", content: exampleEmail },
              { role: "assistant", content: exampleAnswer },
              { role: "user", content: cruiseExample },
              { role: "assistant", content: cruiseAnswer },
              { role: "user", content: flightExample },
              { role: "assistant", content: flightAnswer },
              { role: "user", content: promptEmailText },
            ],
            stream: false,
            // qwen3.5 thinks by default; with a 240s timeout that runs out before
            // the answer arrives (~10 tok/s). Extraction needs no reasoning trace.
            // The cap bounds a runaway generation (observed >2800 tokens).
            think: false,
            options: { temperature: 0, num_predict: 3000 },
            format: schema,
          },
          json: true,
          timeout: 240000,
        })
      },
      3,
      2000
    )
    try {
      extracted = JSON.parse(response.message.content)
    } catch (e) {
      extracted = { booking_type: "general", parse_error: String(e) }
    }

    const knownBookingTypes = schema.properties.booking_type.enum
    let validationError = null
    if (extracted.parse_error) {
      validationError =
        "Ollama response was not valid JSON: " + extracted.parse_error
    } else if (
      !extracted.booking_type ||
      knownBookingTypes.indexOf(extracted.booking_type) === -1
    ) {
      validationError =
        "Ollama returned an unrecognized booking_type: " +
        JSON.stringify(extracted.booking_type)
    } else if (
      extracted.start_datetime &&
      isNaN(new Date(extracted.start_datetime).getTime())
    ) {
      validationError =
        "Ollama returned an unparseable start_datetime: " +
        JSON.stringify(extracted.start_datetime)
    } else if (
      extracted.end_datetime &&
      isNaN(new Date(extracted.end_datetime).getTime())
    ) {
      validationError =
        "Ollama returned an unparseable end_datetime: " +
        JSON.stringify(extracted.end_datetime)
    }
    if (!validationError && extracted.total_amount != null) {
      if (
        typeof extracted.total_amount !== "number" ||
        !(extracted.total_amount > 0)
      ) {
        extracted.total_amount = null
        extracted.currency = null
      } else if (
        extracted.currency != null &&
        !/^[A-Za-z]{3}$/.test(extracted.currency)
      ) {
        extracted.currency = null
      } else if (extracted.currency) {
        extracted.currency = extracted.currency.toUpperCase()
      }
    }
    if (validationError) {
      extractionError = validationError
    }
  } catch (e) {
    extractionError = "Ollama extraction failed: " + (e.message || String(e))
  }
  return { extracted: extracted, extractionError: extractionError }
}

// docs/trip_ingest_kitinerary_integration_spec.md §4/§3.1: if 'Kitinerary
// Extract' already produced usable, deterministic results from the same
// email, use those instead of the full Ollama call - one output item per
// mapped reservation (connecting flight legs are already grouped into one
// item upstream), which Trek Resolve (mode: runOnceForEachItem) turns into
// one Trek booking each. Falls through to the single full Ollama call below
// only when kitinerary found nothing usable at all.
const kitineraryItem = $("Kitinerary Extract").first().json
const kitineraryItems =
  (kitineraryItem && kitineraryItem.kitineraryExtractedItems) || []

if (kitineraryItems.length > 0) {
  // kitinerary can't structurally extract multi-port cruise itineraries
  // (schema.org BoatReservation carries no per-port stops) - Ollama already
  // does this well on the pure-Ollama path via the cruise few-shot example
  // above, so make one targeted supplementary call per cruise item missing
  // stops, keeping every other kitinerary-derived field (dates, confirmation
  // code, amount) as the deterministic source of truth. A blanket "always
  // also ask Ollama" call for every kitinerary match was considered and
  // rejected - it would reintroduce LLM latency and hallucination risk on
  // the common case (lodging/flight) kitinerary already handles completely.
  for (const mapped of kitineraryItems) {
    if (mapped.booking_type === "cruise" && mapped.stops.length === 0) {
      const enrichment = await callOllamaExtract(emailText)
      const enrichedStops =
        !enrichment.extractionError &&
        enrichment.extracted &&
        Array.isArray(enrichment.extracted.stops)
          ? enrichment.extracted.stops
          : []
      if (enrichedStops.length > 0) {
        mapped.stops = enrichedStops
      }
    }
  }
  const kitinerarySpan = withTripSpan(kitineraryItems)
  return kitineraryItems.map(function (mapped) {
    return {
      json: Object.assign({}, item, kitinerarySpan, {
        extracted: mapped,
        extractionError: null,
        pdfExtractionWarning: pdfExtractionWarning,
        kitineraryWarning: kitineraryItem.kitineraryWarning || null,
      }),
    }
  })
}

// One flight_legs entry per physical flight -> same grouping rule as 'Kitinerary
// Extract' groupFlightLegs (n8n Code nodes can't share modules, so the rule is
// repeated rather than imported): a leg that departs the airport the previous leg
// arrived at, within 24h, is a connection and stays in the same booking; anything
// else (e.g. the return half of a round trip) is its own booking. Output matches
// that node's mapFlightGroup shape so Trek Resolve needs no flight-specific path.
function isIata(c) {
  return typeof c === "string" && /^[A-Za-z]{3}$/.test(c.trim())
}
function hhmm(iso) {
  return iso && iso.length >= 16 ? iso.slice(11, 16) : null
}
function utcDay(iso) {
  const d = iso ? new Date(iso) : null
  return d && !isNaN(d.getTime()) ? d.toISOString().slice(0, 10) : null
}
function expandFlightLegs(ex) {
  const legs = (ex.flight_legs || [])
    .filter(function (l) {
      return (
        l &&
        isIata(l.from_code) &&
        isIata(l.to_code) &&
        l.dep_datetime &&
        !isNaN(new Date(l.dep_datetime).getTime())
      )
    })
    .map(function (l) {
      return Object.assign({}, l, {
        from_code: l.from_code.trim().toUpperCase(),
        to_code: l.to_code.trim().toUpperCase(),
        arr_datetime:
          l.arr_datetime && !isNaN(new Date(l.arr_datetime).getTime())
            ? l.arr_datetime
            : null,
      })
    })
    .sort(function (a, b) {
      return new Date(a.dep_datetime) - new Date(b.dep_datetime)
    })
  if (legs.length === 0) return null
  const groups = [[legs[0]]]
  for (const leg of legs.slice(1)) {
    const cur = groups[groups.length - 1]
    const prev = cur[cur.length - 1]
    const gap = prev.arr_datetime
      ? new Date(leg.dep_datetime) - new Date(prev.arr_datetime)
      : null
    if (
      prev.to_code === leg.from_code &&
      gap != null &&
      gap >= 0 &&
      gap < 24 * 60 * 60 * 1000
    ) {
      cur.push(leg)
    } else {
      groups.push([leg])
    }
  }
  return groups.map(function (group, gi) {
    const first = group[0]
    const last = group[group.length - 1]
    const nums = group
      .map(function (l) {
        return l.flight_number
      })
      .filter(Boolean)
    const airlines = []
    for (const l of group) {
      if (l.airline && airlines.indexOf(l.airline) === -1)
        airlines.push(l.airline)
    }
    const noteParts = []
    for (const l of group) {
      // "AS 24 (Boeing 737 MAX 9): <seats, fare class>" - aircraft is its own
      // schema field so it is composed here rather than left to the model's prose.
      const label =
        (l.flight_number || "") + (l.aircraft ? " (" + l.aircraft + ")" : "")
      const seatText = (l.seats || [])
        .filter(function (x) {
          return x && x.seat
        })
        .map(function (x) {
          return (
            x.traveler +
            " " +
            x.seat +
            (x.fare_class ? " (" + x.fare_class + ")" : "")
          )
        })
        .join(", ")
      const detail = [seatText, l.notes].filter(Boolean).join("; ")
      if (label && detail) noteParts.push(label + ": " + detail)
      else if (label || detail) noteParts.push(label || detail)
    }
    // E-ticket numbers belong to the traveler, not a flight, so every booking on
    // the confirmation carries the full list (needed at check-in either way).
    const tickets = (ex.tickets || []).filter(function (t) {
      return t && /^[0-9A-Za-z-]{6,}$/.test(String(t.number || "").trim())
    })
    if (tickets.length) {
      noteParts.push(
        "Tickets: " +
          tickets
            .map(function (t) {
              return (t.traveler ? t.traveler + " " : "") + t.number.trim()
            })
            .join("; ")
      )
    }
    if (gi > 0 && ex.total_amount != null) {
      noteParts.push(
        "Fare for the whole confirmation is recorded on the first flight booking."
      )
    }
    return Object.assign({}, ex, {
      booking_type: "flight",
      provider_name: airlines.length ? airlines.join(" / ") : ex.provider_name,
      flight_number: nums.length ? nums.join(" / ") : null,
      start_datetime: first.dep_datetime,
      end_datetime: last.arr_datetime || first.dep_datetime,
      origin_code: first.from_code,
      origin_name: first.from_name || first.from_code,
      destination_code: last.to_code,
      destination_name: last.to_name || last.to_code,
      stops: group.slice(0, -1).map(function (l) {
        return {
          name: l.to_name || l.to_code,
          code: l.to_code,
          date: l.arr_datetime ? l.arr_datetime.slice(0, 10) : null,
        }
      }),
      leg_details:
        group.length > 1
          ? group.map(function (l) {
              return {
                from: l.from_code,
                to: l.to_code,
                airline: l.airline || null,
                flight_number: l.flight_number || null,
                dep_time: hhmm(l.dep_datetime),
                arr_time: hhmm(l.arr_datetime),
                dep_date: utcDay(l.dep_datetime),
                arr_date: utcDay(l.arr_datetime),
              }
            })
          : [],
      notes: noteParts.length ? noteParts.join("\n") : null,
      // The total covers every flight on the confirmation, so it is recorded once,
      // on the first booking, rather than duplicated into the budget per flight.
      total_amount: gi === 0 ? ex.total_amount : null,
      currency: gi === 0 ? ex.currency : null,
      flight_legs: undefined,
      tickets: undefined,
    })
  })
}

// Every item from one email belongs to ONE trip. Trek Resolve matches a booking to
// a trip by its own start date (+/-1 day), so without this a round trip's return
// flight (weeks after the outbound) found no trip and spawned a second one.
// Trek Resolve widens the matched/created trip to this span.
function withTripSpan(items) {
  let spanStart = null
  let spanEnd = null
  for (const m of items) {
    for (const d of [utcDay(m.start_datetime), utcDay(m.end_datetime)]) {
      if (!d) continue
      if (!spanStart || d < spanStart) spanStart = d
      if (!spanEnd || d > spanEnd) spanEnd = d
    }
  }
  return { tripSpanStart: spanStart, tripSpanEnd: spanEnd }
}

const result = await callOllamaExtract(emailText)
const expanded =
  !result.extractionError &&
  result.extracted &&
  result.extracted.booking_type === "flight"
    ? expandFlightLegs(result.extracted)
    : null
const ollamaItems = expanded || [result.extracted]
const ollamaSpan = expanded ? withTripSpan(expanded) : {}
return ollamaItems.map(function (extracted) {
  return {
    json: Object.assign({}, item, ollamaSpan, {
      extracted: extracted,
      extractionError: result.extractionError,
      pdfExtractionWarning: pdfExtractionWarning,
    }),
  }
})
