/**
 * Model identifier helpers.
 *
 * A model id may encode request options as a suffix:
 *
 *   <upstream-model>-1m-<effort>
 *
 * Examples:
 *   claude-haiku-5-5-1m-high   -> upstream "claude-haiku-5-5", effort "high"
 *   claude-sonnet-5-5-1m       -> upstream "claude-sonnet-5-5", no effort
 *   gpt-4o-mini                -> unchanged
 *
 * The suffix exists because most desktop clients cannot set a per-model
 * reasoning effort; encoding it in the model id gives one entry per preset.
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

const SUFFIX = /^(.*?)-1m(?:-(low|medium|high|xhigh|max))?$/;

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
	return { model: m[1], effort: m[2] ?? null };
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
