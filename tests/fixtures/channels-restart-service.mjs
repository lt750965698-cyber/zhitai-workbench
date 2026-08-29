import { appendFileSync } from "node:fs";
import { createServer } from "node:http";

const port = Number(process.argv[2]);
const pidHistoryPath = process.argv[3];
const startedAt = Date.now();

if (!Number.isInteger(port) || port < 1 || port > 65_535 || !pidHistoryPath) {
  process.exit(2);
}

appendFileSync(pidHistoryPath, `${process.pid}\n`, "utf8");

const server = createServer((request, response) => {
  if (request.url !== "/api/channels/status") {
    response.writeHead(404, { "Content-Type": "application/json" });
    response.end('{"code":404}');
    return;
  }

  const ageMs = Date.now() - startedAt;
  if (ageMs < 100) {
    response.writeHead(503, { "Content-Type": "application/json" });
    response.end('{"code":1,"msg":"starting"}');
    return;
  }

  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify({ code: 0, data: { available: ageMs >= 350 } }));
});

server.listen(port, "127.0.0.1");

function stop() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1_000).unref();
}

process.once("SIGINT", stop);
process.once("SIGTERM", stop);
