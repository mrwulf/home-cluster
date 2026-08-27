import { connect } from "cloudflare:sockets"

async function sendEmailViaSMTP(env, from, to, subject, body) {
  let socket
  let writer
  let reader

  try {
    socket = connect(
      {
        hostname: env.SMTP_SERVER,
        port: 465,
      },
      {
        secureTransport: "on",
      }
    )

    writer = socket.writable.getWriter()
    reader = socket.readable.getReader()
    const decoder = new TextDecoder()
    const encoder = new TextEncoder()

    let buffer = ""

    async function readLine() {
      while (!buffer.includes("\n")) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value)
      }
      const index = buffer.indexOf("\n")
      if (index === -1) return ""
      const line = buffer.substring(0, index + 1)
      buffer = buffer.substring(index + 1)
      return line
    }

    async function write(data) {
      await writer.write(encoder.encode(data))
    }

    // Read greeting
    let line = await readLine()
    if (!line.startsWith("220"))
      throw new Error("Invalid SMTP greeting: " + line)

    // EHLO
    await write("EHLO localhost\r\n")
    while (true) {
      line = await readLine()
      if (line.startsWith("250 ")) break
      if (!line.startsWith("250-")) throw new Error("EHLO failed: " + line)
    }

    // AUTH PLAIN
    const authString = btoa(`\0${env.SMTP_USERNAME}\0${env.SMTP_PASSWORD}`)
    await write(`AUTH PLAIN ${authString}\r\n`)
    line = await readLine()
    if (!line.startsWith("235")) throw new Error("SMTP AUTH failed: " + line)

    // MAIL FROM
    await write(`MAIL FROM:<${from}>\r\n`)
    line = await readLine()
    if (!line.startsWith("250")) throw new Error("MAIL FROM failed: " + line)

    // RCPT TO
    await write(`RCPT TO:<${to}>\r\n`)
    line = await readLine()
    if (!line.startsWith("250")) throw new Error("RCPT TO failed: " + line)

    // DATA
    await write("DATA\r\n")
    line = await readLine()
    if (!line.startsWith("354")) throw new Error("DATA start failed: " + line)

    // Write message
    const msg =
      [
        `From: <${from}>`,
        `To: <${to}>`,
        `Subject: ${subject}`,
        `Content-Type: text/plain; charset=UTF-8`,
        `Date: ${new Date().toUTCString()}`,
        `Message-ID: <${Date.now()}@${from.split("@")[1]}>`,
        "",
        body,
        ".",
      ].join("\r\n") + "\r\n"
    await write(msg)
    line = await readLine()
    if (!line.startsWith("250")) throw new Error("DATA send failed: " + line)

    // QUIT
    await write("QUIT\r\n")
    console.log("Email sent successfully via SMTP!")
  } catch (err) {
    console.error("SMTP Error:", err)
  } finally {
    try {
      if (writer) writer.releaseLock()
      if (reader) reader.releaseLock()
    } catch (_) {}
    if (socket) {
      try {
        await socket.close()
      } catch (_) {}
    }
  }
}

async function probeHost(host, maxProbes = 3) {
  let isUp = false
  let lastError = null
  let lastStatus = null
  const attempts = []

  for (let attempt = 1; attempt <= maxProbes; attempt++) {
    console.log(
      `Probing direct endpoint https://${host} (attempt ${attempt}/${maxProbes})...`
    )
    const startTime = Date.now()
    try {
      const res = await fetch(`https://${host}`, {
        method: "HEAD",
        headers: {
          "User-Agent": "Cloudflare-Worker-Failover-Monitor/1.0",
        },
        signal: AbortSignal.timeout(5000),
      })
      const duration = Date.now() - startTime
      lastStatus = res.status
      const attemptLog = `Probe attempt ${attempt} for ${host}: Finished in ${duration}ms with status code ${res.status}`
      console.log(attemptLog)
      attempts.push(attemptLog)

      if (res.status < 500) {
        isUp = true
        break
      } else {
        lastError = `HTTP Status ${res.status}`
      }
    } catch (err) {
      const duration = Date.now() - startTime
      lastStatus = null
      lastError =
        err instanceof Error ? `${err.name}: ${err.message}` : String(err)
      const attemptLog = `Probe attempt ${attempt} for ${host}: Failed in ${duration}ms. Error: ${lastError}`
      console.error(attemptLog)
      attempts.push(attemptLog)
    }

    if (attempt < maxProbes) {
      await new Promise((resolve) => setTimeout(resolve, 1500))
    }
  }

  return { isUp, lastStatus, lastError, attempts }
}

export default {
  async scheduled(event, env, ctx) {
    const VPS_US_HOST = env.VPS_US_HOST
    const VPS_EU_HOST = env.VPS_EU_HOST
    const RECORD_NAME = env.RECORD_NAME
    const SECRET_DOMAIN = RECORD_NAME.replace(/^ingress\./, "")
    const PROXY_CNAME = env.PROXY_CNAME || `proxy.${SECRET_DOMAIN}`
    const TUNNEL_CNAME = env.TUNNEL_CNAME || `external.${SECRET_DOMAIN}`
    const ZONE_ID = env.CLOUDFLARE_ZONE_ID
    const RECORD_ID = env.CLOUDFLARE_RECORD_ID
    const API_TOKEN = env.CLOUDFLARE_API_TOKEN

    const fromEmail = `failover-monitor@${SECRET_DOMAIN}`
    const toEmail = `postmaster@${SECRET_DOMAIN}`

    const allProbeLogs = []
    let targetContent = null
    let targetTier = null
    let isProxied = false

    // 1. Probe Tier 1: US VPS (OVHcloud)
    const usProbe = await probeHost(VPS_US_HOST)
    allProbeLogs.push(...usProbe.attempts)

    if (usProbe.isUp) {
      targetContent = PROXY_CNAME
      targetTier = "US Region (OVHcloud VPS / Proxy)"
      isProxied = false
      console.log(
        `US VPS (${VPS_US_HOST}) is healthy. Routing to ${PROXY_CNAME}.`
      )
    } else {
      console.warn(
        `US VPS (${VPS_US_HOST}) is UNHEALTHY. Probing EU VPS (${VPS_EU_HOST})...`
      )

      // 2. Probe Tier 2: EU VPS (Hetzner)
      const euProbe = await probeHost(VPS_EU_HOST)
      allProbeLogs.push(...euProbe.attempts)

      if (euProbe.isUp) {
        targetContent = PROXY_CNAME
        targetTier = "EU Region (Hetzner VPS / Proxy)"
        isProxied = false
        console.log(
          `EU VPS (${VPS_EU_HOST}) is healthy. Routing to ${PROXY_CNAME}.`
        )
      } else {
        // 3. Tier 3 Fallback: Cloudflare Tunnel
        targetContent = TUNNEL_CNAME
        targetTier = "Fallback (Cloudflare Tunnel)"
        isProxied = true
        console.error(
          `Both US and EU VPS are UNHEALTHY! Falling back to Cloudflare Tunnel (${TUNNEL_CNAME}).`
        )
      }
    }

    // 4. Query current DNS record
    let currentContent
    const dnsUrl = `https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/dns_records/${RECORD_ID}`
    try {
      console.log(
        `Querying current DNS record for ${RECORD_NAME} (Record ID: ${RECORD_ID})...`
      )
      const dnsRes = await fetch(dnsUrl, {
        headers: { Authorization: `Bearer ${API_TOKEN}` },
        signal: AbortSignal.timeout(5000),
      })
      if (!dnsRes.ok) {
        const errorText = await dnsRes.text()
        throw new Error(`Cloudflare API status ${dnsRes.status}: ${errorText}`)
      }
      const dnsData = await dnsRes.json()
      if (!dnsData.success) {
        throw new Error(
          `Cloudflare API error: ${JSON.stringify(dnsData.errors)}`
        )
      }
      currentContent = dnsData.result.content
      console.log(`Current DNS record content: ${currentContent}`)
    } catch (err) {
      console.error(`Error querying DNS record:`, err)
      return
    }

    // 5. Update if there is a mismatch
    if (currentContent !== targetContent) {
      console.log(
        `Mismatch detected! Current: ${currentContent}, Target: ${targetContent} (${targetTier}). Updating DNS record...`
      )
      try {
        const updateRes = await fetch(dnsUrl, {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${API_TOKEN}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            type: "CNAME",
            content: targetContent,
            proxied: isProxied,
          }),
          signal: AbortSignal.timeout(5000),
        })
        if (!updateRes.ok) {
          const errorText = await updateRes.text()
          console.error(
            `Failed to update DNS record. Status: ${updateRes.status}. Error: ${errorText}`
          )
        } else {
          const updateData = await updateRes.json()
          if (!updateData.success) {
            console.error(
              `Cloudflare API patch succeeded but returned failure: ${JSON.stringify(updateData.errors)}`
            )
          } else {
            console.log(
              `DNS record successfully updated to point to ${targetContent} (proxied: ${isProxied}, Tier: ${targetTier})`
            )

            // Format Subject line with date and hour
            const now = new Date()
            const yyyy = now.getUTCFullYear()
            const mm = String(now.getUTCMonth() + 1).padStart(2, "0")
            const dd = String(now.getUTCDate()).padStart(2, "0")
            const hh = String(now.getUTCHours()).padStart(2, "0")
            const dateStr = `${yyyy}-${mm}-${dd} ${hh}:00 UTC`

            const subject = `[Failover] Ingress DNS Switched to ${targetTier} - ${dateStr}`
            const body = [
              `Failover monitor detected that the ingress DNS record ${RECORD_NAME} was pointing to ${currentContent}, but has been updated to ${targetContent} (${targetTier}).`,
              ``,
              `Action: DNS record updated to a CNAME pointing to ${targetContent} (proxied: ${isProxied}).`,
              ``,
              `=== Diagnostics ===`,
              `Active Tier: ${targetTier}`,
              `Target Host: ${targetContent}`,
              `Previous Host: ${currentContent}`,
              `Timestamp: ${now.toISOString()}`,
              ``,
              `=== Probe Attempts ===`,
              ...allProbeLogs,
            ].join("\r\n")

            ctx.waitUntil(
              sendEmailViaSMTP(env, fromEmail, toEmail, subject, body)
            )
          }
        }
      } catch (err) {
        console.error(`Error updating DNS record:`, err)
      }
    } else {
      console.log(
        `No action required. Ingress target is already aligned with active healthy node (${currentContent} - ${targetTier}).`
      )
    }
  },
}
