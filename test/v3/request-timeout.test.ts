import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { Agent, AgentRunError, Generator, GenerationError, Message, Tool, ToolKit, TreeSession, OpenAICompatibleProvider, type ChatProvider, type ModelEvent } from "../../src";

const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const call = () => Message.assistant([{ type: "tool_call", toolCallId: "call", name: "lookup", arguments: "{}" }]);

describe("per-model-request timeout", () => {
  it("bounds a noncooperative provider, retains partial output and stops late events", async () => {
    let signal: AbortSignal | undefined;
    let emitLater: ((event: ModelEvent) => Promise<void>) | undefined;
    const input = new AbortController();
    const provider: ChatProvider = { async generate(_request, options, emit) {
      signal = options.signal; emitLater = emit;
      await emit?.({ type: "textDelta", delta: "partial", snapshot: "partial" });
      return new Promise(() => {});
    } };
    const generator = new Generator({ provider, model: "test", requestTimeoutMs: 20 });
    const seen: string[] = [];
    await assert.rejects(generator.generate({ messages: [], signal: input.signal, onEvent: event => { seen.push(event.type); } }),
      (error: unknown) => error instanceof GenerationError && error.cause instanceof DOMException && error.cause.name === "TimeoutError" && error.partial?.message.text === "partial");
    assert.equal(signal!.aborted, true);
    assert.equal(input.signal.aborted, false);
    assert.equal(getEventListeners(input.signal, "abort").length, 0);
    const count = seen.length;
    await emitLater?.({ type: "textDelta", delta: "late", snapshot: "partial late" });
    assert.equal(seen.length, count);
  });
  it("cancels an HTTP streaming reader and retains the native parser's partial", async () => {
    let cancelled = false;
    const provider = new OpenAICompatibleProvider({ transport: async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n')); },
      cancel() { cancelled = true; },
    }), { headers: { "content-type": "text/event-stream" } }) });
    const agent = new Agent({ provider, model: "test", mode: "tree", requestTimeoutMs: 30 });
    await assert.rejects(agent.chat("question"), (error: unknown) => error instanceof AgentRunError && error.result.stopReason === "timeout" && error.result.message?.text === "partial");
    assert.equal(cancelled, true);
    assert.equal(agent.lastRunState!.status, "interrupted");
    assert.equal(agent.session.history().at(-1)!.text, "partial");
    assert.equal(agent.session.isGenerating, false);
  });
  it("allows Generator call options to disable an inherited timeout", async () => {
    const provider: ChatProvider = { async generate() { await wait(20); return { message: Message.assistant("done") }; } };
    const generator = new Generator({ provider, model: "test", requestTimeoutMs: 1 });
    assert.equal((await generator.generate({ messages: [], requestTimeoutMs: 0 })).message.text, "done");
  });
  it("keeps external cancellation when a request timer is active and removes its listener", async () => {
    const input = new AbortController();
    let signal: AbortSignal | undefined;
    const provider: ChatProvider = { async generate(_request, options) {
      signal = options.signal;
      input.abort(new DOMException("user stopped", "AbortError"));
      return new Promise(() => {});
    } };
    const generator = new Generator({ provider, model: "test", requestTimeoutMs: 1000 });
    await assert.rejects(generator.generate({ messages: [], signal: input.signal }), { name: "AbortError" });
    assert.equal(signal!.reason, input.signal.reason);
    assert.equal(getEventListeners(input.signal, "abort").length, 0);
  });
  it("cleans the timer and external listener after a successful request", async () => {
    const input = new AbortController();
    let signal: AbortSignal | undefined;
    const provider: ChatProvider = { async generate(_request, options) { signal = options.signal; return { message: Message.assistant("done") }; } };
    await new Generator({ provider, model: "test", requestTimeoutMs: 10 }).generate({ messages: [], signal: input.signal });
    await wait(20);
    assert.equal(signal!.aborted, false);
    assert.equal(getEventListeners(input.signal, "abort").length, 0);
  });
  it("resets the request deadline per step and excludes tool and approval waits", async () => {
    let requests = 0;
    const provider: ChatProvider = { async generate() { await wait(5); return { message: ++requests <= 2 ? call() : Message.assistant("done") }; } };
    const toolkit = new ToolKit().add(Tool.define({ name: "lookup", parameters: { type: "object" }, execute: async () => { await wait(110); return "found"; } }));
    const agent = new Agent({ provider, model: "test", mode: "tree", toolkit, tools: { approval: "manual" }, requestTimeoutMs: 100, execution: { maxSteps: 0, timeoutMs: 0 } });
    const approvals: Array<ReturnType<typeof setTimeout>> = [];
    agent.on("approvalRequired", event => { if (event.type === "approvalRequired") approvals.push(setTimeout(() => agent.approve(event.request.approvalId), 110)); });
    try { assert.equal((await agent.chat("question")).status, "completed"); } finally { approvals.forEach(clearTimeout); }
    assert.equal(requests, 3);
  });
  it("retains the total run deadline even when request timeout is disabled", async () => {
    const provider: ChatProvider = { async generate() { return { message: call() }; } };
    const toolkit = new ToolKit().add(Tool.define({ name: "lookup", parameters: { type: "object" }, execute: () => new Promise(() => {}) }));
    const agent = new Agent({ provider, model: "test", mode: "tree", toolkit, requestTimeoutMs: 0, execution: { maxSteps: 0, timeoutMs: 20 } });
    await assert.rejects(agent.chat("question"), (error: unknown) => error instanceof AgentRunError && error.result.stopReason === "timeout");
    assert.equal(agent.isRunning, false);
  });
  it("allows a run to disable the configured total deadline with zero", async () => {
    const provider: ChatProvider = { async generate() { await wait(20); return { message: Message.assistant("done") }; } };
    const agent = new Agent({ provider, model: "test", mode: "tree", execution: { timeoutMs: 1 } });
    assert.equal((await agent.run({ execution: { timeoutMs: 0 } })).status, "completed");
  });
  it("uses run > Agent > Generator request defaults, including explicit zero", async () => {
    const provider: ChatProvider = { async generate() { await wait(15); return { message: Message.assistant("done") }; } };
    const generator = new Generator({ provider, model: "test", requestTimeoutMs: 1 });
    const agent = new Agent({ generator, mode: "tree", requestTimeoutMs: 50 });
    assert.equal((await agent.chat("question")).status, "completed");
    await assert.rejects(agent.run({ requestTimeoutMs: 1 }), (error: unknown) => error instanceof AgentRunError && error.result.stopReason === "timeout");
    assert.equal((await agent.resume({ requestTimeoutMs: 0 })).status, "completed");
    const inherited = new Agent({ generator, mode: "tree" });
    await assert.rejects(inherited.run(), (error: unknown) => error instanceof AgentRunError && error.result.stopReason === "timeout");
  });
  it("keeps the initial continuation partial on request timeout and can continue again", async () => {
    const session = TreeSession.create(); session.addUser("question"); const original = session.addMessage(Message.assistant("original"));
    let requests = 0;
    const provider: ChatProvider = { async generate(_request, _options, emit) {
      if (++requests > 1) return { message: Message.assistant("done") };
      await emit?.({ type: "textDelta", delta: "partial", snapshot: "partial" });
      return new Promise(() => {});
    } };
    const agent = new Agent({ provider, model: "test", session, requestTimeoutMs: 10 });
    await assert.rejects(agent.continue(), (error: unknown) => error instanceof AgentRunError && error.result.stopReason === "timeout" && error.result.unapplied === undefined);
    assert.equal(original.text, "originalpartial");
    assert.equal((await agent.continue()).message!.text, "originalpartialdone");
  });
  for (const invalid of [-1, NaN, Infinity]) {
    it(`rejects invalid request and total timeout ${invalid}`, async () => {
      const provider: ChatProvider = { async generate() { assert.fail("should not request"); } };
      const generator = new Generator({ provider, model: "test" });
      await assert.rejects(generator.generate({ messages: [], requestTimeoutMs: invalid }), /requestTimeoutMs/);
      const agent = new Agent({ provider, model: "test", mode: "tree", execution: { timeoutMs: invalid } });
      await assert.rejects(agent.run(), /timeoutMs/);
    });
  }
});
