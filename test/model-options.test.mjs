import test from "node:test";
import assert from "node:assert/strict";
import {
	parseMaxTokensMap,
	parseModelMap,
	resolveMaxTokens,
	resolveModel,
} from "../src/model-options.mjs";

test("parses a model map", () => {
	const map = parseModelMap("a=b,c=d");
	assert.equal(map.get("a"), "b");
	assert.equal(map.get("c"), "d");
	assert.equal(map.size, 2);
});

test("tolerates whitespace, newlines and trailing commas", () => {
	const map = parseModelMap(" a = b ,\n c = d ,\n");
	assert.equal(map.get("a"), "b");
	assert.equal(map.get("c"), "d");
	assert.equal(map.size, 2);
});

test("ignores malformed model map entries", () => {
	assert.equal(parseModelMap("=b").size, 0);
	assert.equal(parseModelMap("a=").size, 0);
	assert.equal(parseModelMap("a").size, 0);
	assert.equal(parseModelMap("").size, 0);
	assert.equal(parseModelMap(undefined).size, 0);
});

test("keeps '=' inside the target name", () => {
	const map = parseModelMap("alias=name=with=equals");
	assert.equal(map.get("alias"), "name=with=equals");
});

test("parses a max_tokens map and drops invalid values", () => {
	const map = parseMaxTokensMap("a:1000,b:0,c:-5,d:abc,e:");
	assert.equal(map.get("a"), 1000);
	assert.equal(map.size, 1);
});

test("resolves an exact model and falls back to a wildcard", () => {
	const map = parseModelMap("a=b,*=fallback");
	assert.equal(resolveModel("a", map), "b");
	assert.equal(resolveModel("zzz", map), "fallback");
	assert.equal(resolveModel("a", undefined), "a");
	assert.equal(resolveModel("a", new Map()), "a");
});

test("leaves a non-string model untouched", () => {
	assert.equal(resolveModel(42, parseModelMap("a=b")), 42);
});

test("max_tokens precedence: request, then map, then fallback", () => {
	const map = parseMaxTokensMap("m:64000,*:8000");
	assert.equal(
		resolveMaxTokens({ requested: 1234, model: "m", map, fallback: 32000, cap: 128000 }),
		1234,
	);
	assert.equal(
		resolveMaxTokens({ requested: undefined, model: "m", map, fallback: 32000, cap: 128000 }),
		64000,
	);
	assert.equal(
		resolveMaxTokens({ requested: undefined, model: "other", map, fallback: 9999, cap: 128000 }),
		8000,
	);
	assert.equal(
		resolveMaxTokens({ requested: undefined, model: "other", map: new Map(), fallback: 9999, cap: 128000 }),
		9999,
	);
});

test("max_tokens is clamped to the hard cap", () => {
	assert.equal(
		resolveMaxTokens({ requested: 999999, model: "m", map: new Map(), fallback: 32000, cap: 128000 }),
		128000,
	);
	assert.equal(
		resolveMaxTokens({ requested: 1, model: "m", map: new Map(), fallback: 32000, cap: 128000 }),
		1,
	);
});

test("max_tokens falls back to 32000 when nothing is configured", () => {
	assert.equal(
		resolveMaxTokens({ requested: undefined, model: "m", map: new Map(), cap: 128000 }),
		32000,
	);
});
