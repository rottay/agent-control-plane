/**
 * The loopback chat/completions server of the P-15/E local drill (ADR 0108; C-E10,
 * E-ND-12).
 *
 * A tracked fixture, spawned by path as its own process: the one socket the daemon
 * drills open, declared rather than smuggled. It names `node:http` openly because
 * it is a child process outside the daemon's import law, which governs the daemon's
 * own `.ts` sources and tests; nothing here is imported by them.
 *
 * `node index.mjs <port> <headerLog>` listens on 127.0.0.1 at the port it is given
 * and prints `listening` once bound; a port already taken exits 1 so the drill can
 * draw another. Each request's line and headers are appended to `headerLog`, a path
 * outside every root the drill sweeps, so the drill can prove what the leaf sent —
 * the bearer credential included — without the credential reaching a swept sink.
 *
 * It answers `POST /v1/chat/completions` with an OpenAI-compatible event stream that
 * echoes the request's one user message in two deltas, then `finish_reason: stop`
 * and `[DONE]`, with no usage frame. Every event is written in two halves on two
 * turns of the event loop, so the leaf's reader meets events split across socket
 * writes rather than whole frames.
 */

import { Buffer } from "node:buffer";
import { appendFileSync } from "node:fs";
import { createServer } from "node:http";
import process from "node:process";
import { setImmediate } from "node:timers";

const port = Number(process.argv[2]);
const headerLog = process.argv[3];
if (!Number.isInteger(port) || port < 1024 || port > 65_535 || typeof headerLog !== "string" || headerLog === "") {
  process.stderr.write("usage: index.mjs <port> <headerLog>\n");
  process.exit(2);
}

/** Write `text` in two halves, the second on a later turn, then call `done`. */
function writeSplit(response, text, done) {
  const bytes = Buffer.from(text, "utf8");
  const middle = Math.max(1, Math.floor(bytes.length / 2));
  response.write(bytes.subarray(0, middle));
  setImmediate(() => {
    response.write(bytes.subarray(middle));
    setImmediate(done);
  });
}

const server = createServer((request, response) => {
  const lines = [request.method + " " + request.url];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    lines.push(request.rawHeaders[index].toLowerCase() + ": " + request.rawHeaders[index + 1]);
  }
  appendFileSync(headerLog, lines.join("\n") + "\n\n", { encoding: "utf8", mode: 0o600 });

  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => {
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end("{}");
      return;
    }
    let content = "";
    let model = "local-model";
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      content = String(body.messages[0].content);
      model = String(body.model);
    } catch {
      response.writeHead(400, { "content-type": "application/json" });
      response.end("{}");
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
    const half = Math.floor(content.length / 2);
    const frame = (delta, finish) =>
      "data: " +
      JSON.stringify({
        id: "chatcmpl-loopback01",
        object: "chat.completion.chunk",
        model,
        choices: [{ index: 0, delta, finish_reason: finish }],
      }) +
      "\n\n";
    const events = [
      frame({ role: "assistant", content: content.slice(0, half) }, null),
      frame({ content: content.slice(half) }, null),
      frame({}, "stop"),
      "data: [DONE]\n\n",
    ];
    const next = (index) => {
      if (index === events.length) {
        response.end();
        return;
      }
      writeSplit(response, events[index], () => next(index + 1));
    };
    next(0);
  });
});

server.once("error", () => {
  process.exit(1);
});
server.listen(port, "127.0.0.1", () => {
  process.stdout.write("listening\n");
});
process.on("SIGTERM", () => {
  server.close(() => process.exit(0));
});
