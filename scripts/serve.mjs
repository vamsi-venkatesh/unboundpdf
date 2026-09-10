import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = normalize(fileURLToPath(new URL("..", import.meta.url)));
const types = { ".html":"text/html; charset=utf-8", ".js":"text/javascript; charset=utf-8", ".css":"text/css; charset=utf-8", ".json":"application/json; charset=utf-8", ".pdf":"application/pdf", ".wasm":"application/wasm", ".gz":"application/gzip", ".png":"image/png", ".svg":"image/svg+xml", ".woff2":"font/woff2", ".webmanifest":"application/manifest+json" };

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://127.0.0.1");
    let rel = decodeURIComponent(url.pathname).replace(/^\/+/, "");
    let path = normalize(join(root, rel));
    if (!path.startsWith(root)) throw new Error("path outside root");
    const info = await stat(path).catch(() => null);
    if (info?.isDirectory() || url.pathname.endsWith("/")) path = join(path, "index.html");
    const body = await readFile(path);
    res.writeHead(200, { "content-type": types[extname(path)] || "application/octet-stream", "cache-control":"no-store" });
    res.end(body);
  } catch {
    res.writeHead(404, { "content-type":"text/plain; charset=utf-8" }); res.end("Not found");
  }
});

const requested = Number(process.env.PORT || 0);
server.listen(requested, "127.0.0.1", () => {
  const { port } = server.address();
  process.stdout.write(`port=${port}\n`);
});
