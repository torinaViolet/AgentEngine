import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Agent, AgentRunError, AgentSession, TreeSession, ListSession, Message, Tool, ToolKit, GenerationError, restoreSession, type ChatProvider, type CommitContext } from "../../src";

const sessions = [() => TreeSession.create(), () => ListSession.create(), () => AgentSession.create()];
const call = (id = "reused", name = "write") => Message.assistant([{ type: "tool_call", toolCallId: id, name, arguments: "{}" }]);
const toolkit = (execute: () => unknown) => new ToolKit().add(Tool.define({ name: "write", parameters: { type: "object" }, execute }));
const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

describe("CE audit: explicit output-length policy", () => {
    for (const makeSession of sessions) for (const continuing of [false, true]) {
        it(`completes an opted-in truncated final reply in ${makeSession().type}, continue=${continuing}`, async () => {
            const session = makeSession();
            if (continuing) { session.addUser("question"); session.addMessage(Message.assistant("old")); }
            const callbacks: string[] = [];
            const agent = new Agent({ session, model: "test", execution: { lengthPolicy: "complete" }, provider: { async generate() { return { message: Message.assistant("cut"), finishReason: "length" }; } }, hooks: {
                afterCommit() { callbacks.push("commit"); }, afterRun(result) { callbacks.push(result.status); }
            } });
            const result = continuing ? await agent.continue() : await agent.chat("question");
            assert.equal(result.status, "completed"); assert.equal(result.stopReason, "length");
            assert.equal(result.message!.text, continuing ? "oldcut" : "cut");
            assert.equal(agent.lastRunState, result); assert.deepEqual(callbacks, ["commit", "completed"]);
            assert.equal(session.trace.records.runs.at(-1)!.status, "completed");
        });
    }
    for (const policy of [undefined, "error"] as const) it(`keeps the original failure policy: ${policy}`, async () => {
        const agent = new Agent({ mode: "tree", model: "test", execution: { lengthPolicy: policy }, provider: { async generate() { return { message: Message.assistant("cut"), finishReason: "length" }; } } });
        await assert.rejects(agent.chat("question"), /output limit/);
        assert.equal(agent.lastRunState!.status, "failed"); assert.equal(agent.session.history().at(-1)!.text, "cut");
    });
    it("allows a per-run override, and still rejects truncated tool calls without executing them", async () => {
        let requests = 0, effects = 0;
        const agent = new Agent({ mode: "tree", model: "test", execution: { lengthPolicy: "complete" }, toolkit: toolkit(() => effects++), provider: { async generate() { return { message: ++requests < 3 ? Message.assistant("cut") : call(), finishReason: "length" }; } } });
        await assert.rejects(agent.chat("one", { execution: { lengthPolicy: "error" } }), /output limit/);
        assert.equal((await agent.chat("two", { execution: { lengthPolicy: "complete" } })).stopReason, "length");
        await assert.rejects(agent.chat("three"), /output limit/);
        assert.equal(effects, 0); assert.equal(agent.session.history().at(-1)!.role, "tool");
    });
    it("rejects an invalid policy before requesting the model", async () => {
        const agent = new Agent({ mode: "tree", model: "test", provider: { async generate() { assert.fail("unexpected request"); } } });
        await assert.rejects(agent.run({ execution: { lengthPolicy: "unknown" as any } }), /lengthPolicy/);
    });
});

describe("CE audit: tools must still be permitted at their actual start", () => {
    for (const makeSession of sessions) for (const stage of ["commit", "approval", "running"] as const) {
        it(`does not execute against a changed ${makeSession().type} history at ${stage}`, async () => {
            const session = makeSession(); let effects = 0;
            const edit = () => session.history().find(message => message.role === "user")!.setText("edited");
            const agent = new Agent({ session, model: "test", toolkit: toolkit(() => effects++), tools: { approval: stage === "approval" ? "manual" : "auto" }, provider: { async generate() { return { message: call() }; } }, hooks: { afterCommit() { if (stage === "commit") edit(); } } });
            agent.on("approvalRequired", event => { if (event.type === "approvalRequired") { edit(); agent.approve(event.request.approvalId); } });
            agent.on("toolUpdated", event => { if (stage === "running" && event.type === "toolUpdated" && event.record.status === "running") edit(); });
            await assert.rejects(agent.chat("question"), error => error instanceof AgentRunError && error.result.stopReason === "conflict");
            assert.equal(effects, 0); assert.equal(agent.pendingApprovals.length, 0); assert.equal(session.isGenerating, false);
        });
    }
    for (const action of ["abort", "disable", "replace"] as const) it(`rechecks ${action} after asynchronous execution notifications`, async () => {
        let effects = 0, replacements = 0, requests = 0;
        class MutableCatalog extends ToolKit {
            replacement?: Tool;
            override get(name: string) { return this.replacement ?? super.get(name); }
        }
        const tools = new MutableCatalog().add(Tool.define({ name: "write", parameters: { type: "object" }, execute: () => effects++ }));
        const agent = new Agent({ mode: "tree", model: "test", toolkit: tools, provider: { async generate() { return { message: ++requests === 1 ? call() : Message.assistant("done") }; } } });
        agent.on("toolUpdated", async event => {
            if (event.type !== "toolUpdated" || event.record.status !== "running") return;
            await Promise.resolve();
            if (action === "abort") agent.abort();
            else if (action === "disable") tools.disable("write");
            else tools.replacement = Tool.define({ name: "write", parameters: { type: "object" }, execute: () => replacements++ });
        });
        if (action === "abort") await assert.rejects(agent.chat("question")); else await agent.chat("question");
        assert.equal(effects, 0); assert.equal(replacements, 0);
        assert.equal(agent.session.trace.records.tools.at(-1)!.status, action === "abort" ? "interrupted" : "failed");
    });
    it("does not start a later sequential tool after an earlier tool changes request history", async () => {
        const session = TreeSession.create(); let first = 0, second = 0;
        const tools = new ToolKit().add(Tool.define({ name: "first", parameters: { type: "object" }, execute() { first++; session.history().find(m => m.role === "user")!.setText("edited"); return "saved"; } }), Tool.define({ name: "second", parameters: { type: "object" }, execute() { second++; return "second"; } }));
        const agent = new Agent({ session, model: "test", toolkit: tools, provider: { async generate() { return { message: Message.assistant([{ type: "tool_call", toolCallId: "one", name: "first", arguments: "{}" }, { type: "tool_call", toolCallId: "two", name: "second", arguments: "{}" }]) }; } } });
        await assert.rejects(agent.chat("question"), error => error instanceof AgentRunError && error.result.stopReason === "conflict" && error.result.unappliedToolResults?.[0].text === "saved");
        assert.equal(first, 1); assert.equal(second, 0);
    });
});

describe("CE audit: protocol repairs and retained partial provenance", () => {
    for (const makeSession of sessions) it(`repairs the current call when a prior ${makeSession().type} turn reused its protocol ID`, async () => {
        const session = makeSession(); let requests = 0, effects = 0;
        const agent = new Agent({ session, model: "test", toolkit: toolkit(() => { effects++; return "saved"; }), provider: { async generate() { return { message: ++requests === 2 ? Message.assistant("done") : call() }; } }, hooks: { afterCommit(message) { if (requests === 3 && message.toolCalls.length) throw new Error("save failed"); } } });
        await agent.chat("one"); await assert.rejects(agent.chat("two"), /save failed/);
        assert.equal(effects, 1); const history = session.history();
        assert.equal(history.filter(message => message.toolCalls.length).length, 2);
        assert.equal(history.filter(message => message.role === "tool").length, 2);
        assert.equal(history.at(-1)!.role, "tool"); assert.match(history.at(-1)!.text, /not started/);
        assert.equal(restoreSession(session.toJSON()).history().at(-1)!.role, "tool");
    });
    for (const makeSession of sessions) it(`attributes interrupted first-segment continuation tools in ${makeSession().type}`, async () => {
        const session = makeSession(); session.addUser("question"); const target = session.addMessage(Message.assistant("old"));
        const agent = new Agent({ session, model: "test", provider: { async generate() { agent.abort(); throw new GenerationError(new DOMException("stopped", "AbortError"), { message: call() }); } } });
        await assert.rejects(agent.continue());
        const result = agent.lastRunState!, step = session.trace.records.steps.at(-1)!;
        const carrier = session.history().find(message => message.toolCalls.length)!, failure = session.history().at(-1)!;
        for (const restored of [session, restoreSession(JSON.parse(JSON.stringify(session.toJSON())))]) {
            for (const criteria of [{ runId: result.runId }, { stepId: step.id }]) {
                const ids = restored.query.messages(criteria).map(message => message.id);
                assert(ids.includes(target.id)); assert(ids.includes(carrier.id)); assert(ids.includes(failure.id));
            }
            const record = restored.query.toolExecutions({ runId: result.runId })[0];
            assert.equal(record.resultMessageId, failure.id); assert.equal(record.status, "interrupted");
        }
    });
});

describe("CE audit: post-commit cancellation owns the live session until the hook settles", () => {
    it("passes a cancellation signal to a cooperative persistence hook", async () => {
        let sawSignal = false;
        const agent = new Agent({ mode: "tree", model: "test", execution: { timeoutMs: 20 }, provider: { async generate() { return { message: Message.assistant("saved") }; } }, hooks: { async afterCommit(_message, context) {
            assert(context.signal); sawSignal = true;
            await new Promise<void>((_resolve, reject) => { if (context.signal!.aborted) reject(context.signal!.reason); else context.signal!.addEventListener("abort", () => reject(context.signal!.reason), { once: true }); });
        } } });
        await assert.rejects(agent.chat("question"), error => error instanceof AgentRunError && error.result.stopReason === "timeout");
        assert(sawSignal); assert.equal(agent.session.history().at(-1)!.text, "saved"); assert.equal(agent.isRunning, false);
    });
    it("keeps the lease for a noncooperative hook and never reports completion after timeout", async () => {
        let release!: () => void;
        const blocked = new Promise<void>(resolve => { release = resolve; });
        const session = TreeSession.create();
        const provider: ChatProvider = { async generate() { return { message: Message.assistant("saved") }; } };
        const agent = new Agent({ session, provider, model: "test", execution: { timeoutMs: 10 }, hooks: { afterCommit() { return blocked; } } });
        const task = agent.chat("question"); const settled = task.then(result => result, error => error);
        try {
            await wait(30); assert.equal(agent.isRunning, true); assert.equal(session.isGenerating, true);
            await assert.rejects(new Agent({ session, provider, model: "test" }).chat("overlap"), /active run/);
        } finally { release(); }
        const failure = await settled;
        assert(failure instanceof AgentRunError); assert.equal(failure.result.status, "interrupted"); assert.equal(failure.result.stopReason, "timeout");
        assert.equal(session.isGenerating, false);
    });
});
