import { createServer, request, type Server } from "node:http";
import net, { type AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// @ts-expect-error - plain .mjs dev script, no type declarations
import { routeFor, startVoiceGateway } from "../../../scripts/voice-gateway.mjs";

// scripts/voice-gateway.mjs: one public address for every language's voice backend. /ta/… goes to
// the Tamil backend without the /ta, everything else to English unchanged — webhooks and the call
// audio WebSockets alike. Two fake backends stand in for the real ones.

describe("routeFor", () => {
  const routes = { ta: 8003, hi: 8004 };
  it("sends a language key to its backend without the key, the rest to English as it is", () => {
    expect(routeFor("/ta/api/webhooks/plivo/answer?call=1", routes, 8002)).toEqual({ port: 8003, path: "/api/webhooks/plivo/answer?call=1" });
    expect(routeFor("/hi/ws/plivo/media?t=x", routes, 8002)).toEqual({ port: 8004, path: "/ws/plivo/media?t=x" });
    expect(routeFor("/ta", routes, 8002)).toEqual({ port: 8003, path: "/" });
    expect(routeFor("/api/webhooks/plivo/answer", routes, 8002)).toEqual({ port: 8002, path: "/api/webhooks/plivo/answer" });
    expect(routeFor("/kn/health", routes, 8002)).toEqual({ port: 8002, path: "/kn/health" }); // Kannada not set up: English
    expect(routeFor("/tags", routes, 8002)).toEqual({ port: 8002, path: "/tags" });
  });
});

const seen: { backend: string; path: string; kind: "http" | "ws" }[] = [];
const upgraded: net.Socket[] = []; // raw sockets after "101": not tracked by the http server
function fakeBackend(name: string): Server {
  const s = createServer((req, res) => {
    seen.push({ backend: name, path: req.url!, kind: "http" });
    res.end(`${name}:${req.url}`);
  });
  s.on("upgrade", (req, socket: net.Socket) => {
    upgraded.push(socket);
    seen.push({ backend: name, path: req.url!, kind: "ws" });
    socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
    socket.on("data", (d) => socket.write(`${name} echo ${d}`)); // stands in for the audio frames
    socket.on("end", () => socket.end());
  });
  return s.listen(0);
}

let en: Server;
let ta: Server;
let gateway: Server;
let port = 0;
const portOf = (s: Server) => (s.address() as AddressInfo).port;

beforeAll(async () => {
  en = fakeBackend("en");
  ta = fakeBackend("ta");
  await new Promise((r) => setTimeout(r, 50));
  gateway = startVoiceGateway({ root: ".", voiceDir: ".", port: 0, routes: { ta: portOf(ta) }, englishPort: portOf(en), log: () => {} });
  await new Promise<void>((r) => (gateway.listening ? r() : gateway.once("listening", () => r())));
  port = portOf(gateway);
});
afterAll(async () => {
  for (const sock of upgraded) sock.destroy();
  for (const s of [gateway, en, ta]) {
    s.closeAllConnections(); // the gateway keeps connections to the backends open (keep-alive)
    await new Promise<void>((r) => s.close(() => r()));
  }
});

const get = (path: string) =>
  new Promise<string>((resolve, reject) => {
    request({ host: "127.0.0.1", port, path }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve(body));
    })
      .on("error", reject)
      .end();
  });

describe("voice gateway", () => {
  it("webhooks: /ta/… reach the Tamil backend, the rest English, paths as each backend knows them", async () => {
    expect(await get("/ta/api/webhooks/plivo/answer?call=1")).toBe("ta:/api/webhooks/plivo/answer?call=1");
    expect(await get("/api/webhooks/plivo/answer?call=2")).toBe("en:/api/webhooks/plivo/answer?call=2");
    expect(await get("/ta/health/self/abc")).toBe("ta:/health/self/abc"); // its /ready self-check
  });

  it("call audio: the Tamil media WebSocket is passed through both ways", async () => {
    const reply = await new Promise<string>((resolve, reject) => {
      const sock = net.connect(port, "127.0.0.1", () => {
        sock.write(
          "GET /ta/ws/plivo/media?token=t HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
            "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n",
        );
      });
      let buf = "";
      sock.on("data", (d) => {
        buf += d;
        if (buf.includes("\r\n\r\n") && !buf.includes("echo")) sock.write("frame");
        if (buf.includes("echo")) {
          sock.destroy();
          resolve(buf);
        }
      });
      sock.on("error", reject);
    });
    expect(reply).toMatch(/^HTTP\/1\.1 101/);
    expect(reply).toContain("ta echo frame");
    expect(seen).toContainEqual({ backend: "ta", path: "/ws/plivo/media?token=t", kind: "ws" });
  });
});
