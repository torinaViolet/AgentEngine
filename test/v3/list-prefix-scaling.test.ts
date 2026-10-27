import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AgentSession, Message } from "../../src";

function history(count: number): AgentSession {
    const seed = AgentSession.create(); const data = seed.toJSON(); seed.dispose();
    for (let index = 0; index < count; index++) {
        const user = Message.user(`question ${index}`), reply = Message.assistant(`reply ${index}`);
        data.messages.push(user.toJSON(), reply.toJSON());
        data.structure.rows.push({ id: `row-\"中文\\${index}`, selectedCandidateId: `candidate-${index}`, candidates: [{ id: `candidate-${index}`, messageIds: [user.id, reply.id], context: "" }] });
    }
    return AgentSession.fromJSON(data);
}
function legacyContext(session: AgentSession, end: number): string {
    const rows = session.rows;
    const source = JSON.stringify([session.history()[0].id, session.history()[0].requestRevision, ...rows.slice(0, end).map(row => {
        const selected = row.candidates.find(candidate => candidate.id === row.selectedCandidateId)!;
        return [row.id, selected.id, selected.messageIds.map(key => [key, session.getMessage(key)!.requestRevision])];
    })]);
    let a = 2166136261, b = 2246822519;
    for (let i = 0; i < source.length; i++) { a = Math.imul(a ^ source.charCodeAt(i), 16777619); b = Math.imul(b ^ source.charCodeAt(i), 3266489917); }
    return `${(a >>> 0).toString(16)}:${(b >>> 0).toString(16)}`;
}

describe("linear list history validity checks without a storage-format migration", () => {
    it("preserves every existing 3.0 fingerprint, including escaped and non-ASCII identities", () => {
        const session = history(40); session.acceptHistory();
        for (const [index, row] of session.rows.entries()) assert.equal(row.candidates[0].context, legacyContext(session, index));
        const restored = AgentSession.fromJSON(JSON.parse(JSON.stringify(session.toJSON())));
        assert.deepEqual(restored.staleRowIds, []);
        const row = restored.rows[8], original = row.selectedCandidateId;
        restored.addCandidate(row.id, [Message.user("changed"), Message.assistant("alternative")]);
        assert.equal(restored.staleRowIds.length, 31);
        restored.select(row.id, original); assert.deepEqual(restored.staleRowIds, []);
        restored.getMessage(restored.rows[10].candidates[0].messageIds[0])!.setText("edited");
        assert.equal(restored.staleRowIds.length, 29); restored.acceptHistory(); assert.deepEqual(restored.staleRowIds, []);
    });
    for (const count of [250, 500, 1000, 2000]) it(`reads request revisions linearly when accepting/scanning/starting ${count} turns`, () => {
        const session = history(count); let reads = 0;
        const descriptor = Object.getOwnPropertyDescriptor(Message.prototype, "requestRevision")!;
        for (const message of session.allMessages()) Object.defineProperty(message, "requestRevision", { configurable: true, get() { reads++; return descriptor.get!.call(this); } });
        session.acceptHistory(); assert(reads < count * 3 + 5, `acceptHistory repeated ${reads} revision reads`);
        reads = 0; assert.deepEqual(session.staleRowIds, []); assert(reads < count * 3 + 5, `staleRowIds repeated ${reads} revision reads`);
        reads = 0; session.beginGeneration(); assert(reads < count * 5 + 10, `beginGeneration repeated ${reads} revision reads`); session.endGeneration();
        session.dispose();
    });
});
