import test from "node:test";
import assert from "node:assert/strict";
import { toAnthropic } from "../src/translate-request.mjs";
import { parseMaxTokensMap, parseModelMap } from "../src/model-options.mjs";

const base = (overrides = {}) => ({
	model: "claude-haiku-5-5-1m-high",
	messages: [
		{ role: "system", content: "be terse" },
		{ role: "user", content: "hi" },
	],
	...overrides,
});

test("model map runs after suffix decoding", async () => {
	const { anthropic, effort, mappedFrom } = await toAnthropic(
		base(),
		{ modelMap: parseModelMap("claude-haiku-5-5=claude-haiku-5-5-20260101") },
	);
	assert.equal(anthropic.model, "claude-haiku-5-5-20260101");
	assert.equal(effort, "high");
	assert.equal(mappedFrom, "claude-haiku-5-5");
});

test("mappedFrom is null when no mapping applies", async () => {
	const { anthropic, mappedFrom } = await toAnthropic(base(), {
		modelMap: parseModelMap("something-else=x"),
	});
	assert.equal(anthropic.model, "claude-haiku-5-5");
	assert.equal(mappedFrom, null);
});

test("wildcard mapping rewrites every model", async () => {
	const { anthropic } = await toAnthropic(base({ model: "gpt-4o" }), {
		modelMap: parseModelMap("*=claude-haiku-5-5"),
	});
	assert.equal(anthropic.model, "claude-haiku-5-5");
});

test("max_tokens comes from the map when the request omits it", async () => {
	const { anthropic } = await toAnthropic(base(), {
		maxTokensMap: parseMaxTokensMap("claude-haiku-5-5:64000"),
	});
	assert.equal(anthropic.max_tokens, 64000);
});

test("an explicit request value beats the map", async () => {
	const { anthropic } = await toAnthropic(base({ max_tokens: 1234 }), {
		maxTokensMap: parseMaxTokensMap("claude-haiku-5-5:64000"),
	});
	assert.equal(anthropic.max_tokens, 1234);
});

test("global default applies when neither request nor map provides a value", async () => {
	const { anthropic } = await toAnthropic(base(), { defaultMaxTokens: 9000 });
	assert.equal(anthropic.max_tokens, 9000);
});

test("cache control turns the system prompt into a cached block", async () => {
	const { anthropic, cacheBreakpoints } = await toAnthropic(base(), {
		cacheControl: { enabled: true, breakpoints: 3 },
	});
	assert.equal(cacheBreakpoints, 2);
	assert.ok(Array.isArray(anthropic.system));
	assert.equal(anthropic.system[0].cache_control.type, "ephemeral");
});

test("cache control is skipped when disabled", async () => {
	const { anthropic, cacheBreakpoints } = await toAnthropic(base(), {
		cacheControl: { enabled: false },
	});
	assert.equal(cacheBreakpoints, 0);
	assert.equal(typeof anthropic.system, "string");
	assert.equal(JSON.stringify(anthropic).includes("cache_control"), false);
});

test("cache breakpoints never land on the thinking config", async () => {
	const { anthropic } = await toAnthropic(base(), {
		cacheControl: { enabled: true, breakpoints: 4 },
	});
	const breaks = JSON.stringify(anthropic).match(/"cache_control"/g) ?? [];
	assert.ok(breaks.length <= 4);
	assert.deepEqual(anthropic.thinking, { type: "adaptive" });
});
