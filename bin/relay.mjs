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
 *   RELAY_MODEL_MAP        name rewriting, "from=to,from=to" ("*" = catch-all)
 *   RELAY_MAX_TOKENS_MAP   per-model max_tokens, "model:64000,model:32000"
 *   RELAY_MAX_TOKENS       global max_tokens default when neither the request
 *                          nor the map provides one (default 32000)
 *   RELAY_CACHE_CONTROL    auto | off — add prompt-cache breakpoints (default auto)
 *   RELAY_CACHE_BREAKPOINTS breakpoints per request, 1-4 (default 3)
 *   RELAY_CACHE_TTL        1h keeps the cache across long tool/CI gaps (default 5m)
 *   RELAY_CACHE_ANCHOR     1 relocates time-shaped system paragraphs out of the cached prefix
 *   RELAY_CACHE_DEBUG      1 logs where the prompt prefix drifted from the last call
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRelayServer } from "../src/relay.mjs";
import { parseMaxTokensMap, parseModelMap } from "../src/model-options.mjs";

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

const modelMap = parseModelMap(process.env.RELAY_MODEL_MAP);
const maxTokensMap = parseMaxTokensMap(process.env.RELAY_MAX_TOKENS_MAP);
const cacheEnabled = (process.env.RELAY_CACHE_CONTROL ?? "auto").toLowerCase() !== "off";
const cacheBreakpoints = Number(process.env.RELAY_CACHE_BREAKPOINTS ?? 3);
const cacheTtl = (process.env.RELAY_CACHE_TTL ?? "").toLowerCase() === "1h" ? "1h" : null;
const cacheDebug = process.env.RELAY_CACHE_DEBUG === "1";
const cacheAnchor = process.env.RELAY_CACHE_ANCHOR === "1";

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
  modelMap,
  maxTokensMap,
  defaultMaxTokens: process.env.RELAY_MAX_TOKENS
    ? Number(process.env.RELAY_MAX_TOKENS)
    : undefined,
  cacheControl: {
    enabled: cacheEnabled,
    breakpoints: cacheBreakpoints,
    ttl: cacheTtl,
    anchorVolatile: cacheAnchor,
  },
  cacheDebug,
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
  emit(
    "INFO",
    `cache=${cacheEnabled ? `auto(${cacheBreakpoints})` : "off"} ttl=${cacheTtl ?? "5m"} ` +
      `anchor=${cacheAnchor ? "on" : "off"} debug=${cacheDebug ? "on" : "off"} ` +
      `modelMap=${modelMap.size} maxTokensMap=${maxTokensMap.size} ` +
      `defaultMaxTokens=${process.env.RELAY_MAX_TOKENS ?? "32000"}`,
  );
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    emit("INFO", `${signal} received, shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
