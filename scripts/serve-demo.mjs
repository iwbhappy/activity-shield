import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const files = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/tracker.js", ["tracker.js", "text/javascript; charset=utf-8"]],
  ["/demo.css", ["demo.css", "text/css; charset=utf-8"]],
  ["/frame.html", ["frame.html", "text/html; charset=utf-8"]]
]);

export async function startDemo(port = 0) {
  const server = http.createServer(async (req, res) => {
    const entry = files.get(new URL(req.url, "http://localhost").pathname);
    if (!entry) { res.writeHead(404); res.end("Not found"); return; }
    try {
      const body = await readFile(new URL(`../demo/${entry[0]}`, import.meta.url));
      res.writeHead(200, {
        "Content-Type": entry[1], "Cache-Control": "no-store",
        "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; frame-src 'self' http://localhost:* http://127.0.0.1:*; object-src 'none'; base-uri 'none'"
      });
      res.end(body);
    } catch {
      res.writeHead(500); res.end("Unable to read demo file");
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.env.PORT || 8080);
  const server = await startDemo(port);
  console.log(`Demo: http://127.0.0.1:${server.address().port}/`);
  console.log("Ctrl+C to stop. Server listens on loopback only.");
}
