import test from "node:test";
import assert from "node:assert/strict";
import {
	createSseTranslator,
	convertNonStreaming,
	mapFinish,
	openAIError,
} from "../src/translate-response.mjs";

const ctx = { id: "chatcmpl-test", displayModel: "claude-haiku-5-5-1m-high" };

function frame(payload) {
	return `data: ${JSON.stringify(payload)}\n\n`;
}

function sse(events) {
	return events
		.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
		.join("");
}

function collect() {
	const out = [];
	const translator = createSseTranslator({
		write: (chunk) => out.push(chunk),
		ctx,
		includeUsage: true,
		now: () => 1700000000000,
	});
	return {
		translator,
		out,
		frames() {
			return out
				.join("")
				.split("\n\n")
				.filter((f) => f.startsWith("data:"))
				.map((f) => f.slice(5).trim());
		},
		parsed() {
			return this.frames()
				.filter((f) => f !== "[DONE]")
				.map((f) => JSON.parse(f));
		},
	};
}

test("maps stop reasons to OpenAI finish reasons", () => {
	assert.equal(mapFinish("end_turn"), "stop");
	assert.equal(mapFinish("tool_use"), "tool_calls");
	assert.equal(mapFinish("max_tokens"), "length");
	assert.equal(mapFinish("model_context_window_exceeded"), "length");
	assert.equal(mapFinish("refusal"), "content_filter");
});

test("translates a text stream into OpenAI chunks", () => {
	const c = collect();
	c.translator.push(
		sse([
			{ type: "message_start", message: { usage: { input_tokens: 5, cache_read_input_tokens: 2 } } },
			{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
			{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "OK" } },
			{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } },
			{ type: "message_stop" },
		]),
	);
	c.translator.finish();

	const frames = c.parsed();
	assert.equal(frames[0].choices[0].delta.role, "assistant");
	assert.ok(frames.some((f) => f.choices?.[0]?.delta?.content === "OK"));

	const terminal = frames.find((f) => f.choices?.[0]?.finish_reason === "stop");
	assert.ok(terminal, "a terminal chunk with finish_reason=stop is emitted");

	const usage = frames.find((f) => f.usage);
	assert.deepEqual(usage.usage, {
		prompt_tokens: 5,
		completion_tokens: 3,
		total_tokens: 8,
		prompt_tokens_details: { cached_tokens: 2 },
	});

	assert.equal(c.frames().at(-1), "[DONE]");
});

test("translates tool_use blocks into accumulating tool_calls", () => {
	const c = collect();
	c.translator.push(
		sse([
			{ type: "message_start", message: { usage: { input_tokens: 1 } } },
			{
				type: "content_block_start",
				index: 0,
				content_block: { type: "tool_use", id: "toolu_1", name: "get_time" },
			},
			{ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"tz"' } },
			{ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: ': "UTC"}' } },
			{ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 9 } },
			{ type: "message_stop" },
		]),
	);

	const calls = c
		.parsed()
		.flatMap((f) => f.choices?.[0]?.delta?.tool_calls ?? []);

	assert.equal(calls[0].index, 0);
	assert.equal(calls[0].id, "toolu_1");
	assert.equal(calls[0].function.name, "get_time");
	const args = calls.map((c2) => c2.function?.arguments ?? "").join("");
	assert.equal(args, '{"tz": "UTC"}');

	const terminal = c.parsed().find((f) => f.choices?.[0]?.finish_reason);
	assert.equal(terminal.choices[0].finish_reason, "tool_calls");
});

test("maps thinking deltas onto reasoning_content", () => {
	const c = collect();
	c.translator.push(
		sse([
			{ type: "message_start", message: {} },
			{ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "pondering" } },
		]),
	);
	const frame2 = c.parsed().find((f) => f.choices?.[0]?.delta?.reasoning_content);
	assert.equal(frame2.choices[0].delta.reasoning_content, "pondering");
});

test("handles a stream split across arbitrary chunk boundaries", () => {
	const c = collect();
	const raw = sse([
		{ type: "message_start", message: {} },
		{ type: "content_block_delta", delta: { type: "text_delta", text: "he" } },
		{ type: "content_block_delta", delta: { type: "text_delta", text: "llo" } },
		{ type: "message_stop" },
	]);
	for (const ch of raw) c.translator.push(ch);

	const text = c
		.parsed()
		.map((f) => f.choices?.[0]?.delta?.content ?? "")
		.join("");
	assert.equal(text, "hello");
});

test("finish is idempotent and always terminates with DONE", () => {
	const c = collect();
	c.translator.push(sse([{ type: "message_start", message: {} }]));
	c.translator.finish();
	c.translator.finish();
	assert.equal(c.frames().filter((f) => f === "[DONE]").length, 1);
});

test("non-streaming conversion produces a chat.completion", () => {
	const out = convertNonStreaming(
		{
			id: "msg_1",
			content: [
				{ type: "text", text: "hello " },
				{ type: "text", text: "world" },
			],
			stop_reason: "end_turn",
			usage: { input_tokens: 4, output_tokens: 2, cache_read_input_tokens: 1 },
		},
		ctx,
	);
	assert.equal(out.object, "chat.completion");
	assert.equal(out.choices[0].message.content, "hello world");
	assert.equal(out.choices[0].finish_reason, "stop");
	assert.equal(out.usage.total_tokens, 6);
	assert.equal(out.usage.prompt_tokens_details.cached_tokens, 1);
});

test("non-streaming conversion surfaces tool calls and reasoning", () => {
	const out = convertNonStreaming(
		{
			id: "msg_2",
			content: [
				{ type: "thinking", thinking: "need the time" },
				{ type: "tool_use", id: "toolu_9", name: "get_time", input: { tz: "UTC" } },
			],
			stop_reason: "tool_use",
			usage: { input_tokens: 2, output_tokens: 1 },
		},
		ctx,
	);
	const message = out.choices[0].message;
	assert.equal(message.content, null);
	assert.equal(message.reasoning_content, "need the time");
	assert.deepEqual(message.tool_calls[0].function, {
		name: "get_time",
		arguments: JSON.stringify({ tz: "UTC" }),
	});
	assert.equal(out.choices[0].finish_reason, "tool_calls");
});

test("error helper emits an OpenAI-shaped body", () => {
	const body = JSON.parse(openAIError(429, "slow down", "rate_limit_error"));
	assert.deepEqual(body, {
		error: { message: "slow down", type: "rate_limit_error", code: 429 },
	});
});
