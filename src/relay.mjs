/**
 * HTTP server that accepts OpenAI Chat Completions requests and proxies them
 * to an Anthropic Messages endpoint, translating in both directions.
 *
 * Security model:
 *   - binds to loopback only (default 127.0.0.1)
 *   - never stores or logs credentials; the API key is taken from the inbound
 *     request (x-api-key or Authorization: Bearer) and forwarded verbatim
 */

import http from "node:http";
import https from "node:https";
import { toAnthropic } from "./translate-request.mjs";
import { createPrefixWatcher } from "./prefix-watch.mjs";
import {
  createSseTranslator,
  convertNonStreaming,
  openAIError,
} from "./translate-response.mjs";

export const DEFAULTS = {
  host: "127.0.0.1",
  port: 8787,
  upstreamHost: "api.anthropic.com",
  upstreamPath: "/v1/messages",
  upstreamProtocol: "https",
  anthropicVersion: "2023-06-01",
  maxBodyBytes: 64 * 1024 * 1024,
  modelMap: null,
  maxTokensMap: null,
  defaultMaxTokens: undefined,
  cacheControl: { enabled: true, breakpoints: 3, ttl: null },
  cacheDebug: false,
};

/** Upstream beta header required for the one-hour prompt cache. */
export const EXTENDED_CACHE_BETA = "extended-cache-ttl-2025-04-11";

/** Extract an API key from either supported inbound header. */
export function extractApiKey(headers) {
  const direct = headers["x-api-key"];
  if (typeof direct === "string" && direct) return direct;
  const auth = headers["authorization"];
  if (typeof auth === "string" && auth.toLowerCase().startsWith("bearer ")) {
    return auth.slice(7).trim();
  }
  return "";
}

/**
 * @param {Partial<typeof DEFAULTS> & {
 *   logger?: { info: (m: string) => void, warn: (m: string) => void },
 *   dump?: boolean,
 *   version?: string,
 *   fetchImage?: typeof fetch,
 * }} [options]
 * @returns {http.Server}
 */
export function createRelayServer(options = {}) {
  const cfg = { ...DEFAULTS, ...options };
  const log = cfg.logger ?? { info: () => {}, warn: () => {} };
  const transport = cfg.upstreamProtocol === "http" ? http : https;
  const version = cfg.version ?? "0.0.0";
  const watcher = createPrefixWatcher();

  return http.createServer((req, res) => {
    if (req.method === "GET" && (req.url === "/_health" || req.url === "/health")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({ ok: true, service: "workbuddy-protocol-relay", version }),
      );
      return;
    }

    const chunks = [];
    let size = 0;
    let overflow = false;

    req.on("data", (c) => {
      size += c.length;
      if (size > cfg.maxBodyBytes) {
        overflow = true;
        req.destroy();
        return;
      }
      chunks.push(c);
    });

    req.on("end", async () => {
      if (overflow) {
        if (!res.headersSent) {
          res.writeHead(413, { "content-type": "application/json" });
          res.end(openAIError(413, "request body too large", "invalid_request_error"));
        }
        return;
      }

      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(openAIError(400, "invalid JSON body", "invalid_request_error"));
        return;
      }

      let converted;
      try {
        converted = await toAnthropic(body, {
          fetchImage: cfg.fetchImage,
          modelMap: cfg.modelMap,
          maxTokensMap: cfg.maxTokensMap,
          defaultMaxTokens: cfg.defaultMaxTokens,
          cacheControl: cfg.cacheControl,
        });
      } catch (err) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(openAIError(500, `request translation failed: ${err.message}`, "relay_error"));
        return;
      }

      const { anthropic, displayModel, effort, includeUsage, mappedFrom, cacheBreakpoints } =
        converted;
      const ctx = { id: `chatcmpl-${Date.now().toString(36)}`, displayModel };

      if (cfg.dump) {
        const roles = anthropic.messages.map((m) => m.role[0]).join("");
        log.info(
          `${displayModel} -> ${anthropic.model}` +
            `${mappedFrom ? ` (mapped from ${mappedFrom})` : ""} ` +
            `effort=${effort ?? "-"} ` +
            `max=${anthropic.max_tokens} msgs=${anthropic.messages.length}(${roles}) ` +
            `system=${anthropic.system ? "y" : "n"} tools=${anthropic.tools?.length ?? 0} ` +
            `tool_choice=${anthropic.tool_choice?.type ?? "-"} cache=${cacheBreakpoints} ` +
            `stream=${anthropic.stream}`,
        );
      }

      if (cfg.cacheDebug) {
        // Which segment first differs from the previous call for this model.
        const segments = [];
        if (anthropic.system) {
          segments.push({
            kind: "system",
            text:
              typeof anthropic.system === "string"
                ? anthropic.system
                : JSON.stringify(anthropic.system),
          });
        }
        for (const [i, m] of anthropic.messages.entries()) {
          segments.push({ kind: `msg[${i}]`, role: m.role, text: JSON.stringify(m.content) });
        }
        const seen = watcher.observe(String(anthropic.model), segments);
        const d = seen.drift;
        log.info(
          `cache-debug model=${anthropic.model} segs=${seen.segs} stable=${seen.stable} ` +
            (d
              ? `drift=${d.kind}${d.role ? `(${d.role})` : ""} len ${d.lenFrom}->${d.lenTo} ` +
                `timestamps ${d.timeFrom}->${d.timeTo} ids ${d.idsFrom}->${d.idsTo}`
              : "drift=none"),
        );
      }

      const payload = Buffer.from(JSON.stringify(anthropic));
      const key = extractApiKey(req.headers);
      const upstreamHeaders = {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": cfg.anthropicVersion,
        accept: anthropic.stream ? "text/event-stream" : "application/json",
        "content-length": payload.length,
      };
      if (cfg.cacheControl?.ttl === "1h") {
        upstreamHeaders["anthropic-beta"] = EXTENDED_CACHE_BETA;
      }

      const upstreamReq = transport.request(
        {
          host: cfg.upstreamHost,
          port: cfg.upstreamPort,
          path: cfg.upstreamPath,
          method: "POST",
          headers: upstreamHeaders,
        },
        (upstreamRes) => {
          const contentType = upstreamRes.headers["content-type"] ?? "";

          if (upstreamRes.statusCode !== 200) {
            const errChunks = [];
            upstreamRes.on("data", (c) => errChunks.push(c));
            upstreamRes.on("end", () => {
              const raw = Buffer.concat(errChunks).toString("utf8");
              let message = raw;
              let type = "upstream_error";
              try {
                const parsed = JSON.parse(raw);
                message = parsed.error?.message ?? raw;
                type = parsed.error?.type ?? type;
              } catch {
                /* keep raw */
              }
              log.warn(`upstream ${upstreamRes.statusCode}: ${String(message).slice(0, 240)}`);
              if (!res.headersSent) {
                res.writeHead(upstreamRes.statusCode ?? 502, {
                  "content-type": "application/json",
                });
                res.end(openAIError(upstreamRes.statusCode ?? 502, String(message), type));
              }
            });
            return;
          }

          const isStream =
            anthropic.stream || contentType.includes("text/event-stream");

          if (isStream) {
            res.writeHead(200, {
              "content-type": "text/event-stream; charset=utf-8",
              "cache-control": "no-cache",
              connection: "keep-alive",
              "x-accel-buffering": "no",
            });
            res.flushHeaders?.();

            const translator = createSseTranslator({
              write: (chunk) => {
                if (!res.writableEnded) res.write(chunk);
              },
              ctx,
              includeUsage,
            });

            upstreamRes.setEncoding("utf8");
            upstreamRes.on("data", (text) => translator.push(text));
            upstreamRes.on("end", () => {
              translator.finish();
              if (!res.writableEnded) res.end();
            });
            upstreamRes.on("error", (err) => {
              log.warn(`stream interrupted: ${err.message}`);
              translator.finish();
              if (!res.writableEnded) res.end();
            });
            return;
          }

          const jsonChunks = [];
          upstreamRes.on("data", (c) => jsonChunks.push(c));
          upstreamRes.on("end", () => {
            try {
              const message = JSON.parse(Buffer.concat(jsonChunks).toString("utf8"));
              res.writeHead(200, { "content-type": "application/json" });
              res.end(JSON.stringify(convertNonStreaming(message, ctx)));
            } catch (err) {
              res.writeHead(502, { "content-type": "application/json" });
              res.end(openAIError(502, `upstream response parse failed: ${err.message}`, "relay_error"));
            }
          });
        },
      );

      upstreamReq.on("error", (err) => {
        log.warn(`upstream connection failed: ${err.message}`);
        if (!res.headersSent) {
          res.writeHead(502, { "content-type": "application/json" });
          res.end(openAIError(502, `upstream connection failed: ${err.message}`, "network_error"));
        }
      });

      res.on("close", () => {
        if (!res.writableEnded) upstreamReq.destroy();
      });

      upstreamReq.end(payload);
    });
  });
}
