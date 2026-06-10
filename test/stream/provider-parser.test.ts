import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Role } from "../../src/message";
import {
  AnthropicStreamParser,
  GeminiStreamParser,
  OpenAIResponsesStreamParser,
  StreamEvent,
  StreamEventType,
} from "../../src/stream";

function finalMessage(events: StreamEvent[]) {
  const done = events.find((event) => event.type === StreamEventType.MESSAGE_DONE);
  assert.ok(done && done.type === StreamEventType.MESSAGE_DONE);
  return done.message;
}

describe("OpenAIResponsesStreamParser", () => {
  it("normalizes response text, reasoning, function calls, and usage", () => {
    const parser = new OpenAIResponsesStreamParser();
    const reasoningItem = {
      type: "reasoning",
      id: "rs_1",
      encrypted_content: "encrypted",
      summary: [{ type: "summary_text", text: "consider" }],
    };
    const functionCall = {
      type: "function_call",
      id: "fc_1",
      call_id: "call_1",
      name: "lookup",
      arguments: "{\"query\":\"x\"}",
      status: "completed",
    };

    parser.feed({ type: "response.reasoning_summary_text.delta", delta: "consider" });
    parser.feed({ type: "response.output_text.delta", delta: "hello" });
    parser.feed({
      type: "response.output_item.added",
      output_index: 2,
      item: { ...functionCall, arguments: "" },
    });
    parser.feed({
      type: "response.function_call_arguments.delta",
      output_index: 2,
      item_id: "fc_1",
      delta: "{\"query\":",
    });
    parser.feed({
      type: "response.function_call_arguments.delta",
      output_index: 2,
      item_id: "fc_1",
      delta: "\"x\"}",
    });
    parser.feed({
      type: "response.output_item.done",
      output_index: 1,
      item: reasoningItem,
    });
    parser.feed({
      type: "response.output_item.done",
      output_index: 2,
      item: functionCall,
    });
    parser.feed({
      type: "response.completed",
      response: {
        output: [{ ...reasoningItem }, { ...functionCall }],
        usage: { input_tokens: 4, output_tokens: 6, total_tokens: 10 },
      },
    });

    assert.equal(parser.finishReason, "tool_calls");
    const message = finalMessage(parser.finish());
    assert.equal(message.thinking, "consider");
    assert.equal(message.text, "hello");
    assert.equal(message.toolCalls[0].toolCallId, "call_1");
    assert.equal(message.toolCalls[0].arguments, "{\"query\":\"x\"}");
    assert.equal(message.toolCalls[0].metadata?.itemId, "fc_1");
    assert.deepEqual(message.metadata.openaiReasoningItems, [reasoningItem]);
    assert.deepEqual(message.usage?.toJSON(), {
      promptTokens: 4,
      completionTokens: 6,
      totalTokens: 10,
    });
  });

  it("maps incomplete max output responses to length", () => {
    const parser = new OpenAIResponsesStreamParser();
    parser.feed({ type: "response.output_text.delta", delta: "partial" });
    parser.feed({
      type: "response.incomplete",
      response: { incomplete_details: { reason: "max_output_tokens" } },
    });

    assert.equal(parser.finishReason, "length");
    assert.equal(finalMessage(parser.finish()).text, "partial");
  });
});

describe("AnthropicStreamParser", () => {
  it("normalizes text, thinking, tool calls, usage, and finish reasons", () => {
    const parser = new AnthropicStreamParser();

    parser.feed({
      type: "message_start",
      message: { usage: { input_tokens: 6, output_tokens: 0 } },
    });
    parser.feed({
      type: "content_block_start",
      index: 0,
      content_block: { type: "thinking", thinking: "consider" },
    });
    parser.feed({
      type: "content_block_delta",
      index: 0,
      delta: { type: "signature_delta", signature: "signed" },
    });
    parser.feed({
      type: "content_block_delta",
      index: 1,
      delta: { type: "text_delta", text: "hello" },
    });
    const startEvents = parser.feed({
      type: "content_block_start",
      index: 2,
      content_block: { type: "tool_use", id: "tool_1", name: "lookup", input: {} },
    });
    const deltaEvents = parser.feed({
      type: "content_block_delta",
      index: 2,
      delta: { type: "input_json_delta", partial_json: "{\"query\":\"x\"}" },
    });
    parser.feed({
      type: "message_delta",
      delta: { stop_reason: "tool_use" },
      usage: { output_tokens: 4 },
    });

    assert.equal(startEvents[0].type, StreamEventType.TOOL_CALL_START);
    assert.equal(deltaEvents[0].type, StreamEventType.TOOL_CALL_DELTA);
    assert.equal(parser.finishReason, "tool_calls");

    const message = finalMessage(parser.finish());
    assert.equal(message.role, Role.Assistant);
    assert.equal(message.thinking, "consider");
    assert.equal(message.text, "hello");
    assert.equal(message.toolCalls[0].toolCallId, "tool_1");
    assert.equal(message.toolCalls[0].arguments, "{\"query\":\"x\"}");
    assert.equal(message.metadata.thinkingSignature, "signed");
    assert.deepEqual(message.usage?.toJSON(), {
      promptTokens: 6,
      completionTokens: 4,
      totalTokens: 10,
    });
  });
});

describe("GeminiStreamParser", () => {
  it("normalizes thought parts, text, function calls, usage, and finish reasons", () => {
    const parser = new GeminiStreamParser();
    const events = parser.feed({
      candidates: [{
        content: {
          role: "model",
          parts: [
            { text: "consider", thought: true, thoughtSignature: "thinking-signature" },
            { text: "hello" },
            {
              functionCall: { id: "call_1", name: "lookup", args: { query: "x" } },
              thoughtSignature: "tool-signature",
            },
          ],
        },
        finishReason: "STOP",
      }],
      usageMetadata: {
        promptTokenCount: 3,
        candidatesTokenCount: 5,
        totalTokenCount: 8,
      },
    });

    assert.ok(events.some((event) => event.type === StreamEventType.THINKING_DELTA));
    assert.ok(events.some((event) => event.type === StreamEventType.TEXT_DELTA));
    assert.ok(events.some((event) => event.type === StreamEventType.TOOL_CALL_START));
    assert.equal(parser.finishReason, "stop");

    const message = finalMessage(parser.finish());
    assert.equal(message.thinking, "consider");
    assert.equal(message.text, "hello");
    assert.equal(message.metadata.geminiThinkingSignature, "thinking-signature");
    assert.equal(message.toolCalls[0].name, "lookup");
    assert.equal(message.toolCalls[0].arguments, "{\"query\":\"x\"}");
    assert.equal(message.toolCalls[0].metadata?.thoughtSignature, "tool-signature");
    assert.deepEqual(message.usage?.toJSON(), {
      promptTokens: 3,
      completionTokens: 5,
      totalTokens: 8,
    });
  });

  it("keeps function calls from separate chunks independent", () => {
    const parser = new GeminiStreamParser();
    parser.feed({
      candidates: [{ content: { parts: [{ functionCall: { name: "first", args: {} } }] } }],
    });
    parser.feed({
      candidates: [{ content: { parts: [{ functionCall: { name: "second", args: {} } }] } }],
    });

    const message = finalMessage(parser.finish());
    assert.deepEqual(message.toolCalls.map((call) => call.name), ["first", "second"]);
    assert.notEqual(message.toolCalls[0].toolCallId, message.toolCalls[1].toolCallId);
  });
});
