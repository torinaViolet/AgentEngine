import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  AnthropicAdapter,
  GeminiAdapter,
  OpenAIAdapter,
  OpenAIResponsesAdapter,
} from "../../src/adapter";
import {
  normalizeThinkingOptions,
  shouldSerializeThinking,
} from "../../src/adapter/MessageAdapter";
import { Message, Role } from "../../src/message";
import type { MediaResolver, ResolvedMedia } from "../../src/media";
import type { ToolSchema } from "../../src/tool";

class FakeResolver implements MediaResolver {
  public readonly calls: string[] = [];

  async resolve(url: string): Promise<ResolvedMedia> {
    this.calls.push(url);
    const fixtures: Record<string, ResolvedMedia> = {
      "local://image": { mimeType: "image/png", base64: "image-base64" },
      "local://audio": { mimeType: "audio/mpeg", base64: "audio-base64" },
      "local://text": {
        mimeType: "text/plain",
        base64: Buffer.from("hello file", "utf8").toString("base64"),
      },
      "local://json": {
        mimeType: "application/json",
        base64: Buffer.from("{\"ok\":true}", "utf8").toString("base64"),
      },
      "local://pdf": { mimeType: "application/pdf", base64: "pdf-base64" },
      "local://bin": { mimeType: "application/octet-stream", base64: "YWJjZA==" },
    };
    const fixture = fixtures[url];
    if (!fixture) throw new Error(`Missing fixture for ${url}`);
    return fixture;
  }
}

function assistantWithThinking(text = "answer"): Message {
  return Message.assistant([
    { type: "thinking", text: "thoughts" },
    { type: "text", text },
  ]);
}

describe("thinking serialization helpers", () => {
  it("normalizes thinking options against adapter capabilities", () => {
    const normalized = normalizeThinkingOptions(undefined, {});

    assert.equal(normalized.mode, "none");
    assert.equal(normalized.scope, "none");
    assert.equal(normalized.include, undefined);
    assert.equal(typeof normalized.messagePrefix, "string");
    assert.ok(normalized.messagePrefix.length > 0);
  });

  it("selects native/message/none modes and thinking scopes", () => {
    const nativeAuto = normalizeThinkingOptions(
      { thinking: { mode: "auto", scope: "all", messagePrefix: "T:" } },
      { nativeThinking: true, messageThinking: true }
    );
    assert.deepEqual(nativeAuto, {
      mode: "native",
      scope: "all",
      include: undefined,
      messagePrefix: "T:",
    });

    const messageFallback = normalizeThinkingOptions(
      { thinking: { mode: "native", scope: "all", messagePrefix: "T:" } },
      { nativeThinking: false, messageThinking: true }
    );
    assert.equal(messageFallback.mode, "message");

    const noneFallback = normalizeThinkingOptions(
      { thinking: { mode: "message", scope: "all", messagePrefix: "T:" } },
      { messageThinking: false }
    );
    assert.equal(noneFallback.mode, "none");
  });

  it("decides whether a message should serialize thinking", () => {
    const messages = [
      Message.user("hello"),
      assistantWithThinking("first"),
      Message.assistantToolCalls([
        { id: "call_1", name: "tool", arguments: "{}" },
      ]).addText(""),
      Message.assistant([
        { type: "thinking", text: "tool thoughts" },
        { type: "tool_call", toolCallId: "call_2", name: "tool", arguments: "{}" },
      ]),
      assistantWithThinking("last"),
    ];
    const allOptions = normalizeThinkingOptions(
      { thinking: { mode: "native", scope: "all" } },
      { nativeThinking: true }
    );
    const lastOptions = normalizeThinkingOptions(
      { thinking: { mode: "native", scope: "last" } },
      { nativeThinking: true }
    );
    const toolOptions = normalizeThinkingOptions(
      { thinking: { mode: "native", scope: "tool_call" } },
      { nativeThinking: true }
    );
    const includeOptions = normalizeThinkingOptions(
      { thinking: { mode: "native", include: (_msg, index) => index === 1 } },
      { nativeThinking: true }
    );

    assert.equal(shouldSerializeThinking(messages[1], 1, messages, allOptions), true);
    assert.equal(shouldSerializeThinking(messages[1], 1, messages, lastOptions), false);
    assert.equal(shouldSerializeThinking(messages[4], 4, messages, lastOptions), true);
    assert.equal(shouldSerializeThinking(messages[3], 3, messages, toolOptions), true);
    assert.equal(shouldSerializeThinking(messages[1], 1, messages, includeOptions), true);
  });
});

describe("Adapter request building", () => {
  const tool: ToolSchema = {
    type: "function",
    function: {
      name: "lookup",
      description: "Look up a value",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    },
  };

  it("builds OpenAI Chat Completions requests", () => {
    const request = new OpenAIAdapter().buildRequest({
      model: "openai-model",
      serialized: { messages: [{ role: "user", content: "hello" }] },
      tools: [tool],
      options: { temperature: 0.2 },
    });

    assert.deepEqual(request, {
      model: "openai-model",
      messages: [{ role: "user", content: "hello" }],
      stream: true,
      temperature: 0.2,
      tools: [tool],
    });
  });

  it("builds Anthropic requests with system and input_schema", () => {
    const request = new AnthropicAdapter().buildRequest({
      model: "claude-model",
      serialized: {
        messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
        systemMessage: "system prompt",
      },
      tools: [tool],
      options: { max_tokens: 512, stop: ["END"] },
    });

    assert.equal(request.system, "system prompt");
    assert.deepEqual(request.stop_sequences, ["END"]);
    assert.equal("stop" in request, false);
    assert.deepEqual(request.tools, [{
      name: "lookup",
      description: "Look up a value",
      input_schema: tool.function.parameters,
    }]);
  });

  it("builds Gemini requests with contents and config", () => {
    const request = new GeminiAdapter().buildRequest({
      model: "gemini-model",
      serialized: {
        messages: [{ role: "user", parts: [{ text: "hello" }] }],
        systemMessage: "system prompt",
      },
      tools: [tool],
      options: {
        temperature: 0.4,
        max_tokens: 256,
        top_p: 0.9,
        response_format: { type: "json_object" },
      },
    });

    assert.deepEqual(request, {
      model: "gemini-model",
      contents: [{ role: "user", parts: [{ text: "hello" }] }],
      config: {
        temperature: 0.4,
        maxOutputTokens: 256,
        topP: 0.9,
        responseMimeType: "application/json",
        systemInstruction: "system prompt",
        tools: [{
          functionDeclarations: [{
            name: "lookup",
            description: "Look up a value",
            parameters: tool.function.parameters,
          }],
        }],
      },
    });
  });
});

describe("OpenAIAdapter", () => {
  it("serializes text, system, assistant thinking, tool calls, and tool results", async () => {
    const adapter = new OpenAIAdapter();
    const assistant = Message.assistant([
      { type: "thinking", text: "think" },
      { type: "text", text: "answer" },
      { type: "tool_call", toolCallId: "call_1", name: "lookup", arguments: "{\"q\":\"x\"}" },
    ]);
    const tool = Message.tool("call_1", "{\"ok\":true}", "lookup");
    const namedUser = Message.user("hello").setMeta("name", "alice");

    const result = await adapter.serialize([
      Message.system("system"),
      namedUser,
      assistant,
      tool,
    ], {
      thinking: { mode: "native", scope: "all" },
    });

    assert.equal(result.systemMessage, "system");
    assert.deepEqual(result.messages, [
      { role: "system", content: "system" },
      { role: "user", content: "hello", name: "alice" },
      {
        role: "assistant",
        reasoning_content: "think",
        content: "answer",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "lookup", arguments: "{\"q\":\"x\"}" },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "{\"ok\":true}" },
    ]);
  });

  it("serializes assistant tool calls with empty string content when no text exists", async () => {
    const adapter = new OpenAIAdapter();
    const assistant = Message.assistantToolCalls([
      { id: "call_1", name: "lookup", arguments: "{}" },
    ]);

    const result = await adapter.serialize([assistant]);

    assert.deepEqual(result.messages, [
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "lookup", arguments: "{}" },
          },
        ],
      },
    ]);
  });

  it("serializes multimodal user content with lazy media resolution", async () => {
    const resolver = new FakeResolver();
    const adapter = new OpenAIAdapter(resolver);
    const user = Message.user("look")
      .addImage("https://example.com/image.png")
      .addImage("local://image", "image/custom")
      .addAudio("local://audio")
      .addFile("local://text", { fileName: "note.txt" })
      .addFile("local://pdf", { fileName: "doc.pdf" })
      .addFile("local://bin", { fileName: "data.bin" });

    const result = await adapter.serialize([user]);

    assert.deepEqual(resolver.calls, [
      "local://image",
      "local://audio",
      "local://text",
      "local://pdf",
      "local://bin",
    ]);
    const [serializedUser] = result.messages as Array<{ role: string; content: unknown[] }>;
    assert.equal(serializedUser.role, "user");
    assert.deepEqual(serializedUser.content.slice(0, 6), [
      { type: "text", text: "look" },
      { type: "image_url", image_url: { url: "https://example.com/image.png" } },
      { type: "image_url", image_url: { url: "data:image/custom;base64,image-base64" } },
      { type: "input_audio", input_audio: { data: "audio-base64", format: "mp3" } },
      { type: "text", text: "[File: note.txt]\nhello file" },
      {
        type: "file",
        file: {
          filename: "doc.pdf",
          file_data: "data:application/pdf;base64,pdf-base64",
        },
      },
    ]);
    assert.deepEqual(
      (serializedUser.content[6] as { type: string }).type,
      "text"
    );
    assert.match(
      (serializedUser.content[6] as { text: string }).text,
      /^\[Attached binary file: data\.bin \(application\/octet-stream, ~6 bytes\).+content not inlined\]$/
    );
  });

  it("deserializes assistant messages and full responses", () => {
    const adapter = new OpenAIAdapter();

    const msg = adapter.deserialize({
      role: "assistant",
      reasoning_content: "think",
      content: "answer",
      tool_calls: [
        { id: "call_1", function: { name: "lookup", arguments: "{\"q\":\"x\"}" } },
      ],
    });

    assert.equal(msg.role, Role.Assistant);
    assert.equal(msg.thinking, "think");
    assert.equal(msg.text, "answer");
    assert.deepEqual(msg.toolCalls, [
      {
        type: "tool_call",
        toolCallId: "call_1",
        name: "lookup",
        arguments: "{\"q\":\"x\"}",
      },
    ]);

    const response = adapter.deserializeResponse({
      model: "gpt-test",
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
      choices: [{ message: { role: "assistant", content: "done" } }],
    });
    assert.equal(response.model, "gpt-test");
    assert.deepEqual(response.usage?.toJSON(), {
      promptTokens: 1,
      completionTokens: 2,
      totalTokens: 3,
    });
  });
});

describe("OpenAIResponsesAdapter", () => {
  it("serializes messages, reasoning items, function calls, and outputs", async () => {
    const adapter = new OpenAIResponsesAdapter();
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
      name: "lookup",
      arguments: "{\"query\":\"x\"}",
      status: "completed",
    };
    const assistant = Message.assistant([
      { type: "thinking", text: "consider" },
      {
        type: "tool_call",
        toolCallId: "call_1",
        name: "lookup",
        arguments: "{\"query\":\"x\"}",
        metadata: { itemId: "fc_1", rawItem: functionCall },
      },
    ]).setMeta("openaiReasoningItems", [reasoningItem]);

    const serialized = await adapter.serialize([
      Message.system("system"),
      Message.user("hello"),
      assistant,
      Message.tool("call_1", "{\"ok\":true}", "lookup"),
    ], {
      thinking: { mode: "native", scope: "tool_call" },
    });

    assert.deepEqual(serialized.messages, [
      { role: "system", content: "system" },
      { role: "user", content: "hello" },
      reasoningItem,
      functionCall,
      {
        type: "function_call_output",
        call_id: "call_1",
        output: "{\"ok\":true}",
      },
    ]);
  });

  it("builds Responses requests and maps generic options", () => {
    const tool: ToolSchema = {
      type: "function",
      function: {
        name: "lookup",
        description: "Look up a value",
        parameters: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
      },
    };
    const request = new OpenAIResponsesAdapter().buildRequest({
      model: "gpt-test",
      serialized: { messages: [{ role: "user", content: "hello" }] },
      tools: [tool],
      options: {
        max_tokens: 256,
        top_k: 10,
        seed: 42,
        stop: ["END"],
        response_format: {
          type: "json_schema",
          json_schema: { name: "result", schema: { type: "object" } },
        },
        store: false,
      },
    });

    assert.deepEqual(request, {
      model: "gpt-test",
      input: [{ role: "user", content: "hello" }],
      stream: true,
      max_output_tokens: 256,
      store: false,
      include: ["reasoning.encrypted_content"],
      text: {
        format: {
          type: "json_schema",
          name: "result",
          schema: { type: "object" },
        },
      },
      tools: [{
        type: "function",
        name: "lookup",
        description: "Look up a value",
        parameters: tool.function.parameters,
      }],
    });
  });

  it("deserializes complete Responses objects", () => {
    const message = new OpenAIResponsesAdapter().deserialize({
      model: "gpt-test",
      output: [
        {
          type: "reasoning",
          id: "rs_1",
          summary: [{ type: "summary_text", text: "consider" }],
        },
        {
          type: "message",
          content: [{ type: "output_text", text: "done" }],
        },
      ],
      usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 },
    });

    assert.equal(message.model, "gpt-test");
    assert.equal(message.thinking, "consider");
    assert.equal(message.text, "done");
    assert.deepEqual(message.usage?.toJSON(), {
      promptTokens: 2,
      completionTokens: 3,
      totalTokens: 5,
    });
  });
});

describe("AnthropicAdapter", () => {
  it("extracts system messages, merges consecutive roles, and serializes tools/thinking", async () => {
    const adapter = new AnthropicAdapter();
    const assistant = Message.assistant([
      { type: "thinking", text: "think" },
      { type: "text", text: "answer" },
      { type: "tool_call", toolCallId: "toolu_1", name: "lookup", arguments: "{\"q\":\"x\"}" },
    ]);
    assistant.setMeta("thinkingSignature", "sig");

    const result = await adapter.serialize([
      Message.system("sys-a"),
      Message.system("sys-b"),
      Message.user("hello"),
      Message.user("again"),
      assistant,
      Message.tool("toolu_1", "{\"ok\":true}", "lookup"),
    ], {
      thinking: { mode: "native", scope: "all" },
    });

    assert.equal(result.systemMessage, "sys-a\n\nsys-b");
    assert.deepEqual(result.messages, [
      {
        role: "user",
        content: [
          { type: "text", text: "hello" },
          { type: "text", text: "again" },
        ],
      },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "think", signature: "sig" },
          { type: "text", text: "answer" },
          { type: "tool_use", id: "toolu_1", name: "lookup", input: { q: "x" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_1", content: "{\"ok\":true}" },
        ],
      },
    ]);
  });

  it("serializes multimodal content and message-mode thinking", async () => {
    const resolver = new FakeResolver();
    const adapter = new AnthropicAdapter(resolver);
    const user = Message.user("look")
      .addImage("https://example.com/image.png")
      .addImage("local://image")
      .addAudio("local://audio")
      .addFile("local://text", { fileName: "note.txt" });
    const assistant = assistantWithThinking("answer");

    const result = await adapter.serialize([user, assistant], {
      thinking: { mode: "message", scope: "all", messagePrefix: "T:" },
    });

    assert.deepEqual(resolver.calls, ["local://image", "local://audio", "local://text"]);
    assert.deepEqual(result.messages, [
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
          { type: "image", source: { type: "url", url: "https://example.com/image.png" } },
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: "image-base64" },
          },
          {
            type: "document",
            source: { type: "base64", media_type: "audio/mpeg", data: "audio-base64" },
          },
          { type: "text", text: "[File: note.txt]\nhello file" },
        ],
      },
      {
        role: "assistant",
        content: [
          { type: "text", text: "T:thoughts" },
          { type: "text", text: "answer" },
        ],
      },
    ]);
  });

  it("deserializes assistant content and full responses", () => {
    const adapter = new AnthropicAdapter();
    const msg = adapter.deserialize({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "think", signature: "sig" },
        { type: "text", text: "answer" },
        { type: "tool_use", id: "toolu_1", name: "lookup", input: { q: "x" } },
      ],
    });

    assert.equal(msg.role, Role.Assistant);
    assert.equal(msg.thinking, "think");
    assert.equal(msg.text, "answer");
    assert.equal(msg.metadata.thinkingSignature, "sig");
    assert.deepEqual(msg.toolCalls, [
      {
        type: "tool_call",
        toolCallId: "toolu_1",
        name: "lookup",
        arguments: "{\"q\":\"x\"}",
      },
    ]);

    const response = adapter.deserializeResponse({
      role: "assistant",
      model: "claude-test",
      usage: { input_tokens: 4, output_tokens: 6 },
      content: [{ type: "text", text: "done" }],
    });
    assert.equal(response.model, "claude-test");
    assert.deepEqual(response.usage?.toJSON(), {
      promptTokens: 4,
      completionTokens: 6,
      totalTokens: 10,
    });
  });
});

describe("GeminiAdapter", () => {
  it("extracts system messages, merges consecutive roles, and serializes model/tool messages", async () => {
    const adapter = new GeminiAdapter();
    const assistant = Message.assistant([
      { type: "thinking", text: "think" },
      { type: "text", text: "answer" },
      {
        type: "tool_call",
        toolCallId: "ignored",
        name: "lookup",
        arguments: "{\"q\":\"x\"}",
        metadata: { thoughtSignature: "tool-signature" },
      },
    ]).setMeta("geminiThinkingSignature", "thinking-signature");

    const result = await adapter.serialize([
      Message.system("sys-a"),
      Message.system("sys-b"),
      Message.user("hello"),
      Message.user("again"),
      assistant,
      Message.tool("call_1", "{\"ok\":true}", "lookup"),
    ], {
      thinking: { mode: "native", scope: "all" },
    });

    assert.equal(result.systemMessage, "sys-a\n\nsys-b");
    assert.deepEqual(result.messages, [
      {
        role: "user",
        parts: [{ text: "hello" }, { text: "again" }],
      },
      {
        role: "model",
        parts: [
          { text: "think", thought: true, thoughtSignature: "thinking-signature" },
          { text: "answer" },
          {
            functionCall: { name: "lookup", args: { q: "x" } },
            thoughtSignature: "tool-signature",
          },
        ],
      },
      {
        role: "user",
        parts: [
          {
            functionResponse: {
              name: "lookup",
              response: { ok: true },
            },
          },
        ],
      },
    ]);
  });

  it("serializes multimodal content and text file content", async () => {
    const resolver = new FakeResolver();
    const adapter = new GeminiAdapter(resolver);
    const user = Message.user("look")
      .addImage("https://example.com/image.png")
      .addImage("local://image")
      .addAudio("local://audio")
      .addFile("local://json", { fileName: "data.json" });

    const result = await adapter.serialize([user]);

    assert.deepEqual(resolver.calls, ["local://image", "local://audio", "local://json"]);
    assert.deepEqual(result.messages, [
      {
        role: "user",
        parts: [
          { text: "look" },
          {
            fileData: {
              mimeType: "image/png",
              fileUri: "https://example.com/image.png",
            },
          },
          {
            inlineData: {
              mimeType: "image/png",
              data: "image-base64",
            },
          },
          {
            inlineData: {
              mimeType: "audio/mpeg",
              data: "audio-base64",
            },
          },
          { text: "[File: data.json]\n{\"ok\":true}" },
        ],
      },
    ]);
  });

  it("deserializes model content and full responses", () => {
    const adapter = new GeminiAdapter();
    const msg = adapter.deserialize({
      content: {
        role: "model",
        parts: [
          { thought: true, text: "think", thoughtSignature: "thinking-signature" },
          { text: "answer" },
          {
            functionCall: { name: "lookup", args: { q: "x" } },
            thoughtSignature: "tool-signature",
          },
        ],
      },
    });

    assert.equal(msg.role, Role.Assistant);
    assert.equal(msg.thinking, "think");
    assert.equal(msg.text, "answer");
    assert.equal(msg.metadata.geminiThinkingSignature, "thinking-signature");
    assert.equal(msg.toolCalls.length, 1);
    assert.match(msg.toolCalls[0].toolCallId, /^lookup-/);
    assert.deepEqual(msg.toolCalls[0], {
      type: "tool_call",
      toolCallId: msg.toolCalls[0].toolCallId,
      name: "lookup",
      arguments: "{\"q\":\"x\"}",
      metadata: { thoughtSignature: "tool-signature" },
    });

    const response = adapter.deserializeResponse({
      modelVersion: "gemini-test",
      candidates: [
        {
          content: {
            role: "model",
            parts: [{ text: "done" }],
          },
        },
      ],
      usageMetadata: {
        promptTokenCount: 2,
        candidatesTokenCount: 5,
        totalTokenCount: 7,
      },
    });
    assert.equal(response.model, "gemini-test");
    assert.deepEqual(response.usage?.toJSON(), {
      promptTokens: 2,
      completionTokens: 5,
      totalTokens: 7,
    });
  });
});
