import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Role } from "../../src/message";
import {
  StreamEventType,
  StreamParser,
  type MessageDoneEvent,
  type StreamEvent,
  type ToolCallDoneEvent,
} from "../../src/stream";

function chunk(delta: Record<string, unknown>, finishReason?: string): Record<string, unknown> {
  return {
    choices: [
      {
        delta,
        finish_reason: finishReason ?? null,
      },
    ],
  };
}

function eventsOf<T extends StreamEventType>(
  events: StreamEvent[],
  type: T
): Extract<StreamEvent, { type: T }>[] {
  return events.filter((event): event is Extract<StreamEvent, { type: T }> => event.type === type);
}

describe("StreamParser", () => {
  it("parses text deltas and builds a final assistant text message", () => {
    const parser = new StreamParser();

    assert.equal(parser.hasSnapshotContent, false);
    assert.deepEqual(parser.feed(chunk({ content: "Hel" })), [
      {
        type: StreamEventType.TEXT_DELTA,
        delta: "Hel",
        snapshot: "Hel",
      },
    ]);
    assert.deepEqual(parser.feed(chunk({ content: "lo" }, "stop")), [
      {
        type: StreamEventType.TEXT_DELTA,
        delta: "lo",
        snapshot: "Hello",
      },
    ]);

    assert.equal(parser.hasSnapshotContent, true);
    assert.equal(parser.snapshot.role, Role.Assistant);
    assert.equal(parser.snapshot.text, "Hello");
    assert.equal(parser.finishReason, "stop");

    const finalEvents = parser.finish();
    assert.deepEqual(eventsOf(finalEvents, StreamEventType.TEXT_DONE), [
      {
        type: StreamEventType.TEXT_DONE,
        text: "Hello",
      },
    ]);

    const [messageDone] = eventsOf(finalEvents, StreamEventType.MESSAGE_DONE);
    assert.equal(messageDone.finishReason, "stop");
    assert.equal(messageDone.message.role, Role.Assistant);
    assert.equal(messageDone.message.text, "Hello");
    assert.equal(messageDone.message.hasThinking, false);
    assert.equal(messageDone.message.toolCalls.length, 0);
  });

  it("parses reasoning_content and thinking deltas into thinking events", () => {
    const parser = new StreamParser();

    assert.deepEqual(parser.feed(chunk({ reasoning_content: "step 1" })), [
      {
        type: StreamEventType.THINKING_DELTA,
        delta: "step 1",
        snapshot: "step 1",
      },
    ]);
    assert.deepEqual(parser.feed(chunk({ thinking: " -> step 2" })), [
      {
        type: StreamEventType.THINKING_DELTA,
        delta: " -> step 2",
        snapshot: "step 1 -> step 2",
      },
    ]);

    const finalEvents = parser.finish();
    assert.deepEqual(eventsOf(finalEvents, StreamEventType.THINKING_DONE), [
      {
        type: StreamEventType.THINKING_DONE,
        thinking: "step 1 -> step 2",
      },
    ]);

    const [messageDone] = eventsOf(finalEvents, StreamEventType.MESSAGE_DONE);
    assert.equal(messageDone.message.thinking, "step 1 -> step 2");
    assert.equal(messageDone.message.hasThinking, true);
    assert.equal(messageDone.message.text, "");
  });

  it("keeps empty string deltas as real deltas", () => {
    const parser = new StreamParser();

    assert.deepEqual(parser.feed(chunk({ content: "" })), [
      {
        type: StreamEventType.TEXT_DELTA,
        delta: "",
        snapshot: "",
      },
    ]);
    assert.deepEqual(parser.feed(chunk({ reasoning_content: "" })), [
      {
        type: StreamEventType.THINKING_DELTA,
        delta: "",
        snapshot: "",
      },
    ]);
    assert.equal(parser.hasSnapshotContent, false);
  });

  it("accumulates tool call chunks and emits start only after id and name are known", () => {
    const parser = new StreamParser();

    assert.deepEqual(
      parser.feed(chunk({
        tool_calls: [
          {
            index: 0,
            id: "call_1",
            function: { arguments: "{\"city\"" },
          },
        ],
      })),
      [
        {
          type: StreamEventType.TOOL_CALL_DELTA,
          index: 0,
          argsDelta: "{\"city\"",
          argsSnapshot: "{\"city\"",
        },
      ]
    );

    assert.deepEqual(
      parser.feed(chunk({
        tool_calls: [
          {
            index: 0,
            function: { name: "get_weather", arguments: ":\"Paris\"}" },
          },
        ],
      }, "tool_calls")),
      [
        {
          type: StreamEventType.TOOL_CALL_START,
          index: 0,
          toolCallId: "call_1",
          name: "get_weather",
        },
        {
          type: StreamEventType.TOOL_CALL_DELTA,
          index: 0,
          argsDelta: ":\"Paris\"}",
          argsSnapshot: "{\"city\":\"Paris\"}",
        },
      ]
    );

    const finalEvents = parser.finish();
    const [toolDone] = eventsOf(finalEvents, StreamEventType.TOOL_CALL_DONE);
    assert.deepEqual(toolDone, {
      type: StreamEventType.TOOL_CALL_DONE,
      index: 0,
      toolCallId: "call_1",
      name: "get_weather",
      arguments: "{\"city\":\"Paris\"}",
    });

    const [messageDone] = eventsOf(finalEvents, StreamEventType.MESSAGE_DONE);
    assert.equal(messageDone.finishReason, "tool_calls");
    assert.deepEqual(messageDone.message.toolCalls, [
      {
        type: "tool_call",
        toolCallId: "call_1",
        name: "get_weather",
        arguments: "{\"city\":\"Paris\"}",
      },
    ]);
  });

  it("accumulates multiple tool calls independently by index", () => {
    const parser = new StreamParser();

    const startEvents = parser.feed(chunk({
      tool_calls: [
        {
          index: 0,
          id: "call_1",
          function: { name: "first", arguments: "{\"a\":" },
        },
        {
          index: 1,
          id: "call_2",
          function: { name: "second", arguments: "{\"b\":" },
        },
      ],
    }));
    const deltaEvents = parser.feed(chunk({
      tool_calls: [
        {
          index: 0,
          function: { arguments: "1}" },
        },
        {
          index: 1,
          function: { arguments: "2}" },
        },
      ],
    }));

    assert.deepEqual(
      eventsOf(startEvents, StreamEventType.TOOL_CALL_START).map((event) => event.name),
      ["first", "second"]
    );
    assert.deepEqual(
      eventsOf(deltaEvents, StreamEventType.TOOL_CALL_DELTA).map((event) => event.argsSnapshot),
      ["{\"a\":1}", "{\"b\":2}"]
    );

    const toolDoneEvents = eventsOf(parser.finish(), StreamEventType.TOOL_CALL_DONE);
    assert.deepEqual(
      toolDoneEvents.map((event: ToolCallDoneEvent) => ({
        index: event.index,
        id: event.toolCallId,
        name: event.name,
        args: event.arguments,
      })),
      [
        { index: 0, id: "call_1", name: "first", args: "{\"a\":1}" },
        { index: 1, id: "call_2", name: "second", args: "{\"b\":2}" },
      ]
    );
  });

  it("captures stream usage before empty choices short-circuit", () => {
    const parser = new StreamParser();

    assert.deepEqual(parser.feed({
      choices: [],
      usage: {
        prompt_tokens: 3,
        completion_tokens: 5,
        total_tokens: 8,
      },
    }), []);

    assert.deepEqual(parser.usage?.toJSON(), {
      promptTokens: 3,
      completionTokens: 5,
      totalTokens: 8,
    });

    const [messageDone] = eventsOf(parser.finish(), StreamEventType.MESSAGE_DONE);
    assert.deepEqual(messageDone.message.usage?.toJSON(), {
      promptTokens: 3,
      completionTokens: 5,
      totalTokens: 8,
    });
  });

  it("returns only MESSAGE_DONE when finishing an empty stream", () => {
    const parser = new StreamParser();

    const finalEvents = parser.finish();

    assert.equal(finalEvents.length, 1);
    assert.equal(finalEvents[0].type, StreamEventType.MESSAGE_DONE);
    assert.equal((finalEvents[0] as MessageDoneEvent).message.text, "");
    assert.equal((finalEvents[0] as MessageDoneEvent).message.parts.length, 0);
  });

  it("is idempotent after finish until reset is called", () => {
    const parser = new StreamParser();
    parser.feed(chunk({ content: "done" }, "stop"));

    assert.equal(parser.finish().length, 2);
    assert.deepEqual(parser.finish(), []);

    parser.reset();
    assert.equal(parser.hasSnapshotContent, false);
    assert.equal(parser.finishReason, undefined);
    assert.equal(parser.usage, undefined);

    parser.feed(chunk({ content: "again" }, "length"));
    const [messageDone] = eventsOf(parser.finish(), StreamEventType.MESSAGE_DONE);
    assert.equal(messageDone.message.text, "again");
    assert.equal(messageDone.finishReason, "length");
  });

  it("ignores chunks without usable choices or deltas", () => {
    const parser = new StreamParser();

    assert.deepEqual(parser.feed({}), []);
    assert.deepEqual(parser.feed({ choices: [] }), []);
    assert.deepEqual(parser.feed({ choices: [{ delta: null }] }), []);

    assert.equal(parser.hasSnapshotContent, false);
  });

  it("emits an error event if malformed tool call data throws during parsing", () => {
    const parser = new StreamParser();
    const events = parser.feed(chunk({
      tool_calls: [
        {
          index: 0,
          get function() {
            throw new Error("bad function");
          },
        },
      ],
    }));

    assert.equal(events.length, 1);
    assert.equal(events[0].type, StreamEventType.ERROR);
    assert.match((events[0] as Extract<StreamEvent, { type: StreamEventType.ERROR }>).error.message, /bad function/);
  });
});
