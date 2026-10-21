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

/**
 * Put a breakpoint on the last cacheable block of one message.
 *
 * @param {any} message
 * @returns {boolean} true when a new breakpoint was added
 */
function markMessage(message) {
	const content = message?.content;
	if (!Array.isArray(content) || content.length === 0) return false;

	for (let i = content.length - 1; i >= 0; i--) {
		const block = content[i];
		if (!block || typeof block !== "object") continue;
		if (!CACHEABLE.has(block.type)) continue;
		if (block.cache_control) return false;
		block.cache_control = { type: "ephemeral" };
		return true;
	}
	return false;
}

/**
 * Move the system prompt from a string into a single cached text block.
 *
 * @param {any} anthropic
 * @returns {boolean} true when a new breakpoint was added
 */
function markSystem(anthropic) {
	const system = anthropic.system;
	if (typeof system === "string") {
		if (!system) return false;
		anthropic.system = [
			{ type: "text", text: system, cache_control: { type: "ephemeral" } },
		];
		return true;
	}
	if (!Array.isArray(system) || system.length === 0) return false;

	for (let i = system.length - 1; i >= 0; i--) {
		const block = system[i];
		if (!block || block.type !== "text") continue;
		if (block.cache_control) return false;
		block.cache_control = { type: "ephemeral" };
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
 * @param {{ breakpoints?: number }} [options]
 * @returns {number} number of breakpoints added
 */
export function applyCacheControl(anthropic, options = {}) {
	if (!anthropic || typeof anthropic !== "object") return 0;

	const requested = Number(options.breakpoints);
	const limit = Number.isFinite(requested) && requested > 0
		? Math.min(Math.trunc(requested), MAX_BREAKPOINTS)
		: DEFAULT_BREAKPOINTS;

	let used = 0;
	if (markSystem(anthropic)) used++;

	const messages = Array.isArray(anthropic.messages) ? anthropic.messages : [];
	for (let i = messages.length - 1; i >= 0 && used < limit; i--) {
		if (markMessage(messages[i])) used++;
	}

	return used;
}
