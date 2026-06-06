export default {
  async scheduled(event, env, ctx) {
    const VPS_IP = env.VPS_PUBLIC_IP;
    const TUNNEL_CNAME = env.TUNNEL_CNAME;
    const ZONE_ID = env.CLOUDFLARE_ZONE_ID;
    const RECORD_ID = env.CLOUDFLARE_RECORD_ID;
    const API_TOKEN = env.CLOUDFLARE_API_TOKEN;
    const RECORD_NAME = env.RECORD_NAME;

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
          content: targetContent
        })
      });
      if (!updateRes.ok) {
        console.error("Failed to update DNS record:", await updateRes.text());
      }
    } else {
      console.log("No action required. Current target is correct.");
    }
  }
}
