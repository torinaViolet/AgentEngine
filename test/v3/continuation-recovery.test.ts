import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Agent, AgentRunError, AgentSession, TreeSession, ListSession, Message, Role, ToolKit, Tool, GenerationError, ChatProvider, restoreSession, type CommitContext } from "../../src";

const sessions = [() => TreeSession.create(), () => ListSession.create(), () => AgentSession.create()];
const toolCall = (index: number) => Message.assistant([
  { type: "text", text: `step ${index}` },
  { type: "tool_call", toolCallId: `lookup-${index}`, name: "lookup", arguments: "{}" },
]);

describe("continuation partial recovery", () => {
  for (const makeSession of sessions) {
    for (const failure of ["network", "abort", "conflict"] as const) {
      it(`retains later partials without appending to the original reply in ${makeSession().type}: ${failure}`, async () => {
        const session = makeSession();
        let requests = 0, executions = 0;
        let agent: Agent;
        const commits: CommitContext[] = [];
        const toolkit = new ToolKit().add(Tool.define({ name: "lookup", parameters: { type: "object" }, execute: () => { executions++; return "found"; } }));
        const provider: ChatProvider = { async generate() {
          requests++;
          if (requests === 1) return { message: Message.assistant("original") };
          if (requests === 2 || requests === 3) return { message: toolCall(requests) };
          if (failure === "abort") agent.abort();
          if (failure === "conflict") session.history().find(m => m.role === Role.User)!.setText("edited");
          throw new GenerationError(new Error("connection lost"), { message: Message.assistant([
            { type: "thinking", text: "partial reasoning" },
            { type: "text", text: "partial tail" },
          ]).setMeta("thinkingSignature", "signature") });
        } };
        agent = new Agent({ provider, model: "test", session, toolkit, hooks: { beforeCommit(_message, context) { commits.push(context); } } });
        const original = (await agent.chat("question")).message!;
        const originalPartId = original.parts[0].id;
        await assert.rejects(agent.continue(), AgentRunError);
        const result = agent.lastRunState!;
        assert.equal(requests, 4);
        assert.equal(executions, 2);
        assert.equal(original.id, session.getMessage(original.id)!.id);
        assert.equal(original.parts[0].id, originalPartId);
        assert.equal(original.text, "originalstep 2");
        assert.equal(result.stopReason, failure === "conflict" ? "conflict" : failure === "abort" ? "abort" : "error");
        assert.equal(result.status, failure === "abort" ? "interrupted" : "failed");
        const runSteps = session.trace.records.steps.filter(step => step.runId === result.runId);
        assert.deepEqual(runSteps.map(step => step.status), ["completed", "completed", failure === "abort" ? "interrupted" : "failed"]);
        assert.equal(session.trace.records.tools.filter(tool => tool.runId === result.runId && tool.status === "completed").length, 2);
        if (failure === "conflict") {
          assert.equal(result.unapplied!.text, "partial tail");
          assert.equal(session.history().at(-1)!.role, Role.Tool);
        } else {
          assert.equal(result.unapplied, undefined);
          const tail = session.history().at(-1)!;
          assert.equal(tail.id, result.message!.id);
          assert.notEqual(tail.id, original.id);
          assert.equal(tail.text, "partial tail");
          assert.equal(tail.thinking, "partial reasoning");
          assert.equal(tail.metadata.thinkingSignature, "signature");
          assert.equal(commits.at(-1)!.operation, "create");
          assert.equal(commits.at(-1)!.targetMessageId, undefined);
          assert.equal(commits.at(-1)!.targetMessage, undefined);
          assert.equal(runSteps.at(-1)!.messageId, tail.id);
          assert(session.trace.records.contributions.some(item => item.stepId === runSteps.at(-1)!.id && item.messageId === tail.id && item.operation === "create"));
          if (session instanceof ListSession) assert.equal(session.rows.at(-1)!.candidates[0].messageIds.at(-1), tail.id);
        }
        assert.equal(session.isGenerating, false);
        const saved = JSON.parse(JSON.stringify(session.toJSON()));
        assert.deepEqual(JSON.parse(JSON.stringify(restoreSession(saved).toJSON())), saved);
      });
    }
    for (const aborted of [false, true]) {
      it(`keeps the initial continuation failure policy in ${makeSession().type}: aborted=${aborted}`, async () => {
        const session = makeSession();
        session.addUser("question");
        const original = session.addMessage(Message.assistant("original"));
        let agent: Agent;
        const provider: ChatProvider = { async generate() {
          if (aborted) agent.abort();
          throw new GenerationError(new Error("connection lost"), { message: Message.assistant("partial") });
        } };
        agent = new Agent({ provider, model: "test", session });
        await assert.rejects(agent.continue(), AgentRunError);
        assert.equal(original.text, aborted ? "originalpartial" : "original");
        assert.equal(session.history().at(-1)!.id, original.id);
        assert.equal(agent.lastRunState!.unapplied?.text, aborted ? undefined : "partial");
      });
    }
  }
});

describe("zero step limit", () => {
  for (const override of [false, true]) {
    it(`allows more than the default step count with ${override ? "run" : "constructor"} maxSteps=0`, async () => {
      let requests = 0, executions = 0;
      const toolkit = new ToolKit().add(Tool.define({ name: "lookup", parameters: { type: "object" }, execute: () => { executions++; return "found"; } }));
      const provider: ChatProvider = { async generate() { return { message: ++requests <= 12 ? toolCall(requests) : Message.assistant("done") }; } };
      const agent = new Agent({ provider, model: "test", mode: "tree", toolkit, execution: { maxSteps: override ? 1 : 0 } });
      const result = await agent.chat("question", override ? { execution: { maxSteps: 0 } } : {});
      assert.equal(result.status, "completed");
      assert.equal(requests, 13);
      assert.equal(executions, 12);
    });
  }
  it("still permits cancellation during an unlimited loop", async () => {
    let requests = 0, executions = 0;
    const controller = new AbortController();
    const toolkit = new ToolKit().add(Tool.define({ name: "lookup", parameters: { type: "object" }, execute: () => { executions++; if (executions === 12) controller.abort(); return "found"; } }));
    const provider: ChatProvider = { async generate() { return { message: toolCall(++requests) }; } };
    const agent = new Agent({ provider, model: "test", mode: "tree", toolkit, execution: { maxSteps: 0 } });
    await assert.rejects(agent.chat("question", { signal: controller.signal }), (error: unknown) => error instanceof AgentRunError && error.result.status === "interrupted");
    assert.equal(requests, 12);
    assert.equal(executions, 12);
    assert.equal(agent.isRunning, false);
  });
  for (const limit of [-1, 0.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    it(`rejects invalid step limit ${limit}`, async () => {
      const provider: ChatProvider = { async generate() { assert.fail("should not request"); } };
      const agent = new Agent({ provider, model: "test", mode: "tree", execution: { maxSteps: limit } });
      await assert.rejects(agent.run(), /maxSteps/);
    });
  }
});
