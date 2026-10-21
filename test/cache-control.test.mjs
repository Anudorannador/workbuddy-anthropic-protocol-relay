import test from "node:test";
import assert from "node:assert/strict";
import {
	applyCacheControl,
	DEFAULT_BREAKPOINTS,
	MAX_BREAKPOINTS,
} from "../src/cache-control.mjs";

const systemOf = (body) => body.system;

test("converts a system string into a single cached text block", () => {
	const body = { system: "you are terse", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] };
	const used = applyCacheControl(body);
	assert.equal(used, 2);
	assert.deepEqual(systemOf(body), [
		{ type: "text", text: "you are terse", cache_control: { type: "ephemeral" } },
	]);
});

test("marks the newest turn first, walking backwards", () => {
	const body = {
		messages: [
			{ role: "user", content: [{ type: "text", text: "one" }] },
			{ role: "assistant", content: [{ type: "text", text: "two" }] },
			{ role: "user", content: [{ type: "text", text: "three" }] },
		],
	};
	applyCacheControl(body, { breakpoints: 2 });
	assert.equal(body.messages[2].content[0].cache_control.type, "ephemeral");
	assert.equal(body.messages[1].content[0].cache_control.type, "ephemeral");
	assert.equal(body.messages[0].content[0].cache_control, undefined);
});

test("never exceeds the requested breakpoint budget", () => {
	const body = {
		system: "sys",
		messages: Array.from({ length: 10 }, (_, i) => ({
			role: i % 2 === 0 ? "user" : "assistant",
			content: [{ type: "text", text: `m${i}` }],
		})),
	};
	const used = applyCacheControl(body, { breakpoints: 1 });
	assert.equal(used, 1);
	const all = JSON.stringify(body);
	assert.equal(all.match(/"cache_control"/g).length, 1);
});

test("clamps an oversized breakpoint request to the upstream maximum", () => {
	const body = {
		system: "sys",
		messages: Array.from({ length: 10 }, (_, i) => ({
			role: "user",
			content: [{ type: "text", text: `m${i}` }],
		})),
	};
	const used = applyCacheControl(body, { breakpoints: 99 });
	assert.equal(used, MAX_BREAKPOINTS);
});

test("defaults to the documented breakpoint count", () => {
	const body = {
		system: "sys",
		messages: Array.from({ length: 10 }, (_, i) => ({
			role: "user",
			content: [{ type: "text", text: `m${i}` }],
		})),
	};
	assert.equal(applyCacheControl(body), DEFAULT_BREAKPOINTS);
});

test("skips blocks that already carry a breakpoint", () => {
	const cached = { type: "text", text: "hi", cache_control: { type: "ephemeral" } };
	const body = { messages: [{ role: "user", content: [cached] }] };
	assert.equal(applyCacheControl(body), 0);
	assert.equal(cached.cache_control.type, "ephemeral");
});

test("ignores non-cacheable block types", () => {
	const body = { messages: [{ role: "user", content: [{ type: "thinking", thinking: "x" }] }] };
	assert.equal(applyCacheControl(body), 0);
});

test("accepts tool_use and tool_result blocks", () => {
	const body = {
		messages: [
			{ role: "assistant", content: [{ type: "tool_use", id: "t1", name: "f", input: {} }] },
			{ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
		],
	};
	assert.equal(applyCacheControl(body, { breakpoints: 2 }), 2);
	assert.equal(body.messages[0].content[0].cache_control.type, "ephemeral");
	assert.equal(body.messages[1].content[0].cache_control.type, "ephemeral");
});

test("is a no-op without a body or messages", () => {
	assert.equal(applyCacheControl(null), 0);
	assert.equal(applyCacheControl({}), 0);
	assert.equal(applyCacheControl({ messages: [] }), 0);
});

test("keeps an array-shaped system prompt and caches its last text block", () => {
	const body = {
		system: [{ type: "text", text: "a" }, { type: "text", text: "b" }],
		messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
	};
	assert.equal(applyCacheControl(body), 2);
	assert.equal(body.system[0].cache_control, undefined);
	assert.equal(body.system[1].cache_control.type, "ephemeral");
});
