/**
 * Model identifier helpers.
 *
 * A model id may encode request options as a suffix:
 *
 *   <upstream-model>-<context><unit>[-<effort>]
 *
 * Examples:
 *   claude-haiku-5-5-1m-high    -> "claude-haiku-5-5", effort "high"
 *   claude-haiku-5-5-512k-high  -> "claude-haiku-5-5", effort "high"
 *   claude-sonnet-5-5-1m        -> "claude-sonnet-5-5", no effort
 *   gpt-4o-mini                 -> unchanged
 *
 * The context marker is decorative: it labels a client-side budget (the client
 * already declares it via maxInputTokens) and is never sent upstream, because
 * Anthropic has no such parameter. The effort marker matters whenever the client
 * cannot send an effort of its own.
 */

/** Reasoning effort levels accepted by the relay, ordered low -> high. */
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

/** Maps foreign effort names onto the levels the upstream understands. */
export const EFFORT_ALIAS = {
	minimal: "low",
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "xhigh",
	max: "max",
};

const SUFFIX = /^(.*?)-(\d+(?:\.\d+)?)([km])(?:-(low|medium|high|xhigh|max))?$/i;

/**
 * Split a model id into its upstream name and optional effort.
 *
 * Prefix an id with `raw:` to opt out of suffix decoding, which matters when a
 * real model name genuinely ends in `-1m`.
 *
 * @param {unknown} raw
 * @returns {{ model: unknown, effort: string|null }}
 */
export function decodeModelId(raw) {
	if (typeof raw !== "string") return { model: raw, effort: null };
	if (raw.startsWith("raw:")) return { model: raw.slice(4), effort: null };
	const m = raw.match(SUFFIX);
	if (!m) return { model: raw, effort: null };
	return { model: m[1], effort: m[4] ? m[4].toLowerCase() : null };
}

/**
 * Normalise an arbitrary effort string to a supported level.
 * @param {unknown} value
 * @returns {string|null}
 */
export function normalizeEffort(value) {
	if (typeof value !== "string") return null;
	const key = value.trim().toLowerCase();
	return EFFORT_ALIAS[key] ?? null;
}
