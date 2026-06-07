import { connect } from 'cloudflare:sockets';

async function sendEmailViaSMTP(env, from, to, subject, body) {
  let socket;
  let writer;
  let reader;

  try {
    socket = connect({
      hostname: env.SMTP_SERVER,
      port: 465
    }, {
      secureTransport: 'on'
    });

    writer = socket.writable.getWriter();
    reader = socket.readable.getReader();
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();

    let buffer = '';

    async function readLine() {
      while (!buffer.includes('\n')) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value);
      }
      const index = buffer.indexOf('\n');
      if (index === -1) return '';
      const line = buffer.substring(0, index + 1);
      buffer = buffer.substring(index + 1);
      return line;
    }

    async function write(data) {
      await writer.write(encoder.encode(data));
    }

    // Read greeting
    let line = await readLine();
    if (!line.startsWith('220')) throw new Error('Invalid SMTP greeting: ' + line);

    // EHLO
    await write('EHLO localhost\r\n');
    while (true) {
      line = await readLine();
      if (line.startsWith('250 ')) break;
      if (!line.startsWith('250-')) throw new Error('EHLO failed: ' + line);
    }

    // AUTH PLAIN
    const authString = btoa(`\0${env.SMTP_USERNAME}\0${env.SMTP_PASSWORD}`);
    await write(`AUTH PLAIN ${authString}\r\n`);
    line = await readLine();
    if (!line.startsWith('235')) throw new Error('SMTP AUTH failed: ' + line);

    // MAIL FROM
    await write(`MAIL FROM:<${from}>\r\n`);
    line = await readLine();
    if (!line.startsWith('250')) throw new Error('MAIL FROM failed: ' + line);

    // RCPT TO
    await write(`RCPT TO:<${to}>\r\n`);
    line = await readLine();
    if (!line.startsWith('250')) throw new Error('RCPT TO failed: ' + line);

    // DATA
    await write('DATA\r\n');
    line = await readLine();
    if (!line.startsWith('354')) throw new Error('DATA start failed: ' + line);

    // Write message
    const msg = [
      `From: <${from}>`,
      `To: <${to}>`,
      `Subject: ${subject}`,
      `Content-Type: text/plain; charset=UTF-8`,
      `Date: ${new Date().toUTCString()}`,
      `Message-ID: <${Date.now()}@${from.split('@')[1]}>`,
      '',
      body,
      '.'
    ].join('\r\n') + '\r\n';
    await write(msg);
    line = await readLine();
    if (!line.startsWith('250')) throw new Error('DATA send failed: ' + line);

    // QUIT
    await write('QUIT\r\n');
    console.log('Email sent successfully via SMTP!');
  } catch (err) {
    console.error('SMTP Error:', err);
  } finally {
    try {
      if (writer) writer.releaseLock();
      if (reader) reader.releaseLock();
    } catch (_) {}
    if (socket) {
      try {
        await socket.close();
      } catch (_) {}
    }
  }
}

export default {
  async scheduled(event, env, ctx) {
    const VPS_IP = env.VPS_PUBLIC_IP;
    const TUNNEL_CNAME = env.TUNNEL_CNAME;
    const ZONE_ID = env.CLOUDFLARE_ZONE_ID;
    const RECORD_ID = env.CLOUDFLARE_RECORD_ID;
    const API_TOKEN = env.CLOUDFLARE_API_TOKEN;
    const RECORD_NAME = env.RECORD_NAME;

    const SECRET_DOMAIN = RECORD_NAME.replace(/^ingress\./, '');
    const fromEmail = `failover-monitor@${SECRET_DOMAIN}`;
    const toEmail = `postmaster@${SECRET_DOMAIN}`;

    // 1. Probe the VPS
    let isVpsUp = false;
    try {
      const res = await fetch(`https://${VPS_IP}`, {
        method: "HEAD",
        headers: { "Host": RECORD_NAME },
        signal: AbortSignal.timeout(5000)
      });
      isVpsUp = res.status < 500;
    } catch (err) {
      isVpsUp = false;
    }

    // 2. Query the current DNS record value
    const dnsUrl = `https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/dns_records/${RECORD_ID}`;
    const dnsRes = await fetch(dnsUrl, {
      headers: { "Authorization": `Bearer ${API_TOKEN}` }
    });
    const dnsData = await dnsRes.json();
    const currentContent = dnsData.result.content;

    // 3. Determine target state
    const targetContent = isVpsUp ? VPS_IP : TUNNEL_CNAME;
    const targetType = isVpsUp ? "A" : "CNAME";

    // 4. Update if there is a mismatch
    if (currentContent !== targetContent) {
      console.log(`Mismatch detected! Current: ${currentContent}, Target: ${targetContent}. Updating...`);
      const updateRes = await fetch(dnsUrl, {
        method: "PATCH",
        headers: {
          "Authorization": `Bearer ${API_TOKEN}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          type: targetType,
          content: targetContent,
          proxied: !isVpsUp // Proxied = true if using CNAME failover (tunnel), proxied = false if using A record (direct to VPS)
        })
      });
      if (!updateRes.ok) {
        console.error("Failed to update DNS record:", await updateRes.text());
      } else {
        console.log(`DNS record updated to point to ${targetContent} (proxied: ${!isVpsUp})`);
        ctx.waitUntil(sendEmailViaSMTP(env, fromEmail, toEmail,
          `[Failover] Ingress DNS Changed for ${SECRET_DOMAIN}`,
          `Failover monitor detected that the ingress DNS record ${RECORD_NAME} was pointing to ${currentContent}, but should be ${targetContent}.\n\nAction: DNS record updated to a ${targetType} record pointing to ${targetContent} (proxied: ${!isVpsUp}).`
        ));
      }
    } else {
      console.log("No action required. Current target is correct.");
    }
  }
}
