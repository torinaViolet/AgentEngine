import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  Agent, AgentRunError, Generator, Message, Role, PromptBuilder, TreeSession, ListSession, AgentSession,
  SessionConflictError, restoreSession, Tool, ToolKit, OpenAIProvider, GeminiProvider, AnthropicProvider,
  Provider, supportsCapability, GenerationError, TEMPORARY_PROMPT_TAG, CONTINUATION_INSTRUCTION_TAG, CONTINUATION_THINKING_TAG,
  type ChatProvider, type ModelRequest, type ModelResponse, type TreeSessionData, type HttpRequest,
  type EmbeddingProvider, type EmbeddingRequest, type EmbeddingResult,
} from "../../src";

const toolCall = () => new Message(Role.Assistant, [{ type: "tool_call", toolCallId: "ce-call", name: "write_state", arguments: "{}" }]);
const fake = (outputs: Message[]) => {
  const requests: ModelRequest[] = [];
  const provider: ChatProvider = { async generate(request) { requests.push(request); const message = outputs.shift(); assert(message); return { message }; } };
  return { provider, requests };
};
const shape = (messages: readonly Message[]) => messages.map(message => [message.role, message.text, [...message.tags]]);

describe("CE 3.0 integration feedback", () => {
  for (const make of [() => TreeSession.create("system"), () => ListSession.create({ systemPrompt: "system" }), () => AgentSession.create({ systemPrompt: "system" })]) {
    it(`accepts business state writes during model/tool/commit stages in ${make().type}`, async () => {
      const session = make(); const source = fake([toolCall(), Message.assistant("done")]);
      const toolkit = new ToolKit().add(new Tool({ name: "write_state", parameters: { type: "object" }, execute() {
        session.history()[0].setMeta("stateDocument", { notes: ["tool wrote a note"] });
        session.history().at(-1)!.setMeta("transaction", "tx-1").tag("undoable");
        session.setMeta("variables", { count: 1 }); return "state saved";
      } }));
      const prompt = new PromptBuilder().use(messages => { session.setMeta("macro", "committed"); session.history()[0].tag("macro-state"); return messages; });
      const agent = new Agent({ provider: source.provider, model: "chat", session, toolkit, promptBuilder: prompt, hooks: { afterCommit(message) { message.setMeta("uiReady", true); } } });
      agent.on("messageCommitted", event => { if (event.type === "messageCommitted") session.getMessage(event.message.id)!.setMeta("projection", "saved"); });
      const result = await agent.chat("question"); assert.equal(result.status, "completed"); assert.equal(source.requests.length, 2);
      assert.equal(session.query.messages({ metadata: { transaction: "tx-1" } }).length, 1);
      assert.equal(session.metadata.macro, "committed"); assert.deepEqual(session.metadata.variables, { count: 1 });
      const restored = restoreSession(JSON.parse(JSON.stringify(session.toJSON()))); assert.deepEqual(restored.metadata, session.metadata);
      assert.deepEqual(restored.history()[0].metadata.stateDocument, { notes: ["tool wrote a note"] });
      if (session instanceof ListSession) assert.deepEqual(session.staleRowIds, []);
    });
  }
  it("tracks request revisions separately and still rejects content, protocol or declared request metadata edits", () => {
    const session = TreeSession.create(); const user = session.addUser("original"); const requestVersion = user.requestRevision;
    session.beginGeneration(); user.setMeta("transaction", "tx").tag("undoable").deleteMeta("transaction").untag("undoable");
    assert.equal(user.requestRevision, requestVersion); assert.equal(user.revision, 4); session.assertGenerationUnchanged();
    user.setText("edited"); assert.throws(() => session.assertGenerationUnchanged(), SessionConflictError); session.endGeneration();
    session.beginGeneration(); user.setMeta("thinkingSignature", "changed"); assert.throws(() => session.assertGenerationUnchanged(), SessionConflictError); session.endGeneration();
    user.setMeta("customProtocol", "one", { affectsRequest: true });
    const restored = TreeSession.fromJSON(JSON.parse(JSON.stringify(session.toJSON()))); const actual = restored.getMessage(user.id)!;
    restored.beginGeneration(); actual.setMeta("customProtocol", "two"); assert.throws(() => restored.assertGenerationUnchanged(), SessionConflictError); restored.endGeneration();
    const legacy = user.toJSON(); delete legacy.requestRevision; delete legacy.requestMetadataKeys;
    assert.equal(Message.fromJSON(legacy).requestRevision, legacy.revision);
  });
  it("keeps ListSession history valid after metadata edits but stale after content edits", () => {
    const session = ListSession.create(); const input = session.addUser("one"); session.addMessage(Message.assistant("reply")); session.addUser("two");
    input.setMeta("stateRoot", "new").tag("annotation"); session.setMeta("largeState", { notes: [] });
    assert.deepEqual(session.staleRowIds, []); input.appendText(" edited"); assert(session.staleRowIds.length > 0);
  });
  it("exposes continuation temporaries to transforms and produces the same preview/request layout", async () => {
    const session = TreeSession.create(); session.addUser("old user"); const target = session.addMessage(Message.assistant("old reply").appendThinking("old thought"));
    const builder = new PromptBuilder(); builder.injectSystem("one-shot", { life: 1, position: "beforeLastUser", source: "preset" });
    builder.use(messages => {
      const lastUser = messages.map(message => message.role).lastIndexOf(Role.User);
      assert(messages[lastUser].hasTag(CONTINUATION_INSTRUCTION_TAG));
      assert(messages.some(message => message.hasTag(CONTINUATION_THINKING_TAG)));
      const world = Message.user("worldbook depth 1"); const post = Message.system("post-history instruction");
      messages.splice(lastUser, 0, world, post);
      return { messages, sources: [{ messageId: world.id, source: "世界书: entry" }, { messageId: post.id, source: "预设: post" }] };
    });
    const source = fake([Message.assistant("continued")]); let sentSources: unknown;
    const agent = new Agent({ provider: source.provider, model: "chat", session, promptBuilder: builder, hooks: { beforeRequest(context) { sentSources = context.sources.map(item => item.source); } } });
    const snapshot = session.toJSON(); const preview = await agent.previewContext({ kind: "continue", instruction: "Continue exact" });
    assert.deepEqual(session.toJSON(), snapshot); assert.equal(preview.messages.at(-1)!.text, "Continue exact");
    assert.equal(preview.sources.find(item => item.source === "agent.continue.thinking")!.sourceMessageId, target.id);
    assert(preview.sources.filter(item => item.source?.startsWith("agent.continue")).every(item => item.injected));
    await agent.continue({ instruction: "Continue exact" }); assert.deepEqual(shape(source.requests[0].messages), shape(preview.messages));
    assert.deepEqual(sentSources, preview.sources.map(item => item.source));
    assert.equal(session.history().some(message => message.hasTag(TEMPORARY_PROMPT_TAG)), false);
    assert.equal((await agent.previewContext({ kind: "continue" })).messages.some(message => message.text === "one-shot"), false);
  });
  it("adds transformed source labels and keeps them through a later plain-array transform", async () => {
    const input = Message.user("source"); const builder = new PromptBuilder().use(messages => {
      const derived = Message.user("derived");
      return { messages: [derived, ...messages], sources: [{ messageId: derived.id, sourceMessageId: input.id, source: "Skill: reference" }] };
    }).use(messages => messages.filter(message => message.text !== "source"));
    const context = await builder.buildContext([input]); assert.equal(context.sources[0].source, "Skill: reference");
    assert.equal(context.sources[0].sourceMessageId, input.id); assert.equal(context.sources[0].sourceRevision, input.revision); assert(context.sources[0].injected);
    assert.equal(input.text, "source");
    const invalid = new PromptBuilder(); invalid.injectSystem("once", { life: 1 }); invalid.use(messages => ({ messages, sources: [{ messageId: "missing", source: "bad" }] }));
    await assert.rejects(invalid.build([]), /source message reference/);
  });
  it("merges continuation metadata/tags and permits atomic customization without losing concurrent annotations", async () => {
    const session = TreeSession.create(); session.addUser("user");
    const target = session.addMessage(Message.assistant("A").appendThinking("old thought").setMeta("model", "old").setMeta("component", "old component").setMeta("stateRoot", "state-1").tag("old"));
    const parent = session.cursorNodeId!; const other = session.addMessage(Message.assistant("other branch").setMeta("stateRoot", "other-state")); session.select(parent);
    const generated = Message.assistant("B").appendThinking("new thought").setMeta("model", "new").setMeta("stateRoot", "state-2").setMeta("__proto__", { businessKey: true }).tag("new");
    const source = fake([generated]);
    const agent = new Agent({ provider: source.provider, model: "chat", session, hooks: {
      beforeCommit(message, context) { assert.equal(context.targetMessage!.id, target.id); context.targetMessage!.setText("detached edit"); message.setMeta("providerName", "provider"); },
      async beforeAppend(draft, context) {
        assert.equal(context.targetMessage.text, "A"); assert.equal(context.generatedMessage.text, "B"); assert.equal(draft.text, "AB");
        draft.deleteMeta("component").setMeta("render", "rendered").untag("old");
        await Promise.resolve(); target.setMeta("backgroundAnnotation", "keep me").tag("background");
      },
    } });
    const result = await agent.continue(); assert.equal(result.message, target); assert.equal(target.text, "AB");
    assert.equal(target.metadata.model, "new"); assert.equal(target.metadata.stateRoot, "state-2"); assert.equal(target.metadata.providerName, "provider");
    assert(Object.hasOwn(target.metadata, "__proto__")); assert.deepEqual(target.metadata.__proto__, { businessKey: true });
    assert.equal(target.metadata.component, undefined); assert.equal(target.metadata.backgroundAnnotation, "keep me"); assert.equal(target.metadata.render, "rendered");
    assert.deepEqual(new Set(target.tags), new Set(["new", "background"])); assert.equal(other.metadata.stateRoot, "other-state");
    assert.deepEqual(target.parts.filter(part => part.type === "thinking").map(part => part.text), ["old thought", "new thought"]);
  });
  it("does not commit a failed staged continuation hook, and applies it to retained aborted partials", async () => {
    const session = TreeSession.create(); session.addUser("user"); const target = session.addMessage(Message.assistant("A").setMeta("stateRoot", "old"));
    const before = target.toJSON(); const source = fake([Message.assistant("B")]);
    const failed = new Agent({ provider: source.provider, model: "chat", session, hooks: { beforeAppend(draft) { draft.setMeta("stateRoot", "new").setText("changed"); throw new Error("hook failed"); } } });
    await assert.rejects(failed.continue(), AgentRunError); assert.deepEqual(target.toJSON(), before);
    let agent: Agent; const provider: ChatProvider = { async generate() { agent.abort(); throw new GenerationError(new DOMException("cancel", "AbortError"), { message: Message.assistant("partial").setMeta("model", "new") }); } };
    agent = new Agent({ provider, model: "chat", session, hooks: { beforeAppend(draft) { draft.setMeta("savedPartial", true); } } });
    await assert.rejects(agent.continue(), AgentRunError); assert.equal(target.text, "Apartial"); assert.equal(target.metadata.model, "new"); assert.equal(target.metadata.savedPartial, true);
  });
  it("detects real edits during an async append hook and exposes the generated result", async () => {
    const session = TreeSession.create(); session.addUser("user"); const target = session.addMessage(Message.assistant("A")); const source = fake([Message.assistant("B")]);
    const agent = new Agent({ provider: source.provider, model: "chat", session, hooks: { async beforeAppend() { await Promise.resolve(); target.setText("user edit"); } } });
    await assert.rejects(agent.continue(), error => error instanceof AgentRunError && error.result.stopReason === "conflict" && error.result.unapplied?.text === "B"); assert.equal(target.text, "user edit");
  });
  it("stores tool-related continuation thinking once with its protocol signature and step provenance", async () => {
    const session = ListSession.create(); session.addUser("user"); const target = session.addMessage(Message.assistant("A").appendThinking("old thought"));
    const call = toolCall().appendThinking("tool thought").setMeta("thinkingSignature", "signature").setMeta("model", "new").tag("generated");
    const source = fake([call, Message.assistant("final")]);
    const toolkit = new ToolKit().add(new Tool({ name: "write_state", parameters: { type: "object" }, execute: () => "ok" }));
    const agent = new Agent({ provider: source.provider, model: "chat", session, toolkit }); const result = await agent.continue();
    assert.equal(target.thinking, "old thought"); const carrier = session.history().find(message => message.toolCalls.length)!;
    assert.equal(carrier.thinking, "tool thought"); assert.equal(carrier.metadata.thinkingSignature, "signature"); assert(carrier.hasTag("generated"));
    assert.equal(session.history().flatMap(message => message.parts).filter(part => part.type === "thinking" && part.text === "tool thought").length, 1);
    assert(session.query.messages({ runId: result.runId }).includes(carrier)); assert.equal(target.metadata.model, "new");
  });
  it("imports a typed flat tree with stable external IDs, explicit root order and sibling order", () => {
    const system = Message.system("system").toJSON(); const user = new Message(Role.User, "user", {}, { id: "CE 用户/1" });
    const left = new Message(Role.Assistant, "left", {}, { id: "reply:left" }); const right = new Message(Role.Assistant, "right", {}, { id: "reply:right" });
    const other = Message.user("other root");
    const data: TreeSessionData = { format: "agent-engine-session", version: 3, type: "tree", id: "ce-session", metadata: { stateDocument: { notes: ["persisted"] } }, systemMessageId: system.id,
      messages: [system, right.toJSON(), user.toJSON(), left.toJSON(), other.toJSON()], trace: { turns: [], runs: [], steps: [], tools: [], contributions: [] },
      structure: { nodes: [{ id: "right-node", messageId: right.id, parentId: "user-node", children: [] }, { id: "other-root", messageId: other.id, parentId: null, children: [] }, { id: "user-node", messageId: user.id, parentId: null, children: ["left-node", "right-node"] }, { id: "left-node", messageId: left.id, parentId: "user-node", children: [] }], roots: ["user-node", "other-root"], cursor: "right-node" } };
    const session = TreeSession.fromJSON(data); assert.deepEqual(session.history().map(message => message.text), ["system", "user", "right"]);
    assert.deepEqual(session.rootNodeIds, ["user-node", "other-root"]); assert.deepEqual(session.nodeFor(user.id)!.children, ["left-node", "right-node"]);
    assert.equal(session.toJSON().structure.cursor, "right-node"); assert.equal(session.getMessage(user.id)!.id, "CE 用户/1"); assert.equal(session.query.turns().length, 0);
    session.remove("user-node", "graft"); assert.deepEqual(session.rootNodeIds, ["left-node", "right-node", "other-root"]);
    assert.deepEqual(TreeSession.fromJSON(session.toJSON()).rootNodeIds, session.rootNodeIds);
    const invalid = { ...data, structure: { ...data.structure, roots: ["other-root", "other-root"] } }; assert.throws(() => TreeSession.fromJSON(invalid), /root node order/);
  });
  it("retains session metadata while editing system prompts and supports old 3.0 snapshots", () => {
    const session = TreeSession.create("old"); session.setMeta("started", true); session.history()[0].setMeta("legacyState", { variable: 1 });
    session.systemPrompt = "new"; assert.equal(session.metadata.started, true); assert.deepEqual(session.history()[0].metadata.legacyState, { variable: 1 });
    const old = session.toJSON(); delete old.metadata; delete old.structure.roots;
    assert.deepEqual(TreeSession.fromJSON(old).metadata, {});
    const before = session.metadata; assert.throws(() => session.setMeta("bad", new Map()), /JSON/); assert.equal(session.metadata, before);
  });
  it("passes explicit streaming/purpose flags for every chat protocol and supports purpose-specific requests", async () => {
    for (const ProviderType of [OpenAIProvider, GeminiProvider, AnthropicProvider]) {
      const provider = new ProviderType();
      for (const stream of [true, false]) { const wire = await provider.buildRequest({ model: "chat", messages: [Message.user("user")] }, stream); assert.equal(wire.stream, stream); assert.equal(wire.purpose, "chat"); }
    }
    const requests: HttpRequest[] = [];
    class BusinessProvider extends Provider { async probe() { await this.requestJSON("models", { method: "GET", purpose: "models" }); await this.request("image", { body: {}, purpose: "image", stream: true }); } }
    await new BusinessProvider({ baseURL: "https://fake.test", transport: async request => { requests.push(request); return new Response("{}"); } }).probe();
    assert.deepEqual(requests.map(request => [request.purpose, request.stream]), [["models", false], ["image", true]]);
  });
  it("merges thinking policy by generator, Agent and per-run defaults", async () => {
    const source = fake([Message.assistant("one"), Message.assistant("two"), Message.assistant("three")]);
    const generator = new Generator({ provider: source.provider, model: "chat", thinking: { mode: "message", scope: "all", messagePrefix: "prefix" } });
    const agent = new Agent({ generator, mode: "agent", thinking: { scope: "last" } });
    await agent.chat("user"); assert.equal(source.requests[0].thinking!.mode, "message"); assert.equal(source.requests[0].thinking!.scope, "last");
    await agent.chat("again", { thinking: { mode: "none", scope: "none" } }); assert.equal(source.requests[1].thinking!.mode, "none"); assert.equal(source.requests[1].thinking!.scope, "none");
    await agent.chat("default restored"); assert.equal(source.requests[2].thinking!.mode, "message");
    const direct = fake([Message.assistant("direct")]); const single = new Generator({ provider: direct.provider, model: "chat", thinking: { mode: "native", scope: "all" } });
    await single.generate({ messages: [], thinking: { scope: "last" } }); assert.deepEqual(direct.requests[0].thinking, { mode: "native", scope: "last" });
  });
  it("offers a structural embedding capability using the same provider base", async () => {
    class Embeddings extends Provider implements EmbeddingProvider {
      embed(request: EmbeddingRequest, options: { signal?: AbortSignal } = {}): Promise<EmbeddingResult> { return this.requestJSON("embedding", { body: { model: request.model, input: request.input }, signal: options.signal, purpose: "embedding" }); }
    }
    let wire: HttpRequest | undefined; const provider = new Embeddings({ baseURL: "https://fake.test", transport: async request => { wire = request; return new Response(JSON.stringify({ embeddings: [{ index: 0, vector: [1, 2] }] })); } });
    assert(supportsCapability(provider, "embedding")); assert.equal(supportsCapability(provider, "chat"), false);
    assert.deepEqual((await provider.embed({ model: "vector", input: ["text"] })).embeddings[0].vector, [1, 2]); assert.equal(wire!.purpose, "embedding");
  });
});
