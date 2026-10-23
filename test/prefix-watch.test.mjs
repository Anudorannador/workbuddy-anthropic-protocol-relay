import test from "node:test";
import assert from "node:assert/strict";
import {
	createPrefixWatcher,
	fnv1a,
	volatilityOf,
} from "../src/prefix-watch.mjs";

const seg = (text, kind = "msg[0]", role = "user") => ({ kind, role, text });

test("fnv1a is stable and distinguishes content", () => {
	assert.equal(fnv1a("abc"), fnv1a("abc"));
	assert.notEqual(fnv1a("abc"), fnv1a("abd"));
	assert.match(fnv1a(""), /^[0-9a-f]{8}$/);
});

test("volatilityOf counts timestamps and identifier-like tokens", () => {
	const v = volatilityOf("at 2026-10-23T17:09:20 and 17:09:20, id 3ecf19f5, build 137951");
	assert.ok(v.time >= 2, `time=${v.time}`);
	assert.ok(v.ids >= 2, `ids=${v.ids}`);
	assert.deepEqual(volatilityOf("stable text"), { time: 0, ids: 0 });
});

test("the first observation for a model reports no drift", () => {
	const w = createPrefixWatcher();
	const r = w.observe("m", [seg("a"), seg("b", "msg[1]")]);
	assert.equal(r.first, true);
	assert.equal(r.drift, null);
	assert.equal(r.segs, 2);
});

test("identical requests report a fully stable prefix", () => {
	const w = createPrefixWatcher();
	const body = [seg("system", "system", null), seg("hello", "msg[0]")];
	w.observe("m", body);
	const r = w.observe("m", body);
	assert.equal(r.drift, null);
	assert.equal(r.stable, 2);
});

test("a changed system prompt is reported at the head", () => {
	const w = createPrefixWatcher();
	w.observe("m", [seg("system v1", "system", null), seg("hello")]);
	const r = w.observe("m", [seg("system v2", "system", null), seg("hello")]);
	assert.equal(r.drift.kind, "system");
	assert.equal(r.drift.index, 0);
	assert.equal(r.stable, 0);
	assert.ok(r.drift.timeFrom >= 0);
});

test("an appended turn keeps the earlier segments stable", () => {
	const w = createPrefixWatcher();
	w.observe("m", [seg("s", "system", null), seg("one", "msg[0]"), seg("two", "msg[1]", "assistant")]);
	const r = w.observe("m", [
		seg("s", "system", null),
		seg("one", "msg[0]"),
		seg("two", "msg[1]", "assistant"),
		seg("three", "msg[2]"),
	]);
	assert.equal(r.stable, 3);
	// The new segment is the first difference, which is expected for an append.
	assert.equal(r.drift.index, 3);
	assert.equal(r.drift.kind, "msg[2]");
	assert.equal(r.segs, 4);
});

test("models are tracked independently", () => {
	const w = createPrefixWatcher();
	w.observe("a", [seg("x")]);
	const r = w.observe("b", [seg("y")]);
	assert.equal(r.first, true);
});

test("the watcher keeps a bounded number of models", () => {
	const w = createPrefixWatcher({ limit: 2 });
	w.observe("a", [seg("1")]);
	w.observe("b", [seg("2")]);
	w.observe("c", [seg("3")]);
	assert.equal(w.observe("a", [seg("1")]).first, true);
});
