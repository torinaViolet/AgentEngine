import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Message, Role, Usage, type MessagePart } from "../../src/message";

describe("Message", () => {
  it("creates messages with the expected roles and text content", () => {
    assert.equal(Message.system("system prompt").role, Role.System);
    assert.equal(Message.user("hello").role, Role.User);
    assert.equal(Message.assistant("hi").role, Role.Assistant);

    const emptyRoot = Message.emptySystem();
    assert.equal(emptyRoot.role, Role.System);
    assert.deepEqual(emptyRoot.parts, []);
    assert.equal(emptyRoot.text, "");
  });

  it("normalizes string, single part, and part array content", () => {
    const singlePart = Message.user({ type: "text", text: "single" });
    assert.deepEqual(singlePart.parts, [{ type: "text", text: "single" }]);

    const parts: MessagePart[] = [
      { type: "text", text: "look" },
      { type: "image", url: "file:///tmp/image.png", mimeType: "image/png" },
      { type: "thinking", text: "reasoning" },
    ];
    const multiPart = Message.assistant(parts);

    assert.equal(multiPart.text, "look");
    assert.equal(multiPart.thinking, "reasoning");
    assert.equal(multiPart.hasMedia, true);
    assert.equal(multiPart.hasThinking, true);
  });

  it("builds rich messages with chainable part helpers", () => {
    const msg = Message.user("hello")
      .addText(" world")
      .addImage("https://example.com/image.png", "image/png")
      .addAudio("file:///tmp/audio.wav", "audio/wav")
      .addFile("file:///tmp/readme.txt", {
        mimeType: "text/plain",
        fileName: "readme.txt",
      })
      .setMeta("name", "tester");

    assert.equal(msg.text, "hello world");
    assert.equal(msg.hasMedia, true);
    assert.equal(msg.metadata.name, "tester");
    assert.equal(msg.parts.length, 5);
  });

  it("returns tool call and tool result content through convenience APIs", () => {
    const assistant = Message.assistantToolCalls([
      { id: "call_1", name: "get_weather", arguments: "{\"city\":\"Paris\"}" },
    ]);
    const tool = Message.tool("call_1", "{\"temperature\":21}", "get_weather");

    assert.equal(assistant.role, Role.Assistant);
    assert.equal(assistant.toolCalls.length, 1);
    assert.deepEqual(assistant.toolCalls[0], {
      type: "tool_call",
      toolCallId: "call_1",
      name: "get_weather",
      arguments: "{\"city\":\"Paris\"}",
    });

    assert.equal(tool.role, Role.Tool);
    assert.equal(tool.text, "{\"temperature\":21}");
    assert.equal(tool.metadata.toolName, "get_weather");
  });

  it("invalidates cached getters after mutations through helper methods", () => {
    const msg = Message.assistant("first");

    assert.equal(msg.text, "first");
    msg.addText(" second");
    assert.equal(msg.text, "first second");

    assert.equal(msg.hasMedia, false);
    msg.addImage("file:///tmp/image.png");
    assert.equal(msg.hasMedia, true);
  });

  it("supports manual cache invalidation after direct parts mutations", () => {
    const msg = Message.assistant("cached");

    assert.equal(msg.text, "cached");
    msg.parts.push({ type: "text", text: " stale-until-invalidated" });
    assert.equal(msg.text, "cached");

    msg.invalidateCache();
    assert.equal(msg.text, "cached stale-until-invalidated");
  });

  it("manages tags with a chainable API", () => {
    const msg = Message.user("hello").tag("important", "context");

    assert.equal(msg.hasTag("important"), true);
    assert.equal(msg.hasTag("context"), true);

    msg.untag("important");
    assert.equal(msg.hasTag("important"), false);
    assert.deepEqual(Array.from(msg.tags), ["context"]);
  });

  it("maintains parent-child tree relationships and history", () => {
    const root = Message.system("system");
    const user = root.append(Message.user("hello"));
    const assistant = user.append(Message.assistant("hi"));

    assert.equal(user.parent, root);
    assert.equal(assistant.parent, user);
    assert.equal(root.lastChild, user);
    assert.equal(root.depth, 0);
    assert.equal(assistant.depth, 2);
    assert.equal(root.isRoot, true);
    assert.equal(assistant.isLeaf, true);
    assert.deepEqual(assistant.getHistory(), [root, user, assistant]);
    assert.deepEqual(assistant.getHistory(false), [user, assistant]);
  });

  it("prevents cycles and safely reparents existing nodes", () => {
    const firstRoot = Message.system("first");
    const secondRoot = Message.system("second");
    const user = firstRoot.append(Message.user("hello"));
    const assistant = user.append(Message.assistant("hi"));

    assert.throws(() => user.append(user), /自身/);
    assert.throws(() => assistant.append(firstRoot), /祖先/);

    secondRoot.append(user);

    assert.deepEqual(firstRoot.children, []);
    assert.deepEqual(secondRoot.children, [user]);
    assert.equal(user.parent, secondRoot);
    assert.deepEqual(assistant.getHistory(), [secondRoot, user, assistant]);

    secondRoot.append(user);
    assert.deepEqual(secondRoot.children, [user]);
  });

  it("omits an empty system root from included history", () => {
    const root = Message.emptySystem();
    const user = root.append(Message.user("hello"));

    assert.deepEqual(user.getHistory(), [user]);
  });

  it("removes nodes by pruning a subtree", () => {
    const root = Message.system("system");
    const user = root.append(Message.user("hello"));
    const assistant = user.append(Message.assistant("hi"));

    user.remove("prune");

    assert.deepEqual(root.children, []);
    assert.equal(user.parent, undefined);
    assert.equal(assistant.parent, user);
  });

  it("removes nodes by grafting children onto the parent", () => {
    const root = Message.system("system");
    const user = root.append(Message.user("hello"));
    const assistant = user.append(Message.assistant("hi"));

    user.remove("graft");

    assert.deepEqual(root.children, [assistant]);
    assert.equal(assistant.parent, root);
    assert.deepEqual(user.children, []);
    assert.equal(user.parent, undefined);
  });

  it("does not allow removing the root node", () => {
    assert.throws(() => Message.system("system").remove("prune"));
  });

  it("serializes and restores messages with tree, tags, model, usage, and metadata", () => {
    const root = Message.system("system").tag("root");
    root.model = "model-a";
    root.usage = new Usage(1, 2, 3);
    root.setMeta("source", "test");

    const child = root.append(Message.user("hello").tag("leaf"));
    child.setMeta("priority", "high");

    const restored = Message.fromJSON(root.toJSON());
    const restoredChild = restored.children[0];

    assert.equal(restored.role, Role.System);
    assert.equal(restored.text, "system");
    assert.equal(restored.hasTag("root"), true);
    assert.equal(restored.model, "model-a");
    assert.deepEqual(restored.usage?.toJSON(), {
      promptTokens: 1,
      completionTokens: 2,
      totalTokens: 3,
    });
    assert.equal(restored.metadata.source, "test");

    assert.equal(restoredChild.parent, restored);
    assert.equal(restoredChild.text, "hello");
    assert.equal(restoredChild.hasTag("leaf"), true);
    assert.equal(restoredChild.metadata.priority, "high");
  });
});

describe("Usage", () => {
  it("creates zero usage and adds usage values immutably", () => {
    const first = new Usage(1, 2, 3);
    const second = new Usage(4, 5, 9);
    const total = first.add(second);

    assert.deepEqual(total.toJSON(), {
      promptTokens: 5,
      completionTokens: 7,
      totalTokens: 12,
    });
    assert.deepEqual(first.toJSON(), {
      promptTokens: 1,
      completionTokens: 2,
      totalTokens: 3,
    });
    assert.deepEqual(Usage.zero().toJSON(), {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    });
  });

  it("parses raw OpenAI-style usage and JSON usage", () => {
    const raw = Usage.fromRaw({
      prompt_tokens: 10,
      completion_tokens: 20,
      total_tokens: 30,
    });
    const json = Usage.fromJSON({
      promptTokens: 3,
      completionTokens: 4,
      totalTokens: 7,
    });

    assert.deepEqual(raw.toJSON(), {
      promptTokens: 10,
      completionTokens: 20,
      totalTokens: 30,
    });
    assert.deepEqual(json.toJSON(), {
      promptTokens: 3,
      completionTokens: 4,
      totalTokens: 7,
    });
    assert.equal(raw.toString(), "Usage(prompt=10, completion=20, total=30)");
  });

  it("defaults missing raw or JSON usage fields to zero", () => {
    assert.deepEqual(Usage.fromRaw(undefined).toJSON(), {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    });
    assert.deepEqual(Usage.fromJSON({ promptTokens: 5 }).toJSON(), {
      promptTokens: 5,
      completionTokens: 0,
      totalTokens: 0,
    });
  });
});
