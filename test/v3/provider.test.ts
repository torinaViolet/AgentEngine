import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Agent, Generator, Message, OpenAIProvider, OpenAIResponsesProvider, AnthropicProvider, GeminiProvider, decodeSSE, ProviderRequestError, GenerationError, HttpRequest, isJsonBody } from "../../src";
function body(request: HttpRequest | undefined) { assert(request && isJsonBody(request.body)); return request.body; }
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const openai = (text: string) => ({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: text } }], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } });

describe("3.0 SDK-free provider and single generator", () => {
  it("retains distinct native thinking signatures after merged continuation", async () => {
    for (const protocol of ["anthropic", "gemini"] as const) {
      let requestCount = 0;
      const transport = async () => {
        const index = requestCount++; const text = index === 0 ? "A" : "B"; const signature = `signature-${index}`;
        return json(protocol === "anthropic"
          ? { role: "assistant", content: [{ type: "thinking", thinking: `think-${index}`, signature }, { type: "text", text }], stop_reason: "end_turn" }
          : { candidates: [{ content: { role: "model", parts: [{ thought: true, text: `think-${index}`, thoughtSignature: signature }, { text }] }, finishReason: "STOP" }] });
      };
      const provider = protocol === "anthropic" ? new AnthropicProvider({ transport }) : new GeminiProvider({ transport });
      const agent = new Agent({ provider, model: "test", mode: "tree" }); const original = await agent.chat("question", { stream: false }); await agent.continue({ stream: false });
      assert.equal(original.message!.text, "AB");
      const wire = await provider.buildRequest({ model: "test", messages: agent.session.history(), thinking: { mode: "native", scope: "all" } }, false);
      const body = JSON.stringify(wire.body); assert(body.includes("signature-0")); assert(body.includes("signature-1"));
    }
  });
  it("rejects unsupported common parameters and conflicting native aliases", async () => {
    const messages = [Message.user("hello")];
    await assert.rejects(new OpenAIResponsesProvider().buildRequest({ model: "test", messages, generation: { stop: ["END"] } }), /not supported/);
    await assert.rejects(new AnthropicProvider().buildRequest({ model: "test", messages, generation: { seed: 1 } }), /not supported/);
    await assert.rejects(new GeminiProvider().buildRequest({ model: "test", messages, generation: { topP: 0.2, providerOptions: { topP: 0.3 } } }), /Conflicting/);
    await assert.rejects(new OpenAIResponsesProvider().buildRequest({ model: "test", messages, generation: { maxOutputTokens: 10, providerOptions: { max_output_tokens: 20 } } }), /Conflicting/);
    const wire = await new GeminiProvider().buildRequest({ model: "test", messages, generation: { responseFormat: { type: "text" } } }, false);
    assert.equal((wire.body.generationConfig as any).response_format, undefined); assert.equal((wire.body.generationConfig as any).responseMimeType, "text/plain");
  });
  it("parses native Anthropic, Gemini and Responses SSE through the HTTP transport", async () => {
    const scenarios = [
      { provider: AnthropicProvider, chunks: [
        { type: "message_start", message: { id: "a", role: "assistant", model: "test", content: [], usage: { input_tokens: 2, output_tokens: 0 } } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hello" } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } }, { type: "message_stop" }
      ] },
      { provider: GeminiProvider, chunks: [{ candidates: [{ content: { role: "model", parts: [{ text: "hello" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 3, totalTokenCount: 5 } }] },
      { provider: OpenAIResponsesProvider, chunks: [
        { type: "response.created", response: { id: "r", model: "test", output: [] } },
        { type: "response.output_text.delta", delta: "hello", output_index: 0, content_index: 0 },
        { type: "response.completed", response: { id: "r", status: "completed", model: "test", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "hello" }] }], usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 } } }
      ] }
    ];
    for (const scenario of scenarios) {
      const provider = new scenario.provider({ transport: async () => new Response(scenario.chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("")) });
      const events: any[] = []; const result = await new Generator({ provider, model: "test" }).generate({ messages: [Message.user("hi")], onEvent: event => { events.push(event); } });
      assert.equal(result.message.text, "hello"); assert.equal(result.usage?.totalTokens, 5); assert(events.some(event => event.type === "textDelta"));
    }
  });
  it("builds and sends OpenAI requests via injected transport with separate generation config", async () => {
    let wire: HttpRequest | undefined;
    const provider = new OpenAIProvider({ apiKey: async () => "test-key", baseURL: "https://fake.local/v1/", transport: async request => { wire = request; return json(openai("reply")); } });
    const generator = new Generator({ provider, model: "test", generation: { temperature: 0.3 } });
    const result = await generator.generate({ messages: [Message.user("hi")], stream: false, generation: { maxOutputTokens: 12 } });
    assert.equal(wire!.url, "https://fake.local/v1/chat/completions"); assert.equal(wire!.headers.authorization, "Bearer test-key"); assert.equal(body(wire).max_tokens, 12);
    assert.equal(result.message.text, "reply"); assert.deepEqual(result.usage, { inputTokens: 2, outputTokens: 3, totalTokens: 5 });
    assert.equal(body(wire).temperature, 0.3); assert.equal(body(wire).signal, undefined);
  });
  it("converts native Anthropic and Gemini HTTP requests and complete results", async () => {
    let anthropic: HttpRequest | undefined; let gemini: HttpRequest | undefined;
    const a = new Generator({ model: "claude-test", provider: new AnthropicProvider({ apiKey: "key", transport: async request => { anthropic = request; return json({ content: [{ type: "text", text: "A" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 2 } }); } }) });
    const g = new Generator({ model: "gemini-test", provider: new GeminiProvider({ apiKey: "key", transport: async request => { gemini = request; return json({ candidates: [{ content: { role: "model", parts: [{ text: "G" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2, totalTokenCount: 3 } }); } }) });
    const messages = [Message.system("system"), Message.user("hi")]; assert.equal((await a.generate({ messages, stream: false })).message.text, "A"); assert.equal((await g.generate({ messages, stream: false })).message.text, "G");
    assert.equal(body(anthropic).system, "system"); assert.equal(body(anthropic).max_tokens, 4096); assert.equal(anthropic!.headers["x-api-key"], "key");
    assert.equal(gemini!.url.endsWith("models/gemini-test:generateContent"), true); assert.equal(body(gemini).config, undefined); assert.deepEqual(body(gemini).systemInstruction, { parts: [{ text: "system" }] });
  });
  it("preserves Responses reasoning and tool items across a tool round trip", async () => {
    const provider = new OpenAIResponsesProvider({ transport: async () => json({ output: [{ id: "r", type: "reasoning", encrypted_content: "opaque", summary: [{ type: "summary_text", text: "plan" }] }, { id: "f", type: "function_call", call_id: "call", name: "lookup", arguments: "{}" }], usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 } }) });
    const result = await new Generator({ provider, model: "test" }).generate({ messages: [Message.user("hi")], stream: false });
    const wire = await provider.buildRequest({ model: "test", messages: [result.message, Message.tool("call", "done", "lookup")], thinking: { mode: "auto", scope: "all" } }, false);
    const input = wire.body.input as any[]; assert(input.some(item => item.encrypted_content === "opaque")); assert(input.some(item => item.type === "function_call_output" && item.call_id === "call"));
  });
  it("handles UTF-8 fragmented SSE, comments, CRLF, multiple data lines and plain JSON", async () => {
    const bytes = new TextEncoder().encode(': ping\r\ndata: {"text":\r\ndata: "你好"}\r\n\r\ndata: [DONE]\r\n\r\n');
    const response = new Response(new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(new Uint8Array([byte])); controller.close(); } }));
    const output: unknown[] = []; for await (const event of decodeSSE(response)) output.push(event); assert.deepEqual(output, [{ text: "你好" }]);
    const fallback: unknown[] = []; for await (const event of decodeSSE(json({ ok: true }))) fallback.push(event); assert.deepEqual(fallback, [{ ok: true }]);
  });
  it("streams with identities matching the final message and still only makes one call", async () => {
    let requests = 0; const provider = new OpenAIProvider({ transport: async () => { requests++; return new Response('data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'); } });
    const events: any[] = []; const result = await new Generator({ provider, model: "test" }).generate({ messages: [Message.user("hi")], onEvent: event => { events.push(event); } });
    assert.equal(requests, 1); assert.equal(result.message.text, "hi"); assert(events.every(event => event.messageId === result.message.id)); assert(events.some(event => event.type === "textDelta"));
  });
  it("exposes structured HTTP errors and rejects conflicting configuration", async () => {
    const provider = new OpenAIProvider({ transport: async () => json({ error: { message: "rate limited" } }, 429) });
    await assert.rejects(provider.generate({ model: "test", messages: [] }, { stream: false }), error => error instanceof ProviderRequestError && error.status === 429);
    await assert.rejects(provider.buildRequest({ model: "test", messages: [], generation: { maxOutputTokens: 20, providerOptions: { max_tokens: 10 } } }), /Conflicting/);
    await assert.rejects(provider.buildRequest({ model: "test", messages: [], generation: { providerOptions: { model: "other" } } }), /managed/);
  });
  it("cancels a blocked stream, releases it and exposes the partial output", async () => {
    const controller = new AbortController(); let cancelled = false;
    const provider = new OpenAIProvider({ transport: async () => new Response(new ReadableStream({ start(stream) { stream.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n')); }, cancel() { cancelled = true; } })) });
    await assert.rejects(new Generator({ provider, model: "test" }).generate({ messages: [Message.user("hi")], signal: controller.signal, onEvent: event => { if (event.type === "textDelta") controller.abort(new DOMException("cancel", "AbortError")); } }), error => error instanceof GenerationError && error.partial?.message.text === "partial");
    assert.equal(cancelled, true);
  });
});
