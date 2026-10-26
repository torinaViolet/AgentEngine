import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Agent, AgentRunError, AgentSession, TreeSession, ListSession, Message, Role, Generator, ChatProvider, ToolKit, Tool, ToolExecutor, GenerationError, ModelRequest, ModelResponse, restoreSession } from "../../src";
const usage = { inputTokens: 2, outputTokens: 3, totalTokens: 5 };
function fake(responses: Array<Message | Error | ((request: ModelRequest) => Message)>): { provider: ChatProvider; requests: ModelRequest[] } {
  const requests: ModelRequest[] = [];
  return { requests, provider: { async generate(request) { requests.push(request); const response = responses.shift(); if (response instanceof Error) throw response; assert(response, "Unexpected extra model call"); return { message: typeof response === "function" ? response(request) : response, usage }; } } };
}
const call = (name = "lookup", arguments_ = "{}", text = "") => new Message(Role.Assistant, [...(text ? [{ type: "text" as const, text }] : []), { type: "tool_call", toolCallId: "c1", name, arguments: arguments_ }]);
const lookup = () => new Tool({ name: "lookup", description: "look up", parameters: { type: "object", properties: {}, additionalProperties: false }, execute: () => "found" });

describe("3.0 autonomous agent and standalone tools", () => {
  it("returns an executed tool result when concurrent edits prevent its session commit", async () => {
    const source = fake([call()]); const session = TreeSession.create();
    const toolkit = new ToolKit().add(new Tool({ name: "lookup", parameters: { type: "object" }, execute() { session.query.messages({ role: Role.User })[0].setText("edited"); return "actual result"; } }));
    const agent = new Agent({ provider: source.provider, model: "test", session, toolkit });
    await assert.rejects(agent.chat("question"), error => error instanceof AgentRunError && error.result.stopReason === "conflict" && error.result.unappliedToolResults?.[0].text === "actual result");
    assert.equal(session.trace.records.tools[0].status, "completed"); assert.equal(session.query.messages({ role: Role.User })[0].text, "edited");
  });
  it("keeps a continuation's tool loop inside the selected sequence candidate with trace attribution", async () => {
    const source = fake([Message.assistant("A"), call("lookup", "{}", "B"), Message.assistant("C")]);
    const session = ListSession.create(); const agent = new Agent({ provider: source.provider, model: "test", session, toolkit: new ToolKit().add(lookup()) });
    const original = await agent.chat("question"); await agent.continue();
    assert.equal(original.message!.text, "AB"); assert.equal(session.rows.length, 2);
    const sequence = session.rows[1].candidates[0]; assert.equal(sequence.messageIds.length, 4);
    assert.equal(session.query.messages({ runId: agent.lastRunState!.runId }).length, 4);
    assert.equal(restoreSession(JSON.parse(JSON.stringify(session.toJSON()))).query.steps().length, 3);
  });
  it("bounds a noncooperative custom provider and retains emitted partial text on timeout", async () => {
    const provider: ChatProvider = { async generate(_request, _options, emit) { await emit?.({ type: "textDelta", delta: "partial", snapshot: "partial" }); return new Promise(() => {}); } };
    const agent = new Agent({ provider, model: "test", mode: "tree", execution: { timeoutMs: 10 } });
    await assert.rejects(agent.chat("question"), error => error instanceof AgentRunError && error.result.stopReason === "timeout" && error.result.message?.text === "partial");
    assert.equal(agent.isRunning, false); assert.equal(agent.session.isGenerating, false);
  });
  it("preserves a committed model step and closes pending protocol calls when an afterCommit hook fails", async () => {
    const source = fake([call()]); let executions = 0;
    const toolkit = new ToolKit().add(new Tool({ name: "lookup", parameters: { type: "object" }, execute: () => executions++ }));
    const agent = new Agent({ provider: source.provider, model: "test", mode: "tree", toolkit, hooks: { afterCommit() { throw new Error("save failed"); } } });
    await assert.rejects(agent.chat("question"), error => error instanceof AgentRunError && !error.result.unapplied);
    assert.equal(executions, 0); assert.equal(agent.session.trace.records.steps[0].status, "completed");
    assert.equal(agent.session.history().at(-1)!.role, Role.Tool);
  });
  for (const makeSession of [() => TreeSession.create(), () => ListSession.create(), () => AgentSession.create()]) {
    it(`preserves interaction, model and tool records in ${makeSession().type} and restores them`, async () => {
      const session = makeSession(); const { provider, requests } = fake([call(), Message.assistant("final")]); const toolkit = new ToolKit().add(lookup());
      const agent = new Agent({ provider, model: "test", session, toolkit }); const events: any[] = []; agent.on("*", event => { events.push(event); });
      const result = await agent.chat("question"); assert.equal(result.message!.text, "final"); assert.equal(requests.length, 2);
      assert.deepEqual(requests[1].messages.filter(m => !m.isEmpty).map(m => m.role), [Role.User, Role.Assistant, Role.Tool]);
      assert.equal(session.trace.records.turns.length, 1); assert.equal(session.trace.records.steps.length, 2); assert.equal(session.trace.records.tools[0].status, "completed"); assert.equal(session.query.messages({ turnId: result.turnId }).length, 4);
      assert.deepEqual(result.usage, { inputTokens: 4, outputTokens: 6, totalTokens: 10 });
      assert(events.some(event => event.type === "messageCommitted" && event.message.id === result.message!.id));
      const restored = restoreSession(JSON.parse(JSON.stringify(session.toJSON()))); assert.deepEqual(restored.trace.toJSON(), session.trace.toJSON()); assert.equal(restored.query.toolExecutions()[0].name, "lookup");
    });
  }
  it("uses the supplied instances and requires a mode for automatic sessions", async () => {
    const { provider } = fake([Message.assistant("one"), Message.assistant("two")]);
    assert.throws(() => new Agent({ provider, model: "test" } as any), /mode/);
    const agent = new Agent({ provider, model: "test", mode: "agent" }); assert.equal(agent.session.type, "agent"); assert(agent.promptBuilder);
    await agent.chat("one"); await agent.chat("two"); assert.equal(agent.session.trace.records.turns.length, 2);
  });
  it("runs prepared context autonomously while Generator makes only one call", async () => {
    const source = fake([call()]); const generator = new Generator({ provider: source.provider, model: "test" });
    const result = await generator.generate({ messages: [Message.user("question")], tools: [lookup().definition] }); assert.equal(result.message.toolCalls.length, 1); assert.equal(source.requests.length, 1);
    const next = fake([Message.assistant("ready")]); const session = TreeSession.create(); session.addUser("prepared"); const agent = new Agent({ provider: next.provider, model: "test", session });
    await agent.run(); assert.deepEqual(session.history().map(m => m.text), ["", "prepared", "ready"]);
  });
  it("enforces schema validation and manual approval when no Agent is involved", async () => {
    let calls = 0;
    const toolkit = new ToolKit().add(new Tool({ name: "write", requiresApproval: true, parameters: { type: "object", properties: { count: { type: "integer", minimum: 1 }, label: { type: "string", pattern: "^[A-Z]+$" } }, required: ["count", "label"], additionalProperties: false }, execute: args => { calls++; return args; } }));
    const executor = new ToolExecutor({ toolkit }); const invalid = await executor.execute({ type: "tool_call", toolCallId: "bad", name: "write", arguments: '{"count":0,"label":"bad"}' });
    assert.equal(invalid.record.status, "failed"); assert.equal(calls, 0);
    executor.on("approvalRequired", event => { if (event.type === "approvalRequired") executor.approve(event.request.approvalId); });
    const outcome = await executor.execute({ type: "tool_call", toolCallId: "ok", name: "write", arguments: '{"count":1,"label":"OK"}' });
    assert.equal(outcome.record.status, "completed"); assert.equal(calls, 1); assert.equal(executor.pendingApprovals.length, 0);
  });
  it("cleans waiting approvals on timeout and cancellation, with no tool side effects", async () => {
    let calls = 0; const toolkit = new ToolKit().add(new Tool({ name: "lookup", parameters: { type: "object" }, execute: () => calls++ }));
    const executor = new ToolExecutor({ toolkit, approval: "manual", approvalTimeoutMs: 5 });
    const outcome = await executor.execute(call().toolCalls[0]); assert.equal(outcome.record.status, "rejected"); assert.equal(calls, 0);
    const controller = new AbortController(); executor.on("approvalRequired", () => controller.abort(new DOMException("cancel", "AbortError")));
    await assert.rejects(executor.execute(call().toolCalls[0], { signal: controller.signal })); assert.equal(executor.pendingApprovals.length, 0); assert.equal(calls, 0);
  });
  it("reads dynamically enabled tool definitions on each model step", async () => {
    const toolkit = new ToolKit(); toolkit.add(lookup()); toolkit.disable("lookup");
    toolkit.add(new Tool({ name: "enable", parameters: { type: "object" }, execute: () => { toolkit.enable("lookup"); return "enabled"; } }));
    const source = fake([call("enable"), call(), Message.assistant("done")]); const agent = new Agent({ provider: source.provider, model: "test", mode: "tree", toolkit });
    await agent.chat("question"); assert.deepEqual(source.requests[0].tools?.map(t => t.name), ["enable"]); assert(source.requests[1].tools?.some(t => t.name === "lookup"));
  });
  it("merges continuation without persisted instructions and keeps both generations and usages", async () => {
    const source = fake([new Message(Role.Assistant, [{ type: "thinking", text: "plan A" }, { type: "text", text: "A" }]), request => {
      assert.equal(request.messages.at(-1)!.role, Role.User); assert.equal(request.messages.at(-2)!.text, "plan A");
      return new Message(Role.Assistant, [{ type: "thinking", text: "plan B" }, { type: "text", text: "B" }, { type: "image", url: "attachment://image" }]);
    }]);
    const session = TreeSession.create(); const agent = new Agent({ provider: source.provider, model: "test", session }); const first = await agent.chat("question"); const identity = first.message!.id;
    const continued = await agent.continue(); assert.equal(continued.message!.id, identity); assert.equal(continued.message!.text, "AB"); assert.equal(continued.message!.thinking, "plan Aplan B");
    assert.equal(session.history().length, 3); assert.equal(session.trace.records.turns.length, 1); assert.equal(session.trace.records.contributions.filter(c => c.messageId === identity).length, 2); assert.equal(session.trace.usage().totalTokens, 10);
    assert.equal(session.toJSON().messages.some(m => m.parts.some(p => p.type === "text" && p.text.includes("Continue the previous"))), false);
  });
  it("keeps continuation tool calls and results after the merged reply", async () => {
    const source = fake([Message.assistant("A"), call("lookup", "{}", "B"), Message.assistant("C")]);
    const session = TreeSession.create(); const agent = new Agent({ provider: source.provider, model: "test", session, toolkit: new ToolKit().add(lookup()) });
    await agent.chat("question"); await agent.continue(); assert.deepEqual(session.history().map(m => [m.role, m.text]), [[Role.System, ""], [Role.User, "question"], [Role.Assistant, "AB"], [Role.Assistant, ""], [Role.Tool, "found"], [Role.Assistant, "C"]]);
    assert.equal(source.requests[2].messages.filter(m => m.toolCalls.length).length, 1);
  });
  it("rolls back an incomplete failed continuation but retains user-aborted partial output", async () => {
    const session = TreeSession.create(); let phase = 0; let agent: Agent;
    const provider: ChatProvider = { async generate() { phase++; if (phase === 1) return { message: Message.assistant("A") }; if (phase === 2) throw new GenerationError(new Error("network"), { message: Message.assistant("lost") }); agent.abort(); throw new GenerationError(new DOMException("cancel", "AbortError"), { message: Message.assistant("B") }); } };
    agent = new Agent({ provider, model: "test", session }); await agent.chat("question");
    await assert.rejects(agent.continue(), AgentRunError); assert.equal(session.history().at(-1)!.text, "A");
    await assert.rejects(agent.continue(), AgentRunError); assert.equal(session.history().at(-1)!.text, "AB"); assert.equal(session.trace.records.turns.length, 1);
  });
  it("does not overwrite concurrent edits and exposes the uncommitted generated result", async () => {
    const session = TreeSession.create(); const source = fake([Message.assistant("A"), () => { session.history().at(-1)!.setText("user edit"); return Message.assistant("obsolete"); }]);
    const agent = new Agent({ provider: source.provider, model: "test", session }); await agent.chat("question");
    await assert.rejects(agent.continue(), error => error instanceof AgentRunError && error.result.stopReason === "conflict" && error.result.unapplied?.text === "obsolete");
    assert.equal(session.history().at(-1)!.text, "user edit"); assert.equal(session.isGenerating, false);
  });
  it("preserves actual completed tool steps when a later model request fails", async () => {
    const session = TreeSession.create(); const source = fake([call(), new Error("network")]); const agent = new Agent({ provider: source.provider, model: "test", session, toolkit: new ToolKit().add(lookup()) });
    await assert.rejects(agent.chat("question"), AgentRunError); assert.equal(session.history().at(-1)!.role, Role.Tool); assert.equal(session.trace.records.steps[0].status, "completed"); assert.equal(session.trace.records.tools[0].status, "completed");
  });
  it("allows parameter-dependent automatic rejection and repairs protocol for paused execution", async () => {
    const source = fake([call(), Message.assistant("denied")]); const executor = new ToolExecutor({ toolkit: new ToolKit().add(lookup()), approval: () => "deny" });
    const agent = new Agent({ provider: source.provider, model: "test", mode: "tree", toolExecutor: executor }); const result = await agent.chat("question"); assert.equal(result.message!.text, "denied"); assert.equal(agent.session.trace.records.tools[0].status, "rejected");
    const fail = fake([call()]); const toolkit = new ToolKit().add(new Tool({ name: "lookup", parameters: { type: "object" }, execute: () => { throw new Error("failure"); } }));
    const paused = new Agent({ provider: fail.provider, model: "test", mode: "tree", toolkit, execution: { toolErrorPolicy: "pause" } });
    await assert.rejects(paused.chat("question")); assert.equal(paused.session.history().at(-1)!.role, Role.Tool); assert.equal(paused.session.trace.records.steps[0].status, "completed");
  });
  it("rejects overlapping agents on one session before adding a second input", async () => {
    const session = TreeSession.create(); let finish!: (response: ModelResponse) => void; const provider: ChatProvider = { generate: () => new Promise(resolve => { finish = resolve; }) };
    const a = new Agent({ provider, model: "test", session }); const b = new Agent({ provider, model: "test", session }); const running = a.chat("one");
    await new Promise(resolve => setTimeout(resolve, 5)); await assert.rejects(b.chat("two"), /active run/); finish({ message: Message.assistant("done") }); await running;
    assert.equal(session.history().some(m => m.text === "two"), false);
  });
  it("awaits transformations before commit and exposes the transformed content separately", async () => {
    const source = fake([Message.assistant("raw")]); const session = TreeSession.create(); const seen: string[] = [];
    const agent = new Agent({ provider: source.provider, model: "test", session, hooks: { beforeCommit: async message => { await Promise.resolve(); message.setText("saved"); } } });
    agent.on("messageGenerated", event => { if (event.type === "messageGenerated") seen.push(event.result!.message.text); }); const result = await agent.chat("question"); assert.deepEqual(seen, ["raw"]); assert.equal(result.message!.text, "saved"); assert.equal(session.history().at(-1)!.text, "saved");
  });
  it("resumes an interrupted task in the same interaction without replaying completed tools", async () => {
    let tools = 0; const session = TreeSession.create();
    const source = fake([call(), new Error("network"), Message.assistant("resumed")]);
    const toolkit = new ToolKit().add(new Tool({ name: "lookup", parameters: { type: "object" }, execute: () => { tools++; return "done"; } }));
    const agent = new Agent({ provider: source.provider, model: "test", session, toolkit }); await assert.rejects(agent.chat("question"));
    const failedRun = agent.lastRunState!.runId; const result = await agent.resume(); assert.equal(result.message!.text, "resumed"); assert.equal(tools, 1);
    assert.equal(session.trace.records.turns.length, 1); assert.equal(session.trace.records.runs[1].resumedFrom, failedRun);
    assert.equal(session.history().filter(m => m.role === Role.User).length, 1);
    const restored = new Agent({ provider: source.provider, model: "test", session: restoreSession(session.toJSON()) }); await assert.rejects(restored.resume(), /in-process/);
  });
  it("keeps completed parallel tool outcomes even when another operation throws", async () => {
    const toolkit = new ToolKit().add(new Tool({ name: "success", parameters: { type: "object" }, execute: async () => { await new Promise(resolve => setTimeout(resolve, 5)); return "saved"; } }), new Tool({ name: "fail", parameters: { type: "object" }, execute: () => { throw new Error("failure"); } }));
    const message = new Message(Role.Assistant, [{ type: "tool_call", toolCallId: "a", name: "success", arguments: "{}" }, { type: "tool_call", toolCallId: "b", name: "fail", arguments: "{}" }]);
    const source = fake([message]); const agent = new Agent({ provider: source.provider, model: "test", mode: "tree", toolkit, execution: { toolConcurrency: "parallel", toolErrorPolicy: "throw" } });
    await assert.rejects(agent.chat("question")); assert.equal(agent.session.history().filter(m => m.role === Role.Tool).length, 2);
    assert.equal(agent.session.trace.records.tools.find(t => t.name === "success")!.status, "completed"); assert.equal(agent.session.trace.records.tools.find(t => t.name === "fail")!.status, "failed");
  });
  it("limits autonomous steps and cancels waiting approval through the total run timeout", async () => {
    const source = fake([call()]); const agent = new Agent({ provider: source.provider, model: "test", mode: "tree", toolkit: new ToolKit().add(lookup()), execution: { maxSteps: 1 } });
    await assert.rejects(agent.chat("question"), error => error instanceof AgentRunError && error.result.stopReason === "maxSteps"); assert.equal(source.requests.length, 1);
    const waiting = fake([call()]); const timed = new Agent({ provider: waiting.provider, model: "test", mode: "tree", toolkit: new ToolKit().add(lookup()), tools: { approval: "manual" }, execution: { timeoutMs: 10 } });
    await assert.rejects(timed.chat("question"), error => error instanceof AgentRunError && error.result.stopReason === "timeout"); assert.equal(timed.pendingApprovals.length, 0); assert.equal(timed.session.history().at(-1)!.role, Role.Tool);
  });
  it("keeps only the selected alternative's model records in active queries", async () => {
    const session = ListSession.create(); const source = fake([Message.assistant("A"), Message.assistant("B")]); const agent = new Agent({ provider: source.provider, model: "test", session });
    const first = await agent.chat("question"); const row = session.rows[1]; session.regenerate(row.id); const second = await agent.run();
    assert.deepEqual(session.query.runs().map(r => r.id), [second.runId]); assert.equal(session.query.runs({ scope: "all" }).length, 2);
    session.select(row.id, row.selectedCandidateId); assert.deepEqual(session.query.runs().map(r => r.id), [first.runId]);
  });
});
