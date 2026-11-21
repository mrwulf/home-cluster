// Patches the Rowboat Spaces web build (apps/x/apps/renderer) for self-hosting.
// Upstream's web app registers itself with the sign-in server (DCR) and takes its
// server URL at build time. Pocket ID has no DCR, and the domain must not be baked
// into a public workflow or image, so both come from /config.js at runtime instead.
// Every anchor is asserted: an upstream change that moves one fails the build.
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const root = process.argv[2]

function edit(file, from, to) {
  const path = join(root, file)
  const src = readFileSync(path, "utf8")
  if (!src.includes(from))
    throw new Error(`patch anchor not found in ${file}: ${from}`)
  writeFileSync(path, src.replace(from, to))
}

edit(
  "src/web/config.ts",
  "export const SERVER_URL = (env.VITE_SPACES_SERVER_URL",
  "const runtime = (window as unknown as { __ROWBOAT__?: { serverUrl?: string; clientId?: string } }).__ROWBOAT__\n" +
    "export const CLIENT_ID = runtime?.clientId\n" +
    "export const SERVER_URL = (runtime?.serverUrl ?? env.VITE_SPACES_SERVER_URL"
)
edit(
  "src/web/account.ts",
  "import { DEV_HARBOR, SERVER_URL } from './config'",
  "import { CLIENT_ID, DEV_HARBOR, SERVER_URL } from './config'"
)
edit(
  "src/web/account.ts",
  "async function clientIdFor(issuer: string): Promise<string> {\n",
  "async function clientIdFor(issuer: string): Promise<string> {\n    if (CLIENT_ID) return CLIENT_ID\n"
)
edit(
  "web.html",
  '<script src="/theme.js"></script>',
  '<script src="/theme.js"></script>\n    <script src="/config.js"></script>'
)
