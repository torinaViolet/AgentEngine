import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    Agent, AgentRunError, Generator, Message, TreeSession, Tool, ToolKit,
    OpenAIProvider, OpenAICompatibleProvider, OpenAIResponsesProvider, AnthropicProvider, GeminiProvider,
    GenerationError, IncompleteStreamError, ProviderStreamError, decodeSSE, restoreSession,
} from "../../src";

const encode = (events: unknown[]) => events.map(event => `data: ${typeof event === "string" ? event : JSON.stringify(event)}\n\n`).join("");
const sse = (events: unknown[]) => new Response(encode(events));
const text = (content = "reply") => ({ choices: [{ delta: { content } }] });
const end = (reason: string) => ({ choices: [{ delta: {}, finish_reason: reason }] });
const call = (id = "call", name = "write", args = '{"value":1}', index = 0) => ({ choices: [{ delta: { tool_calls: [{ index, id, function: { name, arguments: args } }] } }] });
const incomplete = (error: unknown) => error instanceof GenerationError && error.cause instanceof IncompleteStreamError;

describe("OpenAI compatible stream termination", () => {
    for (const Provider of [OpenAIProvider, OpenAICompatibleProvider]) for (const mode of [undefined, "compatible"] as const) {
        it(`accepts text followed by DONE in ${Provider.name}, mode=${mode}, without inventing a finish reason`, async () => {
            const options = { streamCompletion: mode, transport: async () => sse([text(), "[DONE]"]) };
            const result = await new Generator({ provider: new Provider(options), model: "test" }).generate({ messages: [] });
            assert.equal(result.message.text, "reply");
            assert.equal(result.finishReason, undefined);
        });
    }
    for (const delta of [{ reasoning_content: "plan" }, { thinking: "plan" }, { role: "assistant", content: "" }]) {
        it(`accepts a valid thinking or empty assistant response: ${JSON.stringify(delta)}`, async () => {
            const provider = new OpenAIProvider({ transport: async () => sse([{ choices: [{ delta }] }, "[DONE]"]) });
            const result = await new Generator({ provider, model: "test" }).generate({ messages: [] });
            assert.equal(result.message.thinking, "reasoning_content" in delta || "thinking" in delta ? "plan" : "");
            assert.equal(result.finishReason, undefined);
        });
    }
    for (const event of [undefined, {}, { choices: [] }, { choices: [{ delta: {} }] }, { usage: { total_tokens: 2 }, choices: [] }]) {
        it(`rejects DONE without a valid assistant response: ${JSON.stringify(event)}`, async () => {
            const provider = new OpenAIProvider({ transport: async () => sse([...(event ? [event] : []), "[DONE]"]) });
            await assert.rejects(new Generator({ provider, model: "test" }).generate({ messages: [] }), incomplete);
        });
    }
    it("preserves usage received before DONE and does not send completion policy to the server", async () => {
        const options = { streamCompletion: "compatible" as const, transport: async () => sse([text(), { choices: [], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } }, "[DONE]"]) };
        const provider = new OpenAIProvider(options);
        const wire = await provider.buildRequest({ model: "test", messages: [] });
        assert.equal(wire.body.streamCompletion, undefined);
        const result = await new Generator({ provider, model: "test" }).generate({ messages: [] });
        assert.deepEqual(result.usage, { inputTokens: 2, outputTokens: 3, totalTokens: 5 });
        assert.equal(result.finishReason, undefined);
    });
    it("keeps strict completion opt-in for text and tool responses", async () => {
        for (const event of [text(), call()]) {
            const options = { streamCompletion: "strict" as const, transport: async () => sse([event, "[DONE]"]) };
            await assert.rejects(new Generator({ provider: new OpenAIProvider(options), model: "test" }).generate({ messages: [] }), incomplete);
        }
    });
    for (const reason of ["stop", "length", "tool_calls", "content_filter"]) for (const done of [false, true]) {
        it(`preserves finish_reason=${reason} with DONE=${done} in strict mode`, async () => {
            const options = { streamCompletion: "strict" as const, transport: async () => sse([text(), end(reason), ...(done ? ["[DONE]"] : [])]) };
            const result = await new Generator({ provider: new OpenAIProvider(options), model: "test" }).generate({ messages: [] });
            assert.equal(result.finishReason, reason);
        });
    }
    it("validates the completion policy when constructing a Provider", () => {
        const options = { streamCompletion: "unknown" as any, baseURL: "https://fixture.invalid/v1" };
        assert.throws(() => new OpenAIProvider(options), /streamCompletion/);
    });
    for (const Provider of [OpenAIResponsesProvider, AnthropicProvider, GeminiProvider]) {
        it(`does not use DONE in place of ${Provider.name}'s native completion`, async () => {
            const options = { streamCompletion: "compatible" as const, transport: async () => sse([text(), "[DONE]"]) };
            await assert.rejects(new Generator({ provider: new Provider(options), model: "test" }).generate({ messages: [] }), incomplete);
        });
    }
    it("commits chat and continuation normally, retaining identity and unknown step reasons across restore", async () => {
        const session = TreeSession.create();
        const provider = new OpenAIProvider({ transport: async () => sse([text(), "[DONE]"]) });
        const agent = new Agent({ provider, model: "test", session });
        const first = await agent.chat("question");
        assert.equal(first.status, "completed");
        assert.equal(first.stopReason, "final");
        const continued = await agent.continue();
        assert.equal(continued.status, "completed");
        assert.equal(continued.message!.id, first.message!.id);
        assert.equal(continued.message!.text, "replyreply");
        assert.equal(session.history().filter(message => message.role === "user").length, 1);
        const restored = restoreSession(JSON.parse(JSON.stringify(session.toJSON())));
        assert.equal(restored.getMessage(first.message!.id)!.text, "replyreply");
        assert.equal(restored.trace.records.steps.length, 2);
        assert(restored.trace.records.steps.every(step => step.status === "completed" && step.finishReason === undefined));
    });
    it("runs a complete fragmented tool call through approval, schema validation and the next model step", async () => {
        let requests = 0, effects = 0, approvals = 0;
        const provider = new OpenAIProvider({ transport: async () => sse(++requests === 1
            ? [call("call", "write", '{"value":'), { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "1}" } }] } }] }, "[DONE]"]
            : [text(), "[DONE]"]) });
        const toolkit = new ToolKit().add(Tool.define({ name: "write", parameters: { type: "object", properties: { value: { type: "integer" } }, required: ["value"], additionalProperties: false }, execute: args => { effects++; assert.equal(args.value, 1); return "saved"; } }));
        const agent = new Agent({ provider, model: "test", mode: "tree", toolkit, tools: { approval: "manual" } });
        agent.on("approvalRequired", event => { if (event.type === "approvalRequired") { approvals++; agent.approve(event.request.approvalId); } });
        assert.equal((await agent.chat("question")).message!.text, "reply");
        assert.equal(requests, 2); assert.equal(effects, 1); assert.equal(approvals, 1);
        assert.equal(agent.session.trace.records.tools[0].status, "completed");
        assert(agent.session.trace.records.steps.every(step => step.finishReason === undefined));
    });
    for (const [label, event] of [
        ["missing ID", call("", "write")], ["missing name", call("call", "")],
        ["empty arguments", call("call", "write", "")], ["truncated JSON", call("call", "write", '{"value":')],
        ["non-object arguments", call("call", "write", "[]")], ["schema mismatch", call("call", "write", '{"value":"wrong"}')],
    ] as const) {
        it(`does not execute a DONE-terminated tool call with ${label}`, async () => {
            let effects = 0, requests = 0, approvals = 0;
            const provider = new OpenAIProvider({ transport: async () => { requests++; return sse([event, "[DONE]"]); } });
            const toolkit = new ToolKit().add(Tool.define({ name: "write", parameters: { type: "object", properties: { value: { type: "integer" } }, required: ["value"] }, execute: () => effects++ }));
            const agent = new Agent({ provider, model: "test", mode: "tree", toolkit, execution: { toolErrorPolicy: "throw" } });
            agent.on("approvalRequired", () => { approvals++; });
            await assert.rejects(agent.chat("question"));
            assert.equal(effects, 0); assert.equal(requests, 1); assert.equal(approvals, 0);
            assert.equal(agent.lastRunState!.status, "failed");
        });
    }
    it("checks the entire tool response before starting any calls when DONE supplies completion", async () => {
        let effects = 0;
        const provider = new OpenAIProvider({ transport: async () => sse([call(), call("second", "write", "{", 1), "[DONE]"]) });
        const toolkit = new ToolKit().add(Tool.define({ name: "write", parameters: { type: "object" }, execute: () => effects++ }));
        await assert.rejects(new Agent({ provider, model: "test", mode: "tree", toolkit }).chat("question"));
        assert.equal(effects, 0);
    });
    for (const policy of ["error", "complete"] as const) {
        it(`retains explicit length behavior with DONE, lengthPolicy=${policy}`, async () => {
            const provider = new OpenAIProvider({ transport: async () => sse([text(), end("length"), "[DONE]"]) });
            const agent = new Agent({ provider, model: "test", mode: "tree", execution: { lengthPolicy: policy } });
            if (policy === "error") await assert.rejects(agent.chat("question"), /output limit/);
            else assert.equal((await agent.chat("question")).stopReason, "length");
            assert.equal(agent.session.trace.records.steps[0].finishReason, "length");
        });
    }
    it("never executes an explicitly length-truncated tool call even with DONE and lengthPolicy=complete", async () => {
        let effects = 0;
        const provider = new OpenAIProvider({ transport: async () => sse([call(), end("length"), "[DONE]"]) });
        const toolkit = new ToolKit().add(Tool.define({ name: "write", parameters: { type: "object" }, execute: () => effects++ }));
        await assert.rejects(new Agent({ provider, model: "test", mode: "tree", toolkit, execution: { lengthPolicy: "complete" } }).chat("question"), /output limit/);
        assert.equal(effects, 0);
    });
    it("retains partial output as failed/error on EOF without any completion signal", async () => {
        const provider = new OpenAIProvider({ transport: async () => sse([text()]) });
        const agent = new Agent({ provider, model: "test", mode: "tree" });
        await assert.rejects(agent.chat("question"), error => error instanceof AgentRunError && error.result.status === "failed" && error.result.stopReason === "error" && error.result.message?.text === "reply");
    });
    it("does not hide an in-band error preceding DONE", async () => {
        const provider = new OpenAIProvider({ transport: async () => sse([text(), { error: { message: "quota", code: "LIMIT" } }, "[DONE]"]) });
        await assert.rejects(new Generator({ provider, model: "test" }).generate({ messages: [] }), error => error instanceof GenerationError && error.cause instanceof ProviderStreamError && error.cause.code === "LIMIT" && error.partial?.message.text === "reply");
    });
    it("does not hide malformed SSE preceding DONE", async () => {
        const provider = new OpenAIProvider({ transport: async () => new Response(encode([text()]) + 'data: {bad JSON}\n\ndata: [DONE]\n\n') });
        await assert.rejects(new Generator({ provider, model: "test" }).generate({ messages: [] }), error => error instanceof GenerationError && error.cause instanceof SyntaxError && error.partial?.message.text === "reply");
    });
    for (const reason of ["AbortError", "TimeoutError"]) {
        it(`honors ${reason} during a delta even when DONE is already buffered`, async () => {
            const input = new AbortController();
            const provider = new OpenAIProvider({ transport: async () => sse([text(), "[DONE]"]) });
            const agent = new Agent({ provider, model: "test", mode: "tree" });
            agent.on("textDelta", () => { input.abort(new DOMException("stopped", reason)); });
            await assert.rejects(agent.chat("question", { signal: input.signal }), error => error instanceof AgentRunError && error.result.status === "interrupted" && error.result.stopReason === (reason === "TimeoutError" ? "timeout" : "abort") && error.result.message?.text === "reply");
        });
    }
    it("honors a model request timeout while a delta handler delays buffered DONE", async () => {
        let signal: AbortSignal | undefined;
        const provider = new OpenAIProvider({ transport: async request => { signal = request.signal; return sse([text(), "[DONE]"]); } });
        const agent = new Agent({ provider, model: "test", mode: "tree", requestTimeoutMs: 20 });
        agent.on("textDelta", async () => { if (!signal!.aborted) await new Promise<void>(resolve => signal!.addEventListener("abort", () => resolve(), { once: true })); });
        await assert.rejects(agent.chat("question"), error => error instanceof AgentRunError && error.result.status === "interrupted" && error.result.stopReason === "timeout" && error.result.message?.text === "reply");
    });
});

describe("SSE explicit DONE notification", () => {
    it("reports a fragmented DONE once without yielding it or parsing trailing data", async () => {
        const bytes = new TextEncoder().encode(encode([text("你好"), "[DONE]", "[DONE]"]) + 'data: {bad JSON}\n\n');
        let cancelled = false, done = 0;
        const response = new Response(new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(new Uint8Array([byte])); }, cancel() { cancelled = true; } }));
        const options = { maxEventBytes: 1024, onDone: () => { done++; } };
        const events: unknown[] = [];
        for await (const event of decodeSSE(response, undefined, options)) events.push(event);
        assert.deepEqual(events, [text("你好")]);
        assert.equal(done, 1); assert.equal(cancelled, true);
    });
    it("ignores data after DONE within the same network chunk", async () => {
        let done = 0;
        const options = { maxEventBytes: 1024, onDone: () => { done++; } };
        const events: unknown[] = [];
        for await (const event of decodeSSE(new Response(encode([text(), "[DONE]"]) + 'data: {bad JSON}\n\n'), undefined, options)) events.push(event);
        assert.deepEqual(events, [text()]); assert.equal(done, 1);
    });
    it("does not report DONE on EOF or a marker appearing inside text content", async () => {
        let done = 0;
        const options = { maxEventBytes: 1024, onDone: () => { done++; } };
        const events: unknown[] = [];
        for await (const event of decodeSSE(sse([text("[DONE]")]), undefined, options)) events.push(event);
        assert.deepEqual(events, [text("[DONE]")]); assert.equal(done, 0);
    });
});
