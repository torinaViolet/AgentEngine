import { assert, copy, id, immutable } from "../core/data";
import { Message, Role } from "../message";
import type { SessionData, ListSessionData, AgentSessionData, ContinuationCommitOptions } from "./types";
import type { ListCandidate, ListRow, ListStructure } from "./structures";
import { BaseSession } from './BaseSession';
export class ListSession extends BaseSession {
    readonly type: "list" | "agent" = "list";
    readonly candidateUnit: "sequence" | "turn";
    protected items: ListRow[] = [];
    private generating?: ListCandidate;
    private regeneration: number | null = null;
    private generationEnd?: number;
    constructor(options: {
        systemPrompt?: string;
        candidateUnit?: "sequence" | "turn";
        id?: string;
    } = {}) {
        super(options.systemPrompt, options.id);
        this.candidateUnit = options.candidateUnit ?? "sequence";
        assert(["sequence", "turn"].includes(this.candidateUnit), "Invalid candidate unit");
    }
    static create(options: {
        systemPrompt?: string;
        candidateUnit?: "sequence" | "turn";
    } = {}): ListSession {
        return new ListSession(options);
    }
    get rows(): readonly ListRow[] {
        return immutable(copy(this.items));
    }
    private selected(row: ListRow): ListCandidate {
        return row.candidates.find(c => c.id === row.selectedCandidateId)!;
    }
    private prefix(end: number): string {
        const source = JSON.stringify([this.system.id, this.system.requestRevision, ...this.items.slice(0, end).map(row => [row.id, this.selected(row).id, this.selected(row).messageIds.map(key => [key, this.getMessage(key)!.requestRevision])])]);
        let hash = 2166136261;
        let second = 2246822519;
        for (let i = 0; i < source.length; i++) {
            hash = Math.imul(hash ^ source.charCodeAt(i), 16777619);
            second = Math.imul(second ^ source.charCodeAt(i), 3266489917);
        }
        return `${(hash >>> 0).toString(16)}:${(second >>> 0).toString(16)}`;
    }
    get staleRowIds(): string[] {
        return this.items.filter((row, index) => this.selected(row).context !== this.prefix(index)).map(row => row.id);
    }
    history(): Message[] {
        const end = this.regeneration ?? this.generationEnd ?? this.items.length;
        const messages = this.items.slice(0, end).flatMap(row => this.selected(row).messageIds.map(key => this.messages.get(key)!));
        if (this.regeneration !== null && this.candidateUnit === "turn")
            messages.push(...this.selected(this.items[this.regeneration]).messageIds.map(key => this.messages.get(key)!).filter(m => m.role === Role.User));
        return [this.system, ...messages];
    }
    protected append(message: Message): Message {
        this.register(message);
        let candidate = this.generating;
        if (!candidate && this.regeneration === null && this.candidateUnit === "turn" && message.role !== Role.User && this.items.length)
            candidate = this.selected(this.items[this.items.length - 1]);
        if (!candidate) {
            const index = this.regeneration ?? this.items.length;
            const inputs = this.regeneration !== null && this.candidateUnit === "turn" ? this.selected(this.items[index]).messageIds.filter(key => this.getMessage(key)!.role === Role.User) : [];
            candidate = { id: id("candidate"), messageIds: [...inputs], turnId: this.turnId, context: this.prefix(index) };
            if (index === this.items.length)
                this.items.push({ id: id("row"), selectedCandidateId: candidate.id, candidates: [candidate] });
            else {
                this.items[index].candidates.push(candidate);
                this.items[index].selectedCandidateId = candidate.id;
            }
            if (this.regeneration !== null)
                this.generationEnd = index + 1;
            this.regeneration = null;
        }
        candidate.messageIds.push(message.id);
        this.structureVersion++;
        return message;
    }
    addMessage(message: Message): Message {
        assert(this.regeneration === null, "Use Agent.run for regeneration");
        this.input(message);
        return this.append(message);
    }
    beginGeneration(): void {
        const end = this.regeneration ?? this.items.length;
        const stale = new Set(this.staleRowIds);
        assert(!this.items.slice(0, end).some(row => stale.has(row.id)), "History is stale: accept, truncate or regenerate it first");
        super.beginGeneration();
        if (this.candidateUnit === "turn" && this.regeneration === null && this.items.length)
            this.generating = this.selected(this.items[this.items.length - 1]);
    }
    appendGenerated(message: Message): Message {
        const result = super.appendGenerated(message);
        if (!this.generating)
            this.generating = this.items.flatMap(row => row.candidates).find(candidate => candidate.messageIds.includes(message.id));
        return result;
    }
    appendContinuation(targetId: string, generated: Message, options?: ContinuationCommitOptions): Message {
        this.assertGenerationUnchanged();
        const candidate = this.items.flatMap(row => row.candidates).find(item => item.messageIds.includes(targetId));
        assert(candidate, "Unknown continuation candidate");
        this.generating = candidate;
        return super.appendContinuation(targetId, generated, options);
    }
    endGeneration(): void {
        super.endGeneration();
        this.generating = undefined;
        this.regeneration = null;
        this.generationEnd = undefined;
    }
    select(rowId: string, candidateId: string): void {
        const row = this.items.find(r => r.id === rowId);
        assert(row && row.candidates.some(c => c.id === candidateId), "Unknown candidate");
        row.selectedCandidateId = candidateId;
        this.structureVersion++;
        this.refreshTurn();
    }
    addCandidate(rowId: string, messages: readonly Message[]): string {
        const index = this.items.findIndex(r => r.id === rowId);
        assert(index >= 0 && messages.length, "Invalid candidate");
        for (const message of messages)
            this.register(message);
        const candidate = { id: id("candidate"), messageIds: messages.map(m => m.id), turnId: this.turnId, context: this.prefix(index) };
        this.items[index].candidates.push(candidate);
        this.items[index].selectedCandidateId = candidate.id;
        this.structureVersion++;
        return candidate.id;
    }
    regenerate(rowId: string): void {
        const index = this.items.findIndex(r => r.id === rowId);
        assert(index >= 0, "Unknown row");
        this.regeneration = index;
        this.structureVersion++;
        this.turnId = this.selected(this.items[index]).turnId;
    }
    cancelRegeneration(): void {
        this.regeneration = null;
        this.structureVersion++;
        this.refreshTurn();
    }
    private pruneUnused(): void {
        const retained = new Set([this.system.id, ...this.items.flatMap(row => row.candidates.flatMap(candidate => candidate.messageIds))]);
        for (const key of this.messages.keys())
            if (!retained.has(key))
                this.unregister(key);
    }
    removeCandidate(rowId: string, candidateId: string): void {
        const row = this.items.find(row => row.id === rowId);
        assert(row, "Unknown row");
        const index = row.candidates.findIndex(candidate => candidate.id === candidateId);
        assert(index >= 0 && row.candidates.length > 1, "Use removeRow to remove a row's only candidate");
        row.candidates.splice(index, 1);
        if (row.selectedCandidateId === candidateId)
            row.selectedCandidateId = row.candidates[Math.min(index, row.candidates.length - 1)].id;
        this.pruneUnused();
        this.structureVersion++;
        this.refreshTurn();
    }
    removeRow(rowId: string): void {
        const index = this.items.findIndex(row => row.id === rowId);
        assert(index >= 0, "Unknown row");
        this.items.splice(index, 1);
        this.regeneration = null;
        this.pruneUnused();
        this.structureVersion++;
        this.refreshTurn();
    }
    acceptHistory(): void {
        for (let i = 0; i < this.items.length; i++)
            this.selected(this.items[i]).context = this.prefix(i);
        this.structureVersion++;
    }
    truncateAfter(rowId: string | null): void {
        const index = rowId === null ? -1 : this.items.findIndex(r => r.id === rowId);
        assert(rowId === null || index >= 0, "Unknown row");
        this.items.splice(index + 1);
        const retained = new Set([this.system.id, ...this.items.flatMap(r => r.candidates.flatMap(c => c.messageIds))]);
        for (const key of this.messages.keys())
            if (!retained.has(key))
                this.unregister(key);
        this.structureVersion++;
        this.refreshTurn();
    }
    protected structure(): ListStructure {
        return { candidateUnit: this.candidateUnit, rows: this.items };
    }
    toJSON(): ListSessionData | AgentSessionData { return super.toJSON() as ListSessionData | AgentSessionData; }
    protected load(data: SessionData): void {
        this.restore(data);
        const structure = data.structure as ListStructure;
        assert(Array.isArray(structure.rows) && structure.candidateUnit === this.candidateUnit, "Invalid list structure");
        const identifiers = new Set<string>();
        for (const row of structure.rows) {
            assert(typeof row.id === "string" && row.id && !identifiers.has(row.id) && Array.isArray(row.candidates) && row.candidates.length, "Invalid row");
            identifiers.add(row.id);
            for (const candidate of row.candidates) {
                assert(typeof candidate.id === "string" && candidate.id && !identifiers.has(candidate.id) && Array.isArray(candidate.messageIds) && candidate.messageIds.length && new Set(candidate.messageIds).size === candidate.messageIds.length && candidate.messageIds.every(key => this.messages.has(key) && key !== this.system.id) && typeof candidate.context === "string", "Invalid candidate");
                identifiers.add(candidate.id);
            }
            assert(row.candidates.some(c => c.id === row.selectedCandidateId), "Unknown selected candidate");
        }
        this.items = copy(structure.rows);
        this.refreshTurn();
    }
    static fromJSON(data: SessionData): ListSession {
        const structure = data.structure as {
            candidateUnit: "sequence" | "turn";
        };
        const session = new ListSession({ id: data.id, candidateUnit: structure?.candidateUnit });
        session.load(data);
        return session;
    }
}
