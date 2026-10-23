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

test("effort can come from reasoning.effort on a plain model id", async () => {
	const { anthropic, effort } = await toAnthropic(base({ model: "claude-haiku-5-5", reasoning: { effort: "high" } }));
	assert.equal(effort, "high");
	assert.deepEqual(anthropic.thinking, { type: "adaptive" });
	assert.deepEqual(anthropic.output_config, { effort: "high" });
});

test("an id suffix wins over the request-level effort", async () => {
	const { effort } = await toAnthropic(base({ reasoning: { effort: "low" } }));
	assert.equal(effort, "high");
});

test("reasoning.effort accepts aliases and rejects junk", async () => {
	const alias = await toAnthropic(base({ model: "claude-haiku-5-5", reasoning: { effort: "minimal" } }));
	assert.equal(alias.effort, "low");

	const junk = await toAnthropic(base({ model: "claude-haiku-5-5", reasoning: { effort: "turbo" } }));
	assert.equal(junk.effort, null);
	assert.equal(junk.anthropic.thinking, undefined);
});

test("no suffix and no request effort means no thinking block", async () => {
	const { anthropic, effort } = await toAnthropic(base({ model: "claude-haiku-5-5" }));
	assert.equal(effort, null);
	assert.equal(anthropic.thinking, undefined);
});

test("a missing tool_call id is filled deterministically", async () => {
	const body = {
		model: "claude-haiku-5-5",
		messages: [
			{ role: "user", content: "call it" },
			{
				role: "assistant",
				content: null,
				tool_calls: [{ type: "function", function: { name: "get_time", arguments: "{}" } }],
			},
			{ role: "tool", tool_call_id: "generated", content: "12:00" },
		],
	};
	const first = await toAnthropic(body);
	const second = await toAnthropic(body);
	const idOf = (r) => r.anthropic.messages.find((m) => m.role === "assistant").content[0].id;
	assert.match(idOf(first), /^toolu_[0-9a-f]{8}$/);
	assert.equal(idOf(first), idOf(second));

	const other = await toAnthropic({
		...body,
		messages: [body.messages[0], { ...body.messages[1], tool_calls: [{ type: "function", function: { name: "get_date", arguments: "{}" } }] }, body.messages[2]],
	});
	assert.notEqual(idOf(other), idOf(first));
});
