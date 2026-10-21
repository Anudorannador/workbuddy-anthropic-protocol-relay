/**
 * Per-model overrides.
 *
 * Two things a client often cannot express but a deployment needs:
 *
 *   1. routing a client-facing name onto a different upstream name
 *   2. a max_tokens value, because many clients omit it entirely
 *
 * Both are configured as a compact string so they survive environment
 * variables, shell quoting and docker `-e` flags.
 *
 *   RELAY_MODEL_MAP=claude-sonnet-5-5=claude-sonnet-5-5-latest,fast=gpt-4o-mini
 *   RELAY_MAX_TOKENS_MAP=claude-opus-5-5:64000,claude-haiku-5-5:32000
 *
 * `*` works as a catch-all key in both maps.
 */

/**
 * Parse `from=to,from=to` into a lookup table.
 * @param {unknown} spec
 * @returns {Map<string, string>}
 */
export function parseModelMap(spec) {
	const map = new Map();
	if (typeof spec !== "string" || !spec.trim()) return map;

	for (const raw of spec.split(/[,\n]/)) {
		const entry = raw.trim();
		if (!entry) continue;
		const eq = entry.indexOf("=");
		if (eq <= 0) continue;
		const from = entry.slice(0, eq).trim();
		const to = entry.slice(eq + 1).trim();
		if (from && to) map.set(from, to);
	}
	return map;
}

/**
 * Parse `model:1234,model:5678` into a lookup table.
 * @param {unknown} spec
 * @returns {Map<string, number>}
 */
export function parseMaxTokensMap(spec) {
	const map = new Map();
	if (typeof spec !== "string" || !spec.trim()) return map;

	for (const raw of spec.split(/[,\n]/)) {
		const entry = raw.trim();
		if (!entry) continue;
		const colon = entry.indexOf(":");
		if (colon <= 0) continue;
		const model = entry.slice(0, colon).trim();
		const value = Number(entry.slice(colon + 1).trim());
		if (!model || !Number.isFinite(value) || value <= 0) continue;
		map.set(model, Math.trunc(value));
	}
	return map;
}

/**
 * Resolve a client-facing model name against the map.
 * @param {unknown} model
 * @param {Map<string, string>} [map]
 * @returns {unknown}
 */
export function resolveModel(model, map) {
	if (!map || typeof model !== "string") return model;
	return map.get(model) ?? map.get("*") ?? model;
}

/**
 * Decide the upstream max_tokens value.
 *
 * Precedence: explicit request, then the per-model map, then the global
 * default, always clamped to the hard cap.
 *
 * @param {{
 *   requested?: unknown,
 *   model?: unknown,
 *   map?: Map<string, number>,
 *   fallback?: number,
 *   cap: number,
 * }} input
 * @returns {number}
 */
export function resolveMaxTokens(input) {
	const cap = Number.isFinite(input.cap) && input.cap > 0 ? input.cap : 128000;
	const clamp = (n) => Math.min(Math.max(Math.trunc(n), 1), cap);

	const requested = Number(input.requested);
	if (Number.isFinite(requested) && requested > 0) return clamp(requested);

	const mapped = input.map?.get(String(input.model ?? "")) ?? input.map?.get("*");
	if (Number.isFinite(mapped) && mapped > 0) return clamp(mapped);

	const fallback = Number(input.fallback);
	if (Number.isFinite(fallback) && fallback > 0) return clamp(fallback);

	return clamp(32000);
}
