/**
 * Anthropic prompt caching.
 *
 * The OpenAI protocol has no equivalent of `cache_control`, so a client that
 * speaks only OpenAI never asks for caching. Every turn then re-sends the whole
 * conversation at full price. Inserting breakpoints at the tail lets the
 * upstream reuse the previous prefix instead.
 *
 * Upstream rules this module respects:
 *   - at most 4 breakpoints per request
 *   - a breakpoint sits on a content block, never on a message
 *   - only text / image / document / tool_use / tool_result are cacheable
 *   - caching only happens above a minimum prefix length, so short requests
 *     simply do not get a cache entry (no error)
 */

export const MAX_BREAKPOINTS = 4;
export const DEFAULT_BREAKPOINTS = 3;

const CACHEABLE = new Set([
	"text",
	"image",
	"document",
	"tool_use",
	"tool_result",
]);

const VOLATILE_MARKERS = /(<current_time>[\s\S]*?<\/current_time>)|(\bcurrent time\b[^\n]{0,80})/i;
const TIME_LIKE = /(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2})|(\b\d{1,2}:\d{2}:\d{2}\b)|(\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+(19|20)\d{2})/i;

/**
 * Does this paragraph carry information that changes between two otherwise
 * identical turns? Anything time-shaped counts, plus an explicit marker.
 *
 * @param {string} text
 */
export function isVolatile(text) {
	if (typeof text !== "string" || !text) return false;
	return VOLATILE_MARKERS.test(text) || TIME_LIKE.test(text);
}

/**
 * Split the system prompt into a stable part and the paragraphs that look
 * time-shaped, leaving only the stable part on the body.
 *
 * @param {any} anthropic translated request body (mutated)
 * @returns {string|null} the volatile text, or null when nothing is worth moving
 */
export function splitVolatileSystem(anthropic) {
	const system = anthropic.system;
	if (typeof system !== "string" || !system) return null;

	const paragraphs = system.split(/\n{2,}/);
	if (paragraphs.length < 2) return null;

	const stable = [];
	const volatile = [];
	for (const p of paragraphs) (isVolatile(p) ? volatile : stable).push(p.trim());
	if (volatile.length === 0 || stable.length === 0) return null;

	anthropic.system = stable.filter(Boolean).join("\n\n");
	return volatile.filter(Boolean).join("\n\n");
}

/**
 * Attach the relocated text after the breakpoints have been placed, so it never
 * becomes part of the cached prefix.
 *
 * @param {any} anthropic
 * @param {string} note
 */
function appendRuntimeNote(anthropic, note) {
	const block = { type: "text", text: `[runtime context]\n${note}` };
	const messages = Array.isArray(anthropic.messages) ? anthropic.messages : [];
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i]?.role !== "user") continue;
		if (!Array.isArray(messages[i].content)) messages[i].content = [];
		messages[i].content.push(block);
		return;
	}
	if (Array.isArray(anthropic.system)) anthropic.system.push(block);
	else anthropic.messages = [{ role: "user", content: [block] }, ...messages];
}

/**
 * Build the breakpoint payload.
 *
 * `ttl` is optional: the default 5-minute window is fine for back-to-back tool
 * loops but loses everything across a long CI wait, so a longer TTL is offered
 * (`1h`, which the upstream gates behind a beta header).
 *
 * @param {"1h"|null} ttl
 */
function marker(ttl) {
	return ttl === "1h"
		? { type: "ephemeral", ttl: "1h" }
		: { type: "ephemeral" };
}

/**
 * Put a breakpoint on the last cacheable block of one message.
 *
 * @param {any} message
 * @param {"1h"|null} ttl
 * @returns {boolean} true when a new breakpoint was added
 */
function markMessage(message, ttl) {
	const content = message?.content;
	if (!Array.isArray(content) || content.length === 0) return false;

	for (let i = content.length - 1; i >= 0; i--) {
		const block = content[i];
		if (!block || typeof block !== "object") continue;
		if (!CACHEABLE.has(block.type)) continue;
		if (block.cache_control) return false;
		block.cache_control = marker(ttl);
		return true;
	}
	return false;
}

/**
 * Move the system prompt from a string into a single cached text block.
 *
 * @param {any} anthropic
 * @param {"1h"|null} ttl
 * @returns {boolean} true when a new breakpoint was added
 */
function markSystem(anthropic, ttl) {
	const system = anthropic.system;
	if (typeof system === "string") {
		if (!system) return false;
		anthropic.system = [{ type: "text", text: system, cache_control: marker(ttl) }];
		return true;
	}
	if (!Array.isArray(system) || system.length === 0) return false;

	for (let i = system.length - 1; i >= 0; i--) {
		const block = system[i];
		if (!block || block.type !== "text") continue;
		if (block.cache_control) return false;
		block.cache_control = marker(ttl);
		return true;
	}
	return false;
}

/**
 * Add cache breakpoints to a translated request, in place.
 *
 * Order matters: the system prompt is the most stable prefix, then the newest
 * turns. Working backwards from the tail means the deepest breakpoint always
 * covers the largest reusable prefix.
 *
 * @param {any} anthropic translated request body (mutated)
 * @param {{ breakpoints?: number, ttl?: "1h"|null, anchorVolatile?: boolean }} [options]
 * @returns {number} number of breakpoints added
 */
export function applyCacheControl(anthropic, options = {}) {
	if (!anthropic || typeof anthropic !== "object") return 0;

	// Split first so the breakpoints are placed on the stable text only, then
	// re-attach the volatile part after the last breakpoint.
	const note = options.anchorVolatile ? splitVolatileSystem(anthropic) : null;

	const requested = Number(options.breakpoints);
	const limit = Number.isFinite(requested) && requested > 0
		? Math.min(Math.trunc(requested), MAX_BREAKPOINTS)
		: DEFAULT_BREAKPOINTS;
	const ttl = options.ttl === "1h" ? "1h" : null;

	let used = 0;
	if (markSystem(anthropic, ttl)) used++;

	const messages = Array.isArray(anthropic.messages) ? anthropic.messages : [];
	for (let i = messages.length - 1; i >= 0 && used < limit; i--) {
		if (markMessage(messages[i], ttl)) used++;
	}

	if (note) appendRuntimeNote(anthropic, note);

	return used;
}
