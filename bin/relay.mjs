#!/usr/bin/env node
/**
 * CLI entry point.
 *
 * Environment:
 *   RELAY_HOST             bind address            (default 127.0.0.1)
 *   RELAY_PORT             bind port               (default 8787)
 *   RELAY_UPSTREAM_HOST    Anthropic-compatible host (default api.anthropic.com)
 *   RELAY_UPSTREAM_PATH    messages path           (default /v1/messages)
 *   RELAY_UPSTREAM_PORT    upstream port           (default 443)
 *   RELAY_UPSTREAM_PROTO   http | https            (default https)
 *   RELAY_DUMP             1 to log one line per request
 *   RELAY_LOG_FILE         append logs to this file
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRelayServer } from "../src/relay.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(here, "..", "package.json"), "utf8"));

const logFile = process.env.RELAY_LOG_FILE ?? "";

function emit(level, message) {
  const line = `[${new Date().toISOString()}] ${level} ${message}`;
  process.stdout.write(line + "\n");
  if (!logFile) return;
  try {
    fs.appendFileSync(logFile, line + "\n");
  } catch {
    /* logging must never take the relay down */
  }
}

const server = createRelayServer({
  host: process.env.RELAY_HOST ?? "127.0.0.1",
  port: Number(process.env.RELAY_PORT ?? 8787),
  upstreamHost: process.env.RELAY_UPSTREAM_HOST ?? "api.anthropic.com",
  upstreamPath: process.env.RELAY_UPSTREAM_PATH ?? "/v1/messages",
  upstreamPort: process.env.RELAY_UPSTREAM_PORT
    ? Number(process.env.RELAY_UPSTREAM_PORT)
    : undefined,
  upstreamProtocol: process.env.RELAY_UPSTREAM_PROTO ?? "https",
  dump: process.env.RELAY_DUMP === "1",
  version: pkg.version,
  logger: { info: (m) => emit("INFO", m), warn: (m) => emit("WARN", m) },
});

const host = process.env.RELAY_HOST ?? "127.0.0.1";
const port = Number(process.env.RELAY_PORT ?? 8787);

server.listen(port, host, () => {
  emit(
    "INFO",
    `listening on http://${host}:${port} -> ` +
      `${process.env.RELAY_UPSTREAM_PROTO ?? "https"}://` +
      `${process.env.RELAY_UPSTREAM_HOST ?? "api.anthropic.com"}` +
      `${process.env.RELAY_UPSTREAM_PATH ?? "/v1/messages"} (v${pkg.version})`,
  );
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    emit("INFO", `${signal} received, shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
