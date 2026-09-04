#!/usr/bin/env node
// Minimal static server for the demo fixture. localhost counts as a secure
// context, which is what WebMCP requires — no TLS setup needed.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, normalize } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "demo-site");
const port = Number(process.argv[2] ?? 8787);

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };

createServer(async (req, res) => {
  const path = normalize(new URL(req.url ?? "/", "http://localhost").pathname);
  const file = join(root, path.endsWith("/") ? `${path}index.html` : path);
  if (!file.startsWith(root)) {
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
