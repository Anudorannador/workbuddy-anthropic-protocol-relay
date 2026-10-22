import test from "node:test";
import assert from "node:assert/strict";
import { decodeModelId, normalizeEffort, EFFORTS } from "../src/model-id.mjs";

test("decodes a model id with context flag and effort", () => {
	assert.deepEqual(decodeModelId("claude-haiku-5-5-1m-high"), {
		model: "claude-haiku-5-5",
		effort: "high",
	});
});

test("decodes a model id with effort but keeps hyphens in the base name", () => {
	assert.deepEqual(decodeModelId("claude-fable-5-1-1m-xhigh"), {
		model: "claude-fable-5-1",
		effort: "xhigh",
	});
});

test("decodes a model id with the context flag only", () => {
	assert.deepEqual(decodeModelId("claude-sonnet-5-5-1m"), {
		model: "claude-sonnet-5-5",
		effort: null,
	});
});

test("leaves unrelated model ids untouched", () => {
	assert.deepEqual(decodeModelId("gpt-4o-mini"), { model: "gpt-4o-mini", effort: null });
	assert.deepEqual(decodeModelId(undefined), { model: undefined, effort: null });
});

test("strips a trailing -1m even without an effort", () => {
	assert.deepEqual(decodeModelId("some-1m"), { model: "some", effort: null });
});

test("accepts any <number><k|m> context marker", () => {
	assert.deepEqual(decodeModelId("claude-haiku-5-5-512k-high"), {
		model: "claude-haiku-5-5",
		effort: "high",
	});
	assert.deepEqual(decodeModelId("claude-opus-5-5-200k"), {
		model: "claude-opus-5-5",
		effort: null,
	});
	assert.deepEqual(decodeModelId("claude-opus-5-5-1M-MAX"), {
		model: "claude-opus-5-5",
		effort: "max",
	});
});

test("leaves ids whose trailing token is not a context marker alone", () => {
	assert.deepEqual(decodeModelId("qwen2.5-72b"), { model: "qwen2.5-72b", effort: null });
	assert.deepEqual(decodeModelId("gpt-4o"), { model: "gpt-4o", effort: null });
	assert.deepEqual(decodeModelId("claude-haiku-5-5-high"), { model: "claude-haiku-5-5-high", effort: null });
});

test("raw: prefix opts out of suffix decoding", () => {
	assert.deepEqual(decodeModelId("raw:some-1m"), { model: "some-1m", effort: null });
	assert.deepEqual(decodeModelId("raw:claude-haiku-5-5-1m-high"), {
		model: "claude-haiku-5-5-1m-high",
		effort: null,
	});
});

test("normalises effort aliases", () => {
	assert.equal(normalizeEffort("minimal"), "low");
	assert.equal(normalizeEffort("HIGH"), "high");
	assert.equal(normalizeEffort("bogus"), null);
	assert.equal(normalizeEffort(undefined), null);
});

test("exposes the supported effort ladder in order", () => {
	assert.deepEqual(EFFORTS, ["low", "medium", "high", "xhigh", "max"]);
});
