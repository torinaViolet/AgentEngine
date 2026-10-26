import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Message, Role, TreeSession, ListSession, AgentSession, restoreSession, PromptBuilder, SessionConflictError } from "../../src";

describe("3.0 independent message and session contracts", () => {
  it("rejects non-serializable content and invalid restored execution records", () => {
    const cyclic: any = {}; cyclic.self = cyclic;
    assert.throws(() => Message.assistant().setMeta("bad", cyclic), /Cyclic/);
    assert.throws(() => Message.assistant().setMeta("bad", new Map()), /JSON/);
    const session = TreeSession.create(); session.addUser("input"); const run = session.trace.run("chat", session.currentTurnId); session.trace.step(run.id);
    const snapshot = session.toJSON(); snapshot.trace.steps[0].status = "unknown" as any;
    assert.throws(() => restoreSession(snapshot), /Invalid model step/);
    assert.throws(() => restoreSession({ ...session.toJSON(), type: "unknown" as any }), /Unknown session/);
  });
  it("removes alternative candidates and rows without retaining unreferenced message objects", () => {
    const session = ListSession.create(); session.addUser("input"); const original = session.addMessage(Message.assistant("original"));
    const row = session.rows[1]; const replacement = Message.assistant("replacement"); const alternative = session.addCandidate(row.id, [replacement]);
    session.removeCandidate(row.id, alternative); assert.equal(session.getMessage(replacement.id), undefined); assert.equal(session.history().at(-1)!.id, original.id);
    session.regenerate(row.id); session.cancelRegeneration(); assert.equal(session.history().at(-1)!.id, original.id);
    session.removeRow(row.id); assert.equal(session.getMessage(original.id), undefined); assert.equal(session.rows.length, 1);
  });
  it("owns content edits, immutable views, stable identity and revisions without tree properties", () => {
    const parts: any[] = [{ type: "text", text: "A" }, { type: "image", url: "data:image/png;base64,AA==" }, { type: "thinking", text: "plan" }, { type: "text", text: "B" }];
    const message = new Message(Role.Assistant, parts, { nested: { value: 1 } }); const identity = message.id;
    parts[0].text = "outside"; assert.equal(message.text, "AB");
    assert.throws(() => { (message.parts[0] as any).text = "outside"; });
    assert.throws(() => { (message.metadata.nested as any).value = 2; });
    message.setText("new").appendThinking(" more");
    assert.equal(message.text, "new"); assert.equal(message.thinking, "plan more"); assert.equal(message.revision, 2); assert.equal(message.id, identity);
    assert.equal(message.parts[1].type, "image"); assert.equal("parent" in message, false); assert.equal("children" in message, false);
    assert.notEqual(message.clone().id, identity); assert.equal(message.snapshot().id, identity);
  });
  it("uses content-block identities for replacements and change subscriptions", () => {
    const message = Message.assistant("one"); let calls = 0; const off = message.onChange(() => calls++);
    const partId = message.parts[0].id!; message.replacePart(partId, { type: "text", text: "two" }); assert.equal(message.parts[0].id, partId);
    message.removePart(partId); off(); message.setText("three"); assert.equal(calls, 2);
  });
  it("preserves tree siblings, selection and deep structure using a flat snapshot", () => {
    const session = TreeSession.create("system"); const input = session.addUser("question"); const parent = session.cursorNodeId!;
    session.addMessage(Message.assistant("A")); const first = session.cursorNodeId!;
    session.select(parent); session.addMessage(Message.assistant("B")); const second = session.cursorNodeId!;
    assert.equal(session.nodes.find(n => n.id === parent)!.children.length, 2);
    const restored = TreeSession.fromJSON(JSON.parse(JSON.stringify(session.toJSON()))); assert.equal(restored.cursorNodeId, second);
    restored.select(first); assert.deepEqual(restored.history().map(m => m.text), ["system", "question", "A"]);
    assert.equal(restored.getMessage(input.id)?.text, "question"); restored.remove(first); assert.equal(restored.cursorNodeId, parent);
    const deep = TreeSession.create(); for (let i = 0; i < 3000; i++) deep.addMessage(Message.assistant(String(i)));
    assert.equal(TreeSession.fromJSON(JSON.parse(JSON.stringify(deep.toJSON()))).history().length, 3001);
  });
  it("rejects malformed or cyclic session snapshots", () => {
    const session = TreeSession.create(); session.addUser("x"); const data = session.toJSON(); const tree = data.structure as any;
    tree.nodes[0].parentId = tree.nodes[0].id; tree.nodes[0].children.push(tree.nodes[0].id);
    tree.roots = [];
    assert.throws(() => TreeSession.fromJSON(data), /Unreachable|Cyclic/);
  });
  it("queries and edits actual messages without copying editing logic", () => {
    const session = TreeSession.create(); const message = session.addUser("hello").tag("input").setMeta("owner", "test");
    assert.equal(session.query.messages({ role: Role.User, content: /^hello/g, tags: ["input"], metadata: { owner: "test" } })[0], message);
    session.editMessage(message.id, m => m.setText("edited")); assert.equal(session.query.messages({ content: "edited" })[0], message);
  });
  it("keeps sequence candidates together and detects retained stale history after edits", () => {
    const session = ListSession.create(); session.addUser("one"); session.beginGeneration();
    session.appendGenerated(Message.assistant("call")); session.appendGenerated(Message.tool("c", "result")); session.appendGenerated(Message.assistant("answer")); session.endGeneration();
    assert.equal(session.rows.length, 2); assert.equal(session.rows[1].candidates[0].messageIds.length, 3);
    session.addUser("two"); const row = session.rows[1]; const old = row.selectedCandidateId;
    session.addCandidate(row.id, [Message.assistant("alternative")]); assert.equal(session.staleRowIds.length, 1);
    assert.throws(() => session.beginGeneration(), /stale/); session.acceptHistory(); assert.equal(session.staleRowIds.length, 0);
    session.select(row.id, old); assert.equal(session.staleRowIds.length, 1);
    const restored = ListSession.fromJSON(JSON.parse(JSON.stringify(session.toJSON()))); assert.equal(restored.rows[1].candidates.length, 2); assert.equal(restored.staleRowIds.length, 1);
  });
  it("regenerates an earlier sequence without using or changing downstream history", () => {
    const session = ListSession.create(); session.addUser("one"); session.addMessage(Message.assistant("old")); session.addUser("later");
    session.regenerate(session.rows[1].id); session.beginGeneration(); assert.deepEqual(session.history().map(m => m.text), ["", "one"]);
    session.appendGenerated(Message.assistant("new")); session.appendGenerated(Message.tool("c", "result")); assert.deepEqual(session.history().map(m => m.text), ["", "one", "new", "result"]);
    session.endGeneration(); assert.equal(session.rows[1].candidates[1].messageIds.length, 2); assert.equal(session.history().at(-1)?.text, "later");
  });
  it("groups interaction candidates and preserves the actual input during regeneration", () => {
    const session = ListSession.create({ candidateUnit: "turn" }); session.addUser("one"); session.beginGeneration(); session.appendGenerated(Message.assistant("old")); session.endGeneration();
    session.regenerate(session.rows[0].id); session.beginGeneration(); assert.equal(session.history().at(-1)?.text, "one"); session.appendGenerated(Message.assistant("new")); session.endGeneration();
    assert.deepEqual(session.history().map(m => m.text), ["", "one", "new"]); assert.equal(session.rows[0].candidates.length, 2);
    const agent = AgentSession.create(); agent.addUser("one"); agent.addMessage(Message.assistant("reply")); agent.addUser("two"); agent.addMessage(Message.assistant("reply 2"));
    assert.equal(agent.rows.length, 2); assert.equal(restoreSession(agent.toJSON()).type, "agent");
  });
  it("detects external content edits and selection changes during generation", () => {
    const session = TreeSession.create(); const user = session.addUser("before"); session.beginGeneration(); user.setText("after");
    assert.throws(() => session.appendGenerated(Message.assistant("obsolete")), SessionConflictError); session.endGeneration();
    session.beginGeneration(); session.select(null); assert.throws(() => session.assertGenerationUnchanged(), SessionConflictError); session.endGeneration();
  });
  it("supports asynchronous prompt transforms and non-consuming isolated previews", async () => {
    const user = Message.user("original"); const builder = new PromptBuilder(); builder.injectSystem("once", { life: 1, source: "rule" });
    builder.use(async messages => { messages.find(m => m.id === user.id)!.setText("request only"); return messages; });
    const preview = await builder.preview([user]); assert.equal(user.text, "original"); assert.equal(preview.sources[0].source, "rule");
    assert.equal((await builder.preview([user])).messages[0].text, "once"); assert.equal((await builder.build([user]))[0].text, "once");
    assert.equal((await builder.build([user]))[0].text, "request only");
  });
});
