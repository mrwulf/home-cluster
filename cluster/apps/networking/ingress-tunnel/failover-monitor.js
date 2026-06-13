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

export default {
  async scheduled(event, env, ctx) {
    const VPS_IP = env.VPS_PUBLIC_IP
    const VPS_DIRECT_HOST = env.VPS_DIRECT_HOST
    const TUNNEL_CNAME = env.TUNNEL_CNAME
    const ZONE_ID = env.CLOUDFLARE_ZONE_ID
    const RECORD_ID = env.CLOUDFLARE_RECORD_ID
    const API_TOKEN = env.CLOUDFLARE_API_TOKEN
    const RECORD_NAME = env.RECORD_NAME

    const SECRET_DOMAIN = RECORD_NAME.replace(/^ingress\./, "")
    const fromEmail = `failover-monitor@${SECRET_DOMAIN}`
    const toEmail = `postmaster@${SECRET_DOMAIN}`

    // 1. Probe the VPS using its direct non-proxied domain (up to 3 attempts with 1.5s pause)
    const maxProbes = 3
    let isVpsUp = false
    let lastProbeError = null
    let lastProbeStatus = null
    const probeAttempts = []

    for (let attempt = 1; attempt <= maxProbes; attempt++) {
      console.log(
        `Probing VPS direct host https://${VPS_DIRECT_HOST} (attempt ${attempt}/${maxProbes})...`
      )
      const startTime = Date.now()
      try {
        const res = await fetch(`https://${VPS_DIRECT_HOST}`, {
          method: "HEAD",
          signal: AbortSignal.timeout(5000),
        })
        const duration = Date.now() - startTime
        lastProbeStatus = res.status
        const attemptLog = `Probe attempt ${attempt}: Finished in ${duration}ms with status code ${res.status}`
        console.log(attemptLog)
        probeAttempts.push(attemptLog)

        if (res.status < 500) {
          isVpsUp = true
          break
        } else {
          lastProbeError = `HTTP Status ${res.status}`
        }
      } catch (err) {
        const duration = Date.now() - startTime
        lastProbeStatus = null
        lastProbeError =
          err instanceof Error ? `${err.name}: ${err.message}` : String(err)
        const attemptLog = `Probe attempt ${attempt}: Failed in ${duration}ms. Error: ${lastProbeError}`
        console.error(attemptLog)
        probeAttempts.push(attemptLog)
      }

      if (attempt < maxProbes) {
        // Wait 1.5 seconds before retrying
        await new Promise((resolve) => setTimeout(resolve, 1500))
      }
    }

    console.log(
      `VPS probe summary: isVpsUp=${isVpsUp} (Last status: ${lastProbeStatus}, Last error: ${lastProbeError || "none"})`
    )

    // 2. Query the current DNS record value with error handling
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
      // Stop execution gracefully to prevent false updates/email spam when Cloudflare is down
      return
    }

    // 3. Determine target state
    const targetContent = isVpsUp ? VPS_DIRECT_HOST : TUNNEL_CNAME

    // 4. Update if there is a mismatch
    if (currentContent !== targetContent) {
      console.log(
        `Mismatch detected! Current: ${currentContent}, Target: ${targetContent}. Updating DNS record...`
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
            proxied: !isVpsUp, // Proxied = true if using CNAME failover (tunnel), proxied = false if using direct VPS path
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
              `DNS record successfully updated to point to ${targetContent} (proxied: ${!isVpsUp})`
            )

            // Format Subject line with date and hour
            const now = new Date()
            const yyyy = now.getUTCFullYear()
            const mm = String(now.getUTCMonth() + 1).padStart(2, "0")
            const dd = String(now.getUTCDate()).padStart(2, "0")
            const hh = String(now.getUTCHours()).padStart(2, "0")
            const dateStr = `${yyyy}-${mm}-${dd} ${hh}:00 UTC`

            const subject = `[Failover] Ingress DNS Changed for ${SECRET_DOMAIN} - ${dateStr}`
            const body = [
              `Failover monitor detected that the ingress DNS record ${RECORD_NAME} was pointing to ${currentContent}, but should be ${targetContent}.`,
              ``,
              `Action: DNS record updated to a CNAME record pointing to ${targetContent} (proxied: ${!isVpsUp}).`,
              ``,
              `=== Diagnostics ===`,
              `Target Content: ${targetContent}`,
              `Previous Content: ${currentContent}`,
              `Timestamp: ${now.toISOString()}`,
              ``,
              `=== Probe Attempts ===`,
              ...probeAttempts,
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
        `No action required. Current target is correct (${currentContent}). Hetzner IP: ${VPS_IP}`
      )
    }
  },
}
