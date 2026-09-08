const item = $input.first()
const headers = item.json.headers || {}
const providedSecret = headers["x-trip-ingest-secret"]
const expectedSecret = $env.TRIP_INGEST_SHARED_SECRET
const secretValid = Boolean(expectedSecret) && providedSecret === expectedSecret

let rawBody = ""
let rawEmailBase64 = null
if (item.binary && item.binary.data) {
  const buffer = await this.helpers.getBinaryDataBuffer(0, "data")
  rawBody = buffer.toString("utf-8")
  rawEmailBase64 = buffer.toString("base64")
}

const fromMatch = rawBody.match(/^From:\s*(.+)$/im)
const subjectMatch = rawBody.match(/^Subject:\s*(.+)$/im)
const topContentTypeMatch = rawBody.match(
  /^Content-Type:\s*([^\r\n]+(?:\r?\n[ \t][^\r\n]+)*)/im
)

function decodeQuotedPrintable(str) {
  return str
    .replace(/=\r?\n/g, "")
    .replace(/=([0-9A-Fa-f]{2})/g, function (_, hex) {
      return String.fromCharCode(parseInt(hex, 16))
    })
}

function parseHeaders(block) {
  const result = {}
  const lines = block.split(/\r?\n/)
  let lastKey = null
  for (const line of lines) {
    if (/^[ \t]/.test(line) && lastKey) {
      result[lastKey] += " " + line.trim()
      continue
    }
    const m = line.match(/^([^:]+):\s*(.*)$/)
    if (m) {
      lastKey = m[1].toLowerCase()
      result[lastKey] = m[2]
    }
  }
  return result
}

function getBoundary(contentType) {
  const m = contentType && contentType.match(/boundary="?([^";]+)"?/i)
  return m ? m[1] : null
}

function splitParts(body, boundary) {
  const delim = "--" + boundary
  const pieces = body.split(delim)
  return pieces.slice(1, -1).map(function (p) {
    return p.replace(/^\r?\n/, "")
  })
}

function splitHeaderBody(part) {
  const idx = part.search(/\r?\n\r?\n/)
  if (idx === -1) return { headerBlock: part, bodyBlock: "" }
  const sepMatch = part.slice(idx).match(/^\r?\n\r?\n/)
  return {
    headerBlock: part.slice(0, idx),
    bodyBlock: part.slice(idx + sepMatch[0].length),
  }
}

function walkMime(headerBlock, bodyBlock, collector) {
  const partHeaders = parseHeaders(headerBlock)
  const contentType = partHeaders["content-type"] || "text/plain"
  const boundary = getBoundary(contentType)
  if (boundary) {
    const parts = splitParts(bodyBlock, boundary)
    for (const part of parts) {
      const split = splitHeaderBody(part)
      walkMime(split.headerBlock, split.bodyBlock, collector)
    }
    return
  }
  if (/^message\/rfc822/i.test(contentType)) {
    // A forwarded-as-attachment email: bodyBlock is itself a complete raw email
    // (headers + body), not attachment content - recurse into it directly.
    const nested = splitHeaderBody(bodyBlock)
    walkMime(nested.headerBlock, nested.bodyBlock, collector)
    return
  }
  const encoding = (
    partHeaders["content-transfer-encoding"] || ""
  ).toLowerCase()
  const disposition = partHeaders["content-disposition"] || ""
  const isAttachment =
    /attachment/i.test(disposition) || /^application\//i.test(contentType)
  if (isAttachment) {
    const filenameMatch =
      disposition.match(/filename="?([^";]+)"?/i) ||
      contentType.match(/name="?([^";]+)"?/i)
    collector.attachments.push({
      contentType: contentType,
      filename: filenameMatch ? filenameMatch[1] : "attachment",
      encoding: encoding,
      raw: bodyBlock,
    })
    return
  }
  let decoded = bodyBlock
  if (encoding === "quoted-printable") {
    decoded = decodeQuotedPrintable(bodyBlock)
  } else if (encoding === "base64") {
    decoded = Buffer.from(bodyBlock.replace(/\r?\n/g, ""), "base64").toString(
      "utf-8"
    )
  }
  if (/^text\/plain/i.test(contentType)) {
    collector.textPlainParts.push(decoded)
  } else if (/^text\/html/i.test(contentType)) {
    collector.textHtmlParts.push(decoded)
  }
}

const collector = { textPlainParts: [], textHtmlParts: [], attachments: [] }

if (topContentTypeMatch && /multipart\//i.test(topContentTypeMatch[1])) {
  const split = splitHeaderBody(rawBody)
  walkMime(split.headerBlock, split.bodyBlock, collector)
} else {
  const split = splitHeaderBody(rawBody)
  collector.textPlainParts.push(split.bodyBlock || rawBody)
}

const bodyText = (
  collector.textPlainParts.length
    ? collector.textPlainParts
    : collector.textHtmlParts
).join("\n\n---\n\n")
const pdfAttachments = collector.attachments.filter(function (a) {
  return /pdf/i.test(a.contentType) || /\.pdf$/i.test(a.filename)
})

// Some ESPs (confirmed: Expedia's flight-purchase-confirmation template) pad the
// text/plain part with hundreds of bytes of zero-width-joiner/non-joiner entities
// as an anti-preview-scraping technique. Left in, that junk eats a big chunk of
// the slice(0, N) budget below before any real content is reached, pushing later
// real fields (e.g. a "Total paid" line) past the cutoff entirely - strip both the
// literal HTML-entity and actual unicode forms, and collapse the whitespace runs
// the stripped entities leave behind, before truncating.
function stripZeroWidthJunk(text) {
  return text
    .replace(/&(?:zwnj|zwj|#8203|#8204|#8205|#65279|#x200[BCD]|#xFEFF);/gi, "")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
}
const cleanedBodyText = stripZeroWidthJunk(bodyText)

const sharedJson = {
  secretValid: secretValid,
  envelopeFrom: headers["x-envelope-from"] || null,
  mimeFrom: fromMatch ? fromMatch[1].trim() : null,
  subject: subjectMatch ? subjectMatch[1].trim() : null,
  // Raised from 3000: real-world confirmation emails routinely run long once
  // junk padding is stripped, and the PDF budget below (4000/attachment, 12000
  // combined) was already far more generous than the primary email body's.
  bodyPreview: cleanedBodyText.slice(0, 6000),
  hasPdfAttachment: pdfAttachments.length > 0,
  pdfAttachmentCount: pdfAttachments.length,
  // Full raw email (headers + body, all MIME parts), forwarded so 'Kitinerary
  // Extract' can hand it to kitinerary-extractor as a .eml file - bodyPreview
  // above is plain-text-preferring and truncated, so it can't be reused for
  // that (the schema.org JSON-LD kitinerary looks for usually only exists in
  // the text/html MIME part). Reuses the same buffer already fetched above -
  // no extra binary-data lookup.
  rawEmailBase64: rawEmailBase64,
}

if (pdfAttachments.length === 0) {
  return [{ json: sharedJson }]
}

const outputItems = []
for (const pdfAttachment of pdfAttachments) {
  const pdfBuffer = Buffer.from(
    pdfAttachment.raw.replace(/\r?\n/g, ""),
    "base64"
  )
  outputItems.push({
    json: Object.assign({}, sharedJson, {
      pdfFilename: pdfAttachment.filename,
    }),
    binary: {
      attachment: await this.helpers.prepareBinaryData(
        pdfBuffer,
        pdfAttachment.filename,
        "application/pdf"
      ),
    },
  })
}
return outputItems
