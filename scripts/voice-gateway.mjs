// One public address for every language's voice backend, on this PC (the server does the same
// with nginx: deploy/nginx-voice-languages.conf). Point the one ngrok tunnel at this gateway:
//
//   https://<your ngrok address>/...      → English  (VOICE_BACKEND_URL port, 8002) - unchanged paths
//   https://<your ngrok address>/ta/...   → Tamil    (VOICE_BACKEND_URL_TA port, 8003), "/ta" removed
//   https://<your ngrok address>/hi/...   → Hindi, /kn/... → Kannada, ...
//
// So each language's PUBLIC_BASE_URL is the same address plus its key (…/ta), and Plivo / Twilio
// webhooks and call audio (WebSockets) reach the right backend. Started by `npm run dev:voice` when
// a language has its .env.<code>; on its own: `node scripts/voice-gateway.mjs`. Port: VOICE_GATEWAY_PORT
// in Dispatch's .env (default 8010) - then run `ngrok http --url=<your address> 8010`.

import http from "node:http";
import net from "node:net";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { readEnvFile, voiceLanguagesSetUp, voicePortFor } = require("./voice-languages.cjs");

export const DEFAULT_GATEWAY_PORT = 8010;

/** The gateway's port: VOICE_GATEWAY_PORT in Dispatch's .env, else 8010. */
export function gatewayPort(root) {
  const v = Number(readEnvFile(path.join(root, ".env")).VOICE_GATEWAY_PORT);
  return Number.isInteger(v) && v > 0 ? v : DEFAULT_GATEWAY_PORT;
}

/** "/ta/api/webhooks/plivo/answer?x=1" → { port: 8003, path: "/api/webhooks/plivo/answer?x=1" }; anything else → English. */
export function routeFor(url, routes, englishPort) {
  const m = /^\/([a-z]{2})(?=\/|\?|$)/.exec(url); // "/ta/…", "/ta?…", "/ta" — never "/tags"
  if (m && routes[m[1]]) {
    const rest = url.slice(m[0].length);
    return { port: routes[m[1]], path: rest.startsWith("/") ? rest : `/${rest}` };
  }
  return { port: englishPort, path: url };
}

/**
 * Start the gateway. `routes` ({ ta: 8003, … }) and `englishPort` default to the languages set up
 * in voiceDir and their ports from Dispatch's .env.
 */
export function startVoiceGateway({
  root,
  voiceDir,
  port = gatewayPort(root),
  routes = Object.fromEntries(voiceLanguagesSetUp(voiceDir).map((l) => [l, voicePortFor(root, l)])),
  englishPort = voicePortFor(root, "en"),
  log = console.log,
}) {

  const server = http.createServer((req, res) => {
    const target = routeFor(req.url ?? "/", routes, englishPort);
    const upstream = http.request(
      { host: "127.0.0.1", port: target.port, method: req.method, path: target.path, headers: req.headers },
      (r) => {
        res.writeHead(r.statusCode ?? 502, r.headers);
        r.pipe(res);
      },
    );
    upstream.on("error", () => {
      if (!res.headersSent) res.writeHead(502, { "Content-Type": "text/plain" });
      res.end(`voice backend on port ${target.port} is not running`);
    });
    req.pipe(upstream);
  });

  // Call audio: Plivo / Twilio media WebSockets, passed through byte for byte.
  server.on("upgrade", (req, socket, head) => {
    const target = routeFor(req.url ?? "/", routes, englishPort);
    const upstream = net.connect(target.port, "127.0.0.1", () => {
      let raw = `${req.method} ${target.path} HTTP/${req.httpVersion}\r\n`;
      for (let i = 0; i < req.rawHeaders.length; i += 2) raw += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
      upstream.write(`${raw}\r\n`);
      if (head?.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    // Either side gone (hang-up, network drop): close the other one too.
    upstream.on("error", () => socket.destroy());
    upstream.on("close", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
    socket.on("close", () => upstream.destroy());
  });

  server.listen(port, "127.0.0.1", () => {
    const list = Object.entries(routes).map(([l, p]) => `/${l} → :${p}`).join(", ");
    log(`[voice] gateway on :${port} (English → :${englishPort}${list ? `, ${list}` : ""}) — point ngrok here: ngrok http ${port}`);
  });
  return server;
}

// Run on its own: node scripts/voice-gateway.mjs
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  startVoiceGateway({ root, voiceDir: path.join(root, "kagzso-voice-backend-english") });
}
