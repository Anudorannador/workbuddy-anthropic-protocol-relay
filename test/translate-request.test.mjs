import test from "node:test";
import assert from "node:assert/strict";
import {
	toAnthropic,
	mapToolChoice,
	normalizeAlternation,
	DEFAULT_MAX_TOKENS,
	MAX_TOKENS_CAP,
} from "../src/translate-request.mjs";

const base = (overrides = {}) => ({
	model: "claude-haiku-5-5-1m-high",
	messages: [{ role: "user", content: "hi" }],
	...overrides,
});

test("merges system messages into a single top-level system string", async () => {
	const { anthropic } = await toAnthropic(
		base({
			messages: [
				{ role: "system", content: "rule one" },
				{ role: "developer", content: "rule two" },
				{ role: "user", content: "hi" },
			],
		}),
	);
	assert.equal(anthropic.system, "rule one\n\nrule two");
	assert.equal(anthropic.messages.length, 1);
	assert.equal(anthropic.messages[0].role, "user");
});

test("maps OpenAI tools onto Anthropic input_schema", async () => {
	const { anthropic } = await toAnthropic(
		base({
			tools: [
				{
					type: "function",
					function: {
						name: "get_time",
						description: "current time",
						parameters: { type: "object", properties: { tz: { type: "string" } } },
					},
				},
			],
		}),
	);
	assert.deepEqual(anthropic.tools, [
		{
			name: "get_time",
			description: "current time",
			input_schema: { type: "object", properties: { tz: { type: "string" } } },
		},
	]);
});

test("upgrades legacy functions and function_call", async () => {
	const { anthropic } = await toAnthropic(
		base({
			functions: [{ name: "ping", parameters: { type: "object", properties: {} } }],
			function_call: "auto",
		}),
	);
	assert.equal(anthropic.tools[0].name, "ping");
	assert.equal(anthropic.tool_choice.type, "auto");
});

test("converts assistant tool_calls into tool_use blocks", async () => {
	const { anthropic } = await toAnthropic(
		base({
			messages: [
				{ role: "user", content: "call it" },
				{
					role: "assistant",
					content: null,
					tool_calls: [
						{ id: "call_1", type: "function", function: { name: "get_time", arguments: '{"tz":"UTC"}' } },
					],
				},
			],
		}),
	);
	const assistant = anthropic.messages[1];
	assert.equal(assistant.role, "assistant");
	assert.deepEqual(assistant.content[0], {
		type: "tool_use",
		id: "call_1",
		name: "get_time",
		input: { tz: "UTC" },
	});
});

test("places tool results in a user message before the next turn", async () => {
	const { anthropic } = await toAnthropic(
		base({
			messages: [
				{ role: "user", content: "call it" },
				{
					role: "assistant",
					content: null,
					tool_calls: [{ id: "a", type: "function", function: { name: "x", arguments: "{}" } }],
				},
				{ role: "tool", tool_call_id: "a", content: "result-a" },
			],
		}),
	);
	const last = anthropic.messages.at(-1);
	assert.equal(last.role, "user");
	assert.deepEqual(last.content, [
		{ type: "tool_result", tool_use_id: "a", content: "result-a" },
	]);
});

test("normalises alternation and seeds a leading user turn", () => {
	const out = normalizeAlternation([
		{ role: "assistant", content: [{ type: "text", text: "hello" }] },
		{ role: "user", content: [{ type: "text", text: "a" }] },
		{ role: "user", content: [{ type: "text", text: "b" }] },
	]);
	assert.equal(out[0].role, "user");
	assert.equal(out[1].role, "assistant");
	assert.equal(out[2].content.length, 2, "adjacent user turns are merged");
});

test("drops parameters the upstream does not accept", async () => {
	const { anthropic } = await toAnthropic(
		base({
			presence_penalty: 0.5,
			frequency_penalty: 0.5,
			logit_bias: { a: 1 },
			seed: 42,
			logprobs: true,
			top_logprobs: 3,
			n: 2,
			stream_options: { include_usage: true },
			parallel_tool_calls: false,
		}),
	);
	for (const key of [
		"presence_penalty",
		"frequency_penalty",
		"logit_bias",
		"seed",
		"logprobs",
		"top_logprobs",
		"n",
		"stream_options",
	]) {
		assert.equal(key in anthropic, false, `${key} must be dropped`);
	}
	assert.equal("parallel_tool_calls" in anthropic, false);
});

test("applies max_tokens defaults and caps", async () => {
	const a = await toAnthropic(base());
	assert.equal(a.anthropic.max_tokens, DEFAULT_MAX_TOKENS);

	const b = await toAnthropic(base({ max_tokens: 999999 }));
	assert.equal(b.anthropic.max_tokens, MAX_TOKENS_CAP);

	const c = await toAnthropic(base({ max_completion_tokens: 4096 }));
	assert.equal(c.anthropic.max_tokens, 4096);
});

test("derives reasoning from the model id suffix", async () => {
	const { anthropic, effort } = await toAnthropic(base());
	assert.deepEqual(anthropic.thinking, { type: "adaptive" });
	assert.deepEqual(anthropic.output_config, { effort: "high" });
	assert.equal(effort, "high");
});

test("derives reasoning from reasoning_effort when the id has no suffix", async () => {
	const { anthropic } = await toAnthropic(
		base({ model: "claude-haiku-5-5-1m", reasoning_effort: "minimal" }),
	);
	assert.deepEqual(anthropic.output_config, { effort: "low" });
});

test("injects a JSON instruction for response_format", async () => {
	const { anthropic } = await toAnthropic(
		base({ response_format: { type: "json_object" } }),
	);
	assert.match(anthropic.system, /single valid JSON value/);
});

test("maps data URL images to base64 image blocks", async () => {
	const { anthropic } = await toAnthropic(
		base({
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "what is this" },
						{ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
					],
				},
			],
		}),
	);
	const blocks = anthropic.messages[0].content;
	assert.deepEqual(blocks[1], {
		type: "image",
		source: { type: "base64", media_type: "image/png", data: "AAAA" },
	});
});

test("reports include_usage from stream_options", async () => {
	const { includeUsage } = await toAnthropic(
		base({ stream_options: { include_usage: true } }),
	);
	assert.equal(includeUsage, true);
});

test("mapToolChoice handles every documented form", () => {
	assert.deepEqual(mapToolChoice("none"), { type: "none" });
	assert.deepEqual(mapToolChoice("required"), { type: "any" });
	assert.deepEqual(mapToolChoice("auto"), { type: "auto" });
	assert.deepEqual(mapToolChoice({ type: "function", function: { name: "f" } }), {
		type: "tool",
		name: "f",
	});
	assert.deepEqual(mapToolChoice("auto", false), {
		type: "auto",
		disable_parallel_tool_use: true,
	});
});
