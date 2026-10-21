/**
 * Anthropic Messages -> OpenAI Chat Completions response translation.
 *
 * Handles both the streaming (SSE) and the non-streaming JSON shape.
 */

/** Map an Anthropic stop_reason onto an OpenAI finish_reason. */
export function mapFinish(stopReason) {
	switch (stopReason) {
		case "tool_use":
			return "tool_calls";
		case "max_tokens":
		case "model_context_window_exceeded":
			return "length";
		case "refusal":
			return "content_filter";
		case "stop_sequence":
		case "end_turn":
			return "stop";
		default:
			return "stop";
	}
}

/**
 * Build a streaming translator.
 *
 * The translator is transport agnostic: it only calls `write(string)`.
 * Feed it raw Anthropic SSE text with `push()`; call `finish()` when the
 * upstream stream ends. It emits OpenAI SSE frames and terminates once with
 * `data: [DONE]`.
 *
 * @param {{
 *   write: (chunk: string) => void,
 *   ctx: { id: string, displayModel: string },
 *   includeUsage?: boolean,
 *   now?: () => number,
 * }} options
 */
export function createSseTranslator({ write, ctx, includeUsage = false, now = Date.now }) {
	const created = Math.floor(now() / 1000);
	let buffered = "";
	let toolIndex = -1;
	let finishReason = null;
	let roleSent = false;
	let ended = false;

	const usage = { prompt: 0, completion: 0, cached: 0 };

	const send = (payload) => write(`data: ${JSON.stringify(payload)}\n\n`);

	const chunk = (delta, finish = null) => ({
		id: ctx.id,
		object: "chat.completion.chunk",
		created,
		model: ctx.displayModel,
		choices: [{ index: 0, delta, finish_reason: finish, logprobs: null }],
	});

	const finish = () => {
		if (ended) return;
		ended = true;
		send(chunk({}, finishReason ?? "stop"));
		if (includeUsage) {
			send({
				id: ctx.id,
				object: "chat.completion.chunk",
				created,
				model: ctx.displayModel,
				choices: [],
				usage: {
					prompt_tokens: usage.prompt,
					completion_tokens: usage.completion,
					total_tokens: usage.prompt + usage.completion,
					prompt_tokens_details: { cached_tokens: usage.cached },
				},
			});
		}
		write("data: [DONE]\n\n");
	};

	const handleEvent = (event) => {
		switch (event.type) {
			case "message_start": {
				const u = event.message?.usage ?? {};
				usage.prompt = u.input_tokens ?? 0;
				usage.cached = u.cache_read_input_tokens ?? 0;
				if (!roleSent) {
					send(chunk({ role: "assistant", content: "" }));
					roleSent = true;
				}
				break;
			}
			case "content_block_start": {
				const block = event.content_block ?? {};
				if (block.type === "tool_use") {
					toolIndex += 1;
					send(
						chunk({
							tool_calls: [
								{
									index: toolIndex,
									id: block.id,
									type: "function",
									function: { name: block.name, arguments: "" },
								},
							],
						}),
					);
				} else if (block.type === "text" && block.text) {
					send(chunk({ content: block.text }));
				}
				break;
			}
			case "content_block_delta": {
				const delta = event.delta ?? {};
				if (delta.type === "text_delta" && delta.text) {
					send(chunk({ content: delta.text }));
				} else if (delta.type === "thinking_delta" && delta.thinking) {
					send(chunk({ reasoning_content: delta.thinking }));
				} else if (delta.type === "input_json_delta" && delta.partial_json) {
					send(
						chunk({
							tool_calls: [
								{
									index: toolIndex < 0 ? 0 : toolIndex,
									function: { arguments: delta.partial_json },
								},
							],
						}),
					);
				}
				break;
			}
			case "message_delta": {
				if (event.delta?.stop_reason) finishReason = mapFinish(event.delta.stop_reason);
				if (event.usage?.output_tokens != null) {
					usage.completion = event.usage.output_tokens;
				}
				break;
			}
			case "message_stop": {
				finish();
				break;
			}
			case "error": {
				const err = event.error ?? {};
				send({
					id: ctx.id,
					object: "chat.completion.chunk",
					created,
					model: ctx.displayModel,
					choices: [],
					error: {
						message: err.message ?? "upstream error",
						type: err.type ?? "upstream_error",
					},
				});
				finish();
				break;
			}
			case "ping":
			default:
				break;
		}
	};

	return {
		/** Feed raw SSE text. */
		push(text) {
			buffered += text;
			let idx;
			while ((idx = buffered.indexOf("\n\n")) >= 0) {
				const block = buffered.slice(0, idx);
				buffered = buffered.slice(idx + 2);
				for (const line of block.split("\n")) {
					if (!line.startsWith("data:")) continue;
					const payload = line.slice(5).trim();
					if (!payload) continue;
					try {
						handleEvent(JSON.parse(payload));
					} catch {
						/* ignore malformed frame */
					}
				}
			}
		},
		/** Terminate the stream exactly once. */
		finish,
		/** True after the terminating frame has been written. */
		get ended() {
			return ended;
		},
		get finishReason() {
			return finishReason;
		},
		get usage() {
			return { ...usage };
		},
	};
}

/**
 * Convert a complete Anthropic message into an OpenAI chat.completion object.
 * @param {any} message
 * @param {{ id: string, displayModel: string }} ctx
 */
export function convertNonStreaming(message, ctx) {
	const blocks = message.content ?? [];

	const text = blocks
		.filter((b) => b.type === "text")
		.map((b) => b.text)
		.join("");

	const reasoning = blocks
		.filter((b) => b.type === "thinking")
		.map((b) => b.thinking)
		.join("");

	const toolCalls = blocks
		.filter((b) => b.type === "tool_use")
		.map((b, index) => ({
			index,
			id: b.id,
			type: "function",
			function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
		}));

	const message2 = {
		role: "assistant",
		content: toolCalls.length && !text ? null : text,
	};
	if (reasoning) message2.reasoning_content = reasoning;
	if (toolCalls.length) message2.tool_calls = toolCalls;

	const input = message.usage?.input_tokens ?? 0;
	const output = message.usage?.output_tokens ?? 0;

	return {
		id: message.id ?? ctx.id,
		object: "chat.completion",
		created: Math.floor(Date.now() / 1000),
		model: ctx.displayModel,
		choices: [
			{
				index: 0,
				message: message2,
				finish_reason: mapFinish(message.stop_reason),
				logprobs: null,
			},
		],
		usage: {
			prompt_tokens: input,
			completion_tokens: output,
			total_tokens: input + output,
			prompt_tokens_details: {
				cached_tokens: message.usage?.cache_read_input_tokens ?? 0,
			},
		},
	};
}

/** Build an OpenAI-shaped error body. */
export function openAIError(status, message, type = "upstream_error") {
	return JSON.stringify({ error: { message, type, code: status } });
}
