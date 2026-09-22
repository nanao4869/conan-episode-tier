// Tiny local static server so the app can be used from http://localhost instead of file://.
// Browsers block reading the bundled thumbnails when index.html is opened by double-click,
// which makes "save as PNG" fail. Usage: node serve.mjs [--no-open] [page.html]
// The optional page argument picks which page to open (defaults to index.html - the episode Tier maker);
// serves every page either way, so http://localhost:8123/movie.html or /opening.html always work too.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { exec } from "node:child_process";

const root = path.dirname(fileURLToPath(import.meta.url));
const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".gif": "image/gif",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
};

const server = http.createServer((req, res) => {
  let rel = decodeURIComponent(req.url.split("?")[0]);
  if (rel.endsWith("/")) rel += "index.html";
  const file = path.resolve(root, "." + rel);
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404);
    return res.end("Not found");
  }
  // no-cache: after regenerating data/episodes.js a plain reload must show the new data
  res.writeHead(200, { "Content-Type": types[path.extname(file).toLowerCase()] || "application/octet-stream", "Cache-Control": "no-cache" });
  fs.createReadStream(file).pipe(res);
});

function listen(port, triesLeft) {
  server.once("error", (err) => {
    if (err.code === "EADDRINUSE" && triesLeft > 0) return listen(port + 1, triesLeft - 1);
    console.error(err.message);
    process.exit(1);
  });
  server.listen(port, "127.0.0.1", () => {
    const page = process.argv.slice(2).find((a) => !a.startsWith("--")) || "";
    const url = `http://localhost:${port}/${page}`;
    console.log(`Tier表メーカーを起動しました: ${url}`);
    console.log("終了するには、このウィンドウを閉じるか Ctrl+C を押してください。");
    if (!process.argv.includes("--no-open")) exec(`start "" "${url}"`);
  });
}

listen(8123, 10);
