/**
 * Prefix drift diagnostics.
 *
 * Prompt caching is prefix based: the upstream can only reuse a cache entry when
 * everything up to the breakpoint is byte-identical to the request that created
 * it. "Cache hit rate is 0%" therefore always has the same shape of cause - some
 * segment near the head of the prompt changes on every turn - and the useful
 * question is *where*.
 *
 * This module keeps a fingerprint of the last request per model and reports the
 * first segment that differs, plus coarse volatility hints (how many
 * timestamp-like or identifier-like tokens the segment carries) so the offending
 * block can be identified without writing prompt text to a log.
 */

/** FNV-1a, 32 bit. Enough to detect drift, cheap on multi-hundred-KB prompts. */
export function fnv1a(input) {
	const text = typeof input === "string" ? input : String(input ?? "");
	let hash = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		hash ^= text.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash.toString(16).padStart(8, "0");
}

const TIME_LIKE = /(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?)|(\b\d{1,2}:\d{2}:\d{2}\b)|(\b(19|20)\d{2}\b)/g;
const ID_LIKE = /\b[0-9a-f]{8,}\b|\b\d{6,}\b/gi;

/**
 * Count tokens that commonly change between two otherwise identical prompts.
 * @param {string} text
 * @returns {{ time: number, ids: number }}
 */
export function volatilityOf(text) {
	if (typeof text !== "string") return { time: 0, ids: 0 };
	return {
		time: (text.match(TIME_LIKE) ?? []).length,
		ids: (text.match(ID_LIKE) ?? []).length,
	};
}

function fingerprint(segment) {
	const text = typeof segment.text === "string" ? segment.text : JSON.stringify(segment.text ?? "");
	const v = volatilityOf(text);
	return {
		hash: fnv1a(text),
		kind: segment.kind ?? "segment",
		role: segment.role ?? null,
		len: text.length,
		time: v.time,
		ids: v.ids,
	};
}

/**
 * @param {{ limit?: number }} [options]
 */
export function createPrefixWatcher(options = {}) {
	const limit = Number.isFinite(options.limit) ? options.limit : 64;
	/** @type {Map<string, ReturnType<typeof fingerprint>[]>} */
	const seen = new Map();

	return {
		/**
		 * Compare this request with the previous one for the same model.
		 * @param {string} model
		 * @param {Array<{ kind?: string, role?: string|null, text: string }>} segments
		 * @returns {{
		 *   first: boolean,
		 *   stable: number,
		 *   segs: number,
		 *   drift: null | {
		 *     index: number, kind: string, role: string|null,
		 *     lenFrom: number, lenTo: number,
		 *     timeFrom: number, timeTo: number, idsFrom: number, idsTo: number,
		 *   },
		 * }}
		 */
		observe(model, segments) {
			const current = (segments ?? []).map(fingerprint);
			const previous = seen.get(model);
			seen.set(model, current);
			if (seen.size > limit) seen.delete(seen.keys().next().value);

			if (!previous) return { first: true, stable: current.length, segs: current.length, drift: null };

			let i = 0;
			while (i < previous.length && i < current.length && previous[i].hash === current[i].hash) i++;

			if (i === previous.length && i === current.length) {
				return { first: false, stable: i, segs: current.length, drift: null };
			}

			const from = previous[i] ?? { kind: "absent", role: null, len: 0, time: 0, ids: 0 };
			const to = current[i] ?? { kind: "absent", role: null, len: 0, time: 0, ids: 0 };
			return {
				first: false,
				stable: i,
				segs: current.length,
				drift: {
					index: i,
					kind: to.kind,
					role: to.role,
					lenFrom: from.len,
					lenTo: to.len,
					timeFrom: from.time,
					timeTo: to.time,
					idsFrom: from.ids,
					idsTo: to.ids,
				},
			};
		},
	};
}
