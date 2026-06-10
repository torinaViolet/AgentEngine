import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MessageAdapter } from "../../src/adapter";
import { Agent } from "../../src/agent";
import { ModelClient } from "../../src/client";
import { Message, Role } from "../../src/message";
import {
  AnthropicProvider,
  GeminiProvider,
  OpenAICompatibleProvider,
  OpenAIResponsesProvider,
  Provider,
} from "../../src/provider";
import {
  MessageStreamParser,
  StreamEvent,
  StreamParser,
} from "../../src/stream";
import { Session } from "../../src/session";
import { Param, Tool, ToolKit } from "../../src/tool";

class RecordingClient implements ModelClient {
  readonly requests: Record<string, unknown>[] = [];

  async stream(request: Record<string, unknown>): Promise<AsyncIterable<unknown>> {
    this.requests.push(request);
    return (async function* () {
      yield { providerText: "provider reply" };
    })();
  }
}

class CustomAdapter implements MessageAdapter {
  async serialize(messages: Message[]) {
    return {
      messages: messages.map((message) => ({
        customRole: message.role,
        customText: message.text,
      })),
      systemMessage: "custom system",
    };
  }

  buildRequest(input: Parameters<NonNullable<MessageAdapter["buildRequest"]>>[0]) {
    return {
      engine: input.model,
      payload: input.serialized.messages,
      system: input.serialized.systemMessage,
      settings: input.options,
    };
  }

  deserialize(raw: unknown): Message {
    return Message.assistant(String(raw));
  }
}

class CustomParser implements MessageStreamParser {
  private readonly parser = new StreamParser();

  feed(chunk: unknown): StreamEvent[] {
    const providerText = (chunk as { providerText?: string }).providerText;
    return this.parser.feed({
      choices: [{ delta: { content: providerText ?? "" }, finish_reason: "stop" }],
    });
  }

  finish(): StreamEvent[] {
    return this.parser.finish();
  }

  get snapshot(): Message {
    return this.parser.snapshot;
  }

  get finishReason() {
    return this.parser.finishReason;
  }

  get hasSnapshotContent(): boolean {
    return this.parser.hasSnapshotContent;
  }

  reset(): void {
    this.parser.reset();
  }
}

describe("Provider", () => {
  it("composes independent client, adapter, and parser components", async () => {
    const client = new RecordingClient();
    const provider = Provider.create({
      client,
      adapter: new CustomAdapter(),
      parserFactory: () => new CustomParser(),
    });
    assert.equal(provider.supportsComplete, false);
    const agent = new Agent({
      provider,
      model: "custom-model",
      session: Session.create("system"),
      requestOptions: { temperature: 0.25 },
    });

    const reply = await agent.run("hello provider");

    assert.equal(reply.role, Role.Assistant);
    assert.equal(reply.text, "provider reply");
    assert.equal(reply.model, "custom-model");
    assert.deepEqual(client.requests[0], {
      engine: "custom-model",
      payload: [
        { customRole: Role.System, customText: "system" },
        { customRole: Role.User, customText: "hello provider" },
      ],
      system: "custom system",
      settings: { temperature: 0.25 },
    });
  });

  it("allows explicit components to override provider presets", async () => {
    const providerClient = new RecordingClient();
    const explicitClient = new RecordingClient();
    const provider = Provider.create({
      client: providerClient,
      adapter: new CustomAdapter(),
      parserFactory: () => new CustomParser(),
    });
    const agent = new Agent({
      provider,
      client: explicitClient,
      adapter: new CustomAdapter(),
      parserFactory: () => new CustomParser(),
      model: "override-model",
      session: Session.create(),
    });

    assert.equal((await agent.run("override")).text, "provider reply");
    assert.equal(explicitClient.requests.length, 1);
    assert.equal(providerClient.requests.length, 0);
  });

  it("runs through the native Anthropic component preset", async () => {
    const requests: Record<string, unknown>[] = [];
    const client = {
      messages: {
        create: async (request: Record<string, unknown>) => {
          requests.push(request);
          return (async function* () {
            yield {
              type: "message_start",
              message: { usage: { input_tokens: 2, output_tokens: 0 } },
            };
            yield {
              type: "content_block_delta",
              index: 0,
              delta: { type: "text_delta", text: "anthropic reply" },
            };
            yield {
              type: "message_delta",
              delta: { stop_reason: "end_turn" },
              usage: { output_tokens: 3 },
            };
          })();
        },
      },
    };
    const agent = new Agent({
      provider: new AnthropicProvider(client),
      model: "claude-test",
      session: Session.create("system prompt"),
      requestOptions: { max_tokens: 128 },
    });

    assert.equal((await agent.run("hello")).text, "anthropic reply");
    assert.equal(requests[0].system, "system prompt");
    assert.equal(requests[0].max_tokens, 128);
  });

  it("runs an OpenAI Responses function-call round trip", async () => {
    const requests: Record<string, unknown>[] = [];
    const reasoningItem = {
      type: "reasoning",
      id: "rs_1",
      encrypted_content: "encrypted",
      summary: [],
    };
    const functionCall = {
      type: "function_call",
      id: "fc_1",
      call_id: "call_1",
      name: "echo",
      arguments: "{\"value\":\"x\"}",
      status: "completed",
    };
    const streams = [
      [
        { type: "response.output_item.done", output_index: 0, item: reasoningItem },
        { type: "response.output_item.added", output_index: 1, item: { ...functionCall, arguments: "" } },
        {
          type: "response.function_call_arguments.done",
          output_index: 1,
          item_id: "fc_1",
          arguments: functionCall.arguments,
        },
        { type: "response.output_item.done", output_index: 1, item: functionCall },
        {
          type: "response.completed",
          response: { output: [reasoningItem, functionCall] },
        },
      ],
      [
        { type: "response.output_text.delta", delta: "done" },
        { type: "response.completed", response: { output: [] } },
      ],
    ];
    const client = {
      responses: {
        create: async (request: Record<string, unknown>) => {
          requests.push(request);
          const events = streams.shift();
          assert.ok(events);
          return (async function* () {
            for (const event of events) yield event;
          })();
        },
      },
    };
    const echo = Tool.create((args) => ({ echoed: args.value }))
      .name("echo")
      .params(Param.string("value").required())
      .build();
    const agent = new Agent({
      provider: new OpenAIResponsesProvider(client),
      model: "gpt-test",
      session: Session.create("system"),
      toolkit: new ToolKit().add(echo),
    });

    assert.equal((await agent.run("use echo")).text, "done");
    assert.equal(requests.length, 2);
    assert.deepEqual((requests[1].input as unknown[]).slice(-3), [
      reasoningItem,
      functionCall,
      {
        type: "function_call_output",
        call_id: "call_1",
        output: "{\"echoed\":\"x\"}",
      },
    ]);
  });

  it("runs through the native Gemini component preset", async () => {
    const requests: Record<string, unknown>[] = [];
    const client = {
      models: {
        generateContentStream: async (request: Record<string, unknown>) => {
          requests.push(request);
          return (async function* () {
            yield {
              candidates: [{
                content: { parts: [{ text: "gemini reply" }] },
                finishReason: "STOP",
              }],
            };
          })();
        },
      },
    };
    const agent = new Agent({
      provider: new GeminiProvider(client),
      model: "gemini-test",
      session: Session.create("system prompt"),
      requestOptions: { temperature: 0.3 },
    });

    assert.equal((await agent.run("hello")).text, "gemini reply");
    assert.equal(requests[0].model, "gemini-test");
    const config = requests[0].config as Record<string, unknown>;
    assert.equal(config.temperature, 0.3);
    assert.equal(config.systemInstruction, "system prompt");
    assert.ok(config.abortSignal instanceof AbortSignal);
  });

  it("runs a non-streaming OpenAI-compatible tool loop", async () => {
    const requests: Record<string, unknown>[] = [];
    const responses = [
      {
        model: "openai-test",
        choices: [{
          finish_reason: "tool_calls",
          message: {
            role: "assistant",
            content: null,
            tool_calls: [{
              id: "call_1",
              type: "function",
              function: { name: "echo", arguments: "{\"value\":\"x\"}" },
            }],
          },
        }],
        usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
      },
      {
        model: "openai-test",
        choices: [{
          finish_reason: "stop",
          message: { role: "assistant", content: "complete reply" },
        }],
        usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
      },
    ];
    const client = {
      chat: {
        completions: {
          create: async (request: Record<string, unknown>) => {
            requests.push(request);
            const response = responses.shift();
            assert.ok(response);
            return response;
          },
        },
      },
    };
    const echo = Tool.create((args) => ({ echoed: args.value }))
      .name("echo")
      .params(Param.string("value").required())
      .build();
    const events: string[] = [];
    const provider = new OpenAICompatibleProvider(client);
    const agent = new Agent({
      provider,
      model: "openai-test",
      session: Session.create("system"),
      toolkit: new ToolKit().add(echo),
    });
    assert.equal(provider.supportsComplete, true);

    agent.on("message_done", (event) => events.push(event.type));
    agent.on("tool_call_done", (event) => events.push(event.type));
    const reply = await agent.run("use echo", { stream: false });

    assert.equal(reply.text, "complete reply");
    assert.equal(reply.model, "openai-test");
    assert.equal(reply.usage?.totalTokens, 6);
    assert.equal(requests.length, 2);
    assert.equal(requests[0].stream, false);
    assert.equal(requests[1].stream, false);
    assert.deepEqual(events, ["tool_call_done", "message_done", "message_done"]);
  });

  it("runs non-streaming native Provider responses", async () => {
    const anthropic = new Agent({
      provider: new AnthropicProvider({
        messages: {
          create: async (request: Record<string, unknown>) => ({
            id: "msg_1",
            model: request.model,
            role: "assistant",
            stop_reason: "end_turn",
            content: [{ type: "text", text: "anthropic complete" }],
            usage: { input_tokens: 2, output_tokens: 3 },
          }),
        },
      }),
      model: "claude-test",
      session: Session.create(),
    });
    assert.equal((await anthropic.run("hello", { stream: false })).text, "anthropic complete");

    const geminiRequests: Record<string, unknown>[] = [];
    const gemini = new Agent({
      provider: new GeminiProvider({
        models: {
          generateContentStream: async () => (async function* () {})(),
          generateContent: async (request: Record<string, unknown>) => {
            geminiRequests.push(request);
            return {
              modelVersion: "gemini-test",
              candidates: [{
                finishReason: "STOP",
                content: { role: "model", parts: [{ text: "gemini complete" }] },
              }],
              usageMetadata: {
                promptTokenCount: 2,
                candidatesTokenCount: 2,
                totalTokenCount: 4,
              },
            };
          },
        },
      }),
      model: "gemini-test",
      session: Session.create(),
    });
    assert.equal((await gemini.run("hello", { stream: false })).text, "gemini complete");
    assert.ok((geminiRequests[0].config as Record<string, unknown>).abortSignal instanceof AbortSignal);

    const responsesRequests: Record<string, unknown>[] = [];
    const responsesAgent = new Agent({
      provider: new OpenAIResponsesProvider({
        responses: {
          create: async (request: Record<string, unknown>) => {
            responsesRequests.push(request);
            return {
              id: "resp_1",
              model: "gpt-test",
              status: "completed",
              output: [{
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: "responses complete" }],
              }],
              usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 },
            };
          },
        },
      }),
      model: "gpt-test",
      session: Session.create(),
    });
    const responsesReply = await responsesAgent.run("hello", { stream: false });
    assert.equal(responsesReply.text, "responses complete");
    assert.equal(responsesReply.usage?.totalTokens, 5);
    assert.equal(responsesRequests[0].stream, false);
  });

  it("reports when a custom ModelClient lacks complete()", async () => {
    const agent = new Agent({
      provider: Provider.create({
        client: new RecordingClient(),
        adapter: new CustomAdapter(),
        parserFactory: () => new CustomParser(),
      }),
      model: "custom-model",
      session: Session.create(),
    });

    await assert.rejects(
      agent.run("hello", { stream: false }),
      /does not support non-streaming requests/
    );
  });

  it("supports non-streaming runRaw without mutating the Session", async () => {
    const requests: Record<string, unknown>[] = [];
    const session = Session.create("session system");
    const originalCursor = session.cursor;
    const agent = new Agent({
      provider: new OpenAICompatibleProvider({
        chat: {
          completions: {
            create: async (request: Record<string, unknown>) => {
              requests.push(request);
              return {
                model: "openai-test",
                choices: [{
                  finish_reason: "stop",
                  message: { role: "assistant", content: "raw complete" },
                }],
              };
            },
          },
        },
      }),
      model: "openai-test",
      session,
    });

    const reply = await agent.runRaw([
      Message.system("raw system"),
      Message.user("raw user"),
    ], { stream: false });

    assert.equal(reply.text, "raw complete");
    assert.equal(session.cursor, originalCursor);
    assert.equal(requests[0].stream, false);
  });
});
