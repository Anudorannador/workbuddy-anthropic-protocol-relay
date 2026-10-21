/**
 * OpenAI Chat Completions -> Anthropic Messages request translation.
 *
 * Every field that has a semantic equivalent upstream is mapped; every field
 * that has none is dropped deliberately, because the upstream rejects unknown
 * fields with HTTP 400. See docs/protocol-mapping.md for the full table.
 */

import { decodeModelId, normalizeEffort } from "./model-id.mjs";

export const DEFAULT_MAX_TOKENS = 32000;
export const MAX_TOKENS_CAP = 128000;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const IMAGE_FETCH_TIMEOUT_MS = 10000;

/**
 * OpenAI parameters with no Anthropic equivalent. Sending them upstream would
 * fail the request, so they are dropped explicitly.
 */
export const DROPPED_PARAMS = [
	"presence_penalty",
	"frequency_penalty",
	"logit_bias",
	"seed",
	"logprobs",
	"top_logprobs",
	"n",
	"stream_options",
	"parallel_tool_calls",
	"response_format",
];

/** @param {any} p */
function isObject(p) {
	return p !== null && typeof p === "object" && !Array.isArray(p);
}

/**
 * Download a remote image and return it as base64, because the Anthropic API
 * only accepts inline image data (no URL sources).
 * @param {string} url
 * @param {typeof fetch} [fetcher]
 * @returns {Promise<{mediaType: string, data: string}|null>}
 */
async function fetchImageAsBase64(url, fetcher = globalThis.fetch) {
	if (typeof fetcher !== "function") return null;
	try {
		const ctrl = new AbortController();
		const timer = setTimeout(() => ctrl.abort(), IMAGE_FETCH_TIMEOUT_MS);
		const res = await fetcher(url, { signal: ctrl.signal });
		clearTimeout(timer);
		if (!res.ok) return null;
		const buf = Buffer.from(await res.arrayBuffer());
		if (!buf.length || buf.length > MAX_IMAGE_BYTES) return null;
		const mediaType = (res.headers.get("content-type") || "image/png")
			.split(";")[0]
			.trim();
		return { mediaType, data: buf.toString("base64") };
	} catch {
		return null;
	}
}

/**
 * Convert an OpenAI content value (string or part array) into Anthropic
 * content blocks.
 *
 * @param {any} parts
 * @param {{ fetchImage?: typeof fetch }} [options]
 * @returns {Promise<Array<object>>}
 */
export async function convertContentParts(parts, options = {}) {
	const out = [];

	for (const part of parts ?? []) {
		if (typeof part === "string") {
			if (part) out.push({ type: "text", text: part });
			continue;
		}
		if (!isObject(part)) continue;

		switch (part.type) {
			case "text":
			case "input_text": {
				if (typeof part.text === "string" && part.text.length) {
					out.push({ type: "text", text: part.text });
				}
				break;
			}
			case "image_url": {
				const url =
					typeof part.image_url === "string"
						? part.image_url
						: (part.image_url?.url ?? "");
				if (!url) break;

				if (url.startsWith("data:")) {
					const comma = url.indexOf(",");
					if (comma < 0) break;
					const mediaType =
						url.slice(5, comma).split(";")[0].trim() || "image/png";
					out.push({
						type: "image",
						source: {
							type: "base64",
							media_type: mediaType,
							data: url.slice(comma + 1),
						},
					});
				} else if (/^https?:/i.test(url)) {
					const img = await fetchImageAsBase64(url, options.fetchImage);
					out.push(
						img
							? {
									type: "image",
									source: {
										type: "base64",
										media_type: img.mediaType,
										data: img.data,
									},
								}
							: { type: "text", text: "[image omitted: remote fetch failed]" },
					);
				}
				break;
			}
			case "file": {
				const file = part.file ?? {};
				const dataUrl = file.file_data ?? file.data ?? "";
				if (!dataUrl.startsWith("data:")) {
					out.push({
						type: "text",
						text: `[file ${file.filename ?? ""} omitted: no inline data]`,
					});
					break;
				}
				const comma = dataUrl.indexOf(",");
				const mediaType = dataUrl.slice(5, comma).split(";")[0].trim();
				if (mediaType === "application/pdf") {
					out.push({
						type: "document",
						source: {
							type: "base64",
							media_type: mediaType,
							data: dataUrl.slice(comma + 1),
						},
					});
				} else {
					out.push({
						type: "text",
						text: `[file ${file.filename ?? ""} omitted: unsupported type ${mediaType}]`,
					});
				}
				break;
			}
			case "input_audio":
			case "audio": {
				out.push({
					type: "text",
					text: "[audio omitted: upstream does not accept audio input]",
				});
				break;
			}
			default: {
				if (typeof part.text === "string" && part.text) {
					out.push({ type: "text", text: part.text });
				}
			}
		}
	}

	return out;
}

/**
 * Map an OpenAI tool_choice value onto the Anthropic equivalent.
 *
 * @param {any} choice
 * @param {boolean|undefined} parallel
 * @returns {object|undefined}
 */
export function mapToolChoice(choice, parallel) {
	const noParallel = parallel === false ? { disable_parallel_tool_use: true } : {};

	if (choice == null) {
		return parallel === false ? { type: "auto", ...noParallel } : undefined;
	}

	if (typeof choice === "string") {
		switch (choice.toLowerCase()) {
			case "none":
				return { type: "none" };
			case "required":
			case "any":
				return { type: "any", ...noParallel };
			case "auto":
			default:
				return { type: "auto", ...noParallel };
		}
	}

	if (!isObject(choice)) return undefined;

	if (choice.type === "function") {
		const name = choice.function?.name ?? choice.name;
		return name ? { type: "tool", name, ...noParallel } : undefined;
	}
	switch (choice.type) {
		case "tool":
			return choice.name ? { type: "tool", name: choice.name, ...noParallel } : undefined;
		case "any":
			return { type: "any", ...noParallel };
		case "auto":
			return { type: "auto", ...noParallel };
		case "none":
			return { type: "none" };
		default:
			return undefined;
	}
}

/**
 * Anthropic requires strictly alternating roles starting with `user`.
 * Merge adjacent same-role turns and prepend a seed turn when needed.
 *
 * @param {Array<{role: string, content: object[]}>} messages
 * @returns {Array<{role: string, content: object[]}>}
 */
export function normalizeAlternation(messages) {
	const merged = [];
	for (const msg of messages) {
		if (!Array.isArray(msg.content) || msg.content.length === 0) continue;
		const last = merged[merged.length - 1];
		if (last && last.role === msg.role) last.content.push(...msg.content);
		else merged.push({ role: msg.role, content: [...msg.content] });
	}

	if (!merged.length) return merged;
	if (merged[0].role !== "user") {
		merged.unshift({ role: "user", content: [{ type: "text", text: "(continue)" }] });
	}
	return merged;
}

/**
 * Convert legacy `functions` / `function_call` into the modern tool fields.
 * @param {any} body
 */
function upgradeLegacyFunctions(body) {
	let tools = body.tools;
	if ((!Array.isArray(tools) || tools.length === 0) && Array.isArray(body.functions)) {
		tools = body.functions.map((fn) => ({ type: "function", function: fn }));
	}

	let toolChoice = body.tool_choice;
	if (toolChoice == null && body.function_call != null) {
		const fc = body.function_call;
		if (fc === "none") toolChoice = "none";
		else if (fc === "auto") toolChoice = "auto";
		else if (isObject(fc) && fc.name) {
			toolChoice = { type: "function", function: { name: fc.name } };
		}
	}
	return { tools, toolChoice };
}

/**
 * Translate an OpenAI request body into an Anthropic request body.
 *
 * @param {any} body
 * @param {{ fetchImage?: typeof fetch }} [options]
 */
export async function toAnthropic(body, options = {}) {
	const systemParts = [];
	const turns = [];
	let pendingToolResults = [];

	const flushToolResults = () => {
		if (!pendingToolResults.length) return;
		turns.push({ role: "user", content: [...pendingToolResults] });
		pendingToolResults = [];
	};

	const { tools, toolChoice } = upgradeLegacyFunctions(body);

	for (const msg of body.messages ?? []) {
		if (!isObject(msg)) continue;

		if (msg.role === "system" || msg.role === "developer") {
			const text =
				typeof msg.content === "string"
					? msg.content
					: JSON.stringify(msg.content ?? "");
			if (text) systemParts.push(text);
			continue;
		}

		if (msg.role === "tool" || msg.role === "function") {
			pendingToolResults.push({
				type: "tool_result",
				tool_use_id: msg.tool_call_id ?? msg.name ?? "unknown",
				content:
					typeof msg.content === "string"
						? msg.content
						: JSON.stringify(msg.content ?? ""),
			});
			continue;
		}

		flushToolResults();

		if (msg.role === "user") {
			const content =
				typeof msg.content === "string"
					? msg.content
						? [{ type: "text", text: msg.content }]
						: []
					: await convertContentParts(msg.content, options);
			if (content.length) turns.push({ role: "user", content });
			continue;
		}

		if (msg.role === "assistant") {
			const blocks = [];
			if (typeof msg.content === "string") {
				if (msg.content) blocks.push({ type: "text", text: msg.content });
			} else if (Array.isArray(msg.content)) {
				for (const b of msg.content) {
					if (isObject(b) && b.type === "text" && b.text) {
						blocks.push({ type: "text", text: b.text });
					}
				}
			}
			for (const call of msg.tool_calls ?? []) {
				let input = {};
				const args = call.function?.arguments;
				if (typeof args === "string" && args.trim()) {
					try {
						input = JSON.parse(args);
					} catch {
						input = { _raw: args };
					}
				} else if (isObject(args)) {
					input = args;
				}
				blocks.push({
					type: "tool_use",
					id: call.id ?? `call_${Math.random().toString(36).slice(2, 10)}`,
					name: call.function?.name ?? call.name ?? "unknown_tool",
					input,
				});
			}
			if (blocks.length) turns.push({ role: "assistant", content: blocks });
		}
	}

	flushToolResults();

	const messages = normalizeAlternation(turns);
	if (!messages.length) {
		messages.push({ role: "user", content: [{ type: "text", text: "hi" }] });
	}

	const { model, effort: idEffort } = decodeModelId(body.model);
	const requestedMax = Number(body.max_completion_tokens ?? body.max_tokens);
	const maxTokens = Math.min(
		Number.isFinite(requestedMax) && requestedMax > 0 ? requestedMax : DEFAULT_MAX_TOKENS,
		MAX_TOKENS_CAP,
	);

	const anthropic = {
		model,
		messages,
		max_tokens: maxTokens,
		stream: body.stream === true,
	};

	if (systemParts.length) anthropic.system = systemParts.join("\n\n");

	for (const key of ["temperature", "top_p", "top_k"]) {
		if (typeof body[key] === "number") anthropic[key] = body[key];
	}

	const stop = body.stop_sequences ?? body.stop;
	if (typeof stop === "string" && stop) anthropic.stop_sequences = [stop];
	else if (Array.isArray(stop)) {
		const seqs = stop.filter((s) => typeof s === "string" && s);
		if (seqs.length) anthropic.stop_sequences = seqs;
	}

	if (typeof body.user === "string" && body.user) {
		anthropic.metadata = { user_id: body.user };
	}

	if (Array.isArray(tools) && tools.length) {
		anthropic.tools = tools.map((tool) => {
			const fn = tool.function ?? tool;
			return {
				name: fn.name,
				description: fn.description ?? "",
				input_schema: fn.parameters ?? { type: "object", properties: {} },
			};
		});
		const mapped = mapToolChoice(toolChoice, body.parallel_tool_calls);
		if (mapped) anthropic.tool_choice = mapped;
	}

	const effort =
		idEffort ?? normalizeEffort(body.reasoning_effort) ?? null;
	if (effort) {
		anthropic.thinking = { type: "adaptive" };
		anthropic.output_config = { effort };
	}

	const responseFormat = body.response_format;
	if (isObject(responseFormat) && responseFormat.type !== "text") {
		let hint = "Return only a single valid JSON value. No prose, no markdown fences.";
		if (responseFormat.type === "json_schema" && responseFormat.json_schema) {
			hint += ` It must conform to this JSON Schema: ${JSON.stringify(
				responseFormat.json_schema,
			)}`;
		}
		anthropic.system = anthropic.system ? `${anthropic.system}\n\n${hint}` : hint;
	}

	return {
		anthropic,
		displayModel: body.model,
		effort: anthropic.output_config?.effort ?? null,
		includeUsage: body.stream_options?.include_usage === true,
	};
}
