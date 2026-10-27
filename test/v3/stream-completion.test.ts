import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Agent, Generator, Message, Tool, ToolKit, OpenAIProvider, GeminiProvider, AnthropicProvider, OpenAIResponsesProvider, GenerationError, IncompleteStreamError, ProviderStreamError } from "../../src";

const sse = (events: unknown[]) => new Response(events.map(event => `data: ${typeof event === "string" ? event : JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
const protocols = [
    { name: "openai", Provider: OpenAIProvider,
        text: [{ choices: [{ delta: { content: "partial" } }] }],
        calls: [{ choices: [{ delta: { tool_calls: [{ index: 0, id: "call", function: { name: "write", arguments: "{}" } }] } }] }],
        end: [{ choices: [{ delta: {}, finish_reason: "stop" }] }, "[DONE]"] },
    { name: "gemini", Provider: GeminiProvider,
        text: [{ candidates: [{ content: { parts: [{ text: "partial" }] } }] }],
        calls: [{ candidates: [{ content: { parts: [{ functionCall: { id: "call", name: "write", args: {} } }] } }] }],
        end: [{ candidates: [{ finishReason: "STOP" }] }] },
    { name: "anthropic", Provider: AnthropicProvider,
        text: [{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "partial" } }],
        calls: [{ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "call", name: "write", input: {} } }, { type: "content_block_stop", index: 0 }],
        end: [{ type: "message_delta", delta: { stop_reason: "end_turn" } }, { type: "message_stop" }] },
    { name: "responses", Provider: OpenAIResponsesProvider,
        text: [{ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "partial" }],
        calls: [{ type: "response.output_item.added", output_index: 0, item: { id: "item", type: "function_call", call_id: "call", name: "write", arguments: "{}" } }, { type: "response.function_call_arguments.done", item_id: "item", arguments: "{}" }],
        end: [{ type: "response.completed", response: { id: "fixture", status: "completed", output: [] } }] },
];

describe("native HTTP streaming response validation", () => {
    for (const scenario of protocols) {
        it(`accepts a complete ${scenario.name} response`, async () => {
            const provider = new scenario.Provider({ transport: async () => sse([...scenario.text, ...scenario.end]) });
            const result = await new Generator({ provider, model: "test" }).generate({ messages: [Message.user("question")] });
            assert.equal(result.message.text, "partial"); assert(result.finishReason);
        });
        for (const events of [[], scenario.text]) it(`rejects missing completion and retains available ${scenario.name} text (${events.length} events)`, async () => {
            const provider = new scenario.Provider({ transport: async () => sse(events) });
            await assert.rejects(new Generator({ provider, model: "test" }).generate({ messages: [] }), error => error instanceof GenerationError && error.cause instanceof IncompleteStreamError && error.partial?.message.text === (events.length ? "partial" : ""));
        });
        it(`never executes ${scenario.name} tool arguments from an incomplete response`, async () => {
            let requests = 0, effects = 0;
            const provider = new scenario.Provider({ transport: async () => { requests++; return sse(scenario.calls); } });
            const agent = new Agent({ provider, model: "test", mode: "agent", toolkit: new ToolKit().add(Tool.define({ name: "write", parameters: { type: "object" }, execute: () => effects++ })) });
            await assert.rejects(agent.chat("question"));
            assert.equal(effects, 0); assert.equal(requests, 1); assert.equal(agent.lastRunState!.status, "failed");
            const saved = agent.session.history();
            assert(saved.some(message => message.toolCalls.length));
            assert(saved.some(message => message.role === "tool" && message.text.includes("no operation was executed")));
        });
        for (const before of [[], scenario.text, scenario.calls]) it(`propagates in-band ${scenario.name} errors with metadata and partials (${before === scenario.calls ? "tools" : before.length ? "text" : "empty"})`, async () => {
            let effects = 0;
            const provider = new scenario.Provider({ transport: async () => sse([...before, { type: "error", error: { code: "fixture_limit", type: "overloaded", status: 429, message: "fixture quota exhausted" } }, ...scenario.end]) });
            const generator = new Generator({ provider, model: "test" });
            await assert.rejects(generator.generate({ messages: [] }), error => {
                assert(error instanceof GenerationError); assert(error.cause instanceof ProviderStreamError);
                assert.equal(error.cause.message, "fixture quota exhausted"); assert.equal(error.cause.code, "fixture_limit"); assert.equal(error.cause.type, "overloaded"); assert.equal(error.cause.status, 429);
                return true;
            });
            const agent = new Agent({ provider, model: "test", mode: "tree", toolkit: new ToolKit().add(Tool.define({ name: "write", parameters: { type: "object" }, execute: () => effects++ })) });
            await assert.rejects(agent.chat("question"), /fixture quota exhausted/); assert.equal(effects, 0);
        });
        it(`still executes a completed ${scenario.name} tool response and finishes its next step`, async () => {
            let requests = 0, effects = 0;
            const provider = new scenario.Provider({ transport: async () => sse([...(++requests === 1 ? scenario.calls : scenario.text), ...scenario.end]) });
            const agent = new Agent({ provider, model: "test", mode: "tree", toolkit: new ToolKit().add(Tool.define({ name: "write", parameters: { type: "object" }, execute: () => { effects++; return "saved"; } })) });
            const result = await agent.chat("question");
            assert.equal(result.status, "completed"); assert.equal(result.message!.text, "partial"); assert.equal(effects, 1); assert.equal(requests, 2);
        });
    }
    it("does not treat an OpenAI DONE marker alone as a completed model response", async () => {
        const provider = new OpenAIProvider({ transport: async () => sse(["[DONE]"]) });
        await assert.rejects(new Generator({ provider, model: "test" }).generate({ messages: [] }), error => error instanceof GenerationError && error.cause instanceof IncompleteStreamError);
    });
    it("retains partial text when framing fails, and preserves JSON error envelopes in non-streaming responses", async () => {
        const provider = new OpenAIProvider({ transport: async () => new Response('data: {"choices":[{"delta":{"content":"partial"}}]}\n\ndata: {bad json}\n\n') });
        await assert.rejects(new Generator({ provider, model: "test" }).generate({ messages: [] }), error => error instanceof GenerationError && error.partial?.message.text === "partial");
        const complete = new OpenAIProvider({ transport: async () => Response.json({ error: { message: "quota", code: "LIMIT" } }) });
        await assert.rejects(complete.generate({ model: "test", messages: [] }, { stream: false }), error => error instanceof ProviderStreamError && error.code === "LIMIT");
    });
});
