#!/usr/bin/env node
// Minimal static server for the demo fixture. localhost counts as a secure
// context, which is what WebMCP requires — no TLS setup needed.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, normalize } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "demo-site");
// The built telemetry package is served alongside the fixture so the demo can
// import it exactly as a real site would.
const telemetryRoot = join(here, "..", "telemetry", "dist");
const port = Number(process.argv[2] ?? 8787);

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };

createServer(async (req, res) => {
  const path = normalize(new URL(req.url ?? "/", "http://localhost").pathname);
  const telemetry = path.startsWith("/telemetry/");
  const base = telemetry ? telemetryRoot : root;
  const rel = telemetry ? path.slice("/telemetry".length) : path;
  const file = join(base, rel.endsWith("/") ? `${rel}index.html` : rel);
  if (!file.startsWith(base)) {
    res.writeHead(403).end("Forbidden");
    return;
  }
  try {
    const body = await readFile(file);
    const ext = file.slice(file.lastIndexOf("."));
    res.writeHead(200, { "content-type": TYPES[ext] ?? "application/octet-stream" }).end(body);
  } catch {
    res.writeHead(404).end("Not found");
  }
}).listen(port, () => {
  console.log(`Demo fixture on http://localhost:${port}`);
});
