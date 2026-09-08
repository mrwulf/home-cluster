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
            model: "mistral:latest",
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: exampleEmail },
              { role: "assistant", content: exampleAnswer },
              { role: "user", content: cruiseExample },
              { role: "assistant", content: cruiseAnswer },
              { role: "user", content: promptEmailText },
            ],
            stream: false,
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
  return kitineraryItems.map(function (mapped) {
    return {
      json: Object.assign({}, item, {
        extracted: mapped,
        extractionError: null,
        pdfExtractionWarning: pdfExtractionWarning,
        kitineraryWarning: kitineraryItem.kitineraryWarning || null,
      }),
    }
  })
}

const result = await callOllamaExtract(emailText)
return [
  {
    json: Object.assign({}, item, {
      extracted: result.extracted,
      extractionError: result.extractionError,
      pdfExtractionWarning: pdfExtractionWarning,
    }),
  },
]
