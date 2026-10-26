import { assert, assertJson, copy, id, immutable } from "../core/data";
import { Message, MessageContent, Role } from "../message";
import { ExecutionTrace } from "./trace";
import { SessionData, SessionLike, SessionConflictError, ContinuationCommitOptions } from "./types";
import { prepareContinuation, rebaseContinuationDraft } from "./continuation";
import { SessionQuery } from './SessionQuery';
export abstract class BaseSession implements SessionLike {
    readonly id: string;
    title?: string;
    abstract readonly type: SessionData["type"];
    trace = new ExecutionTrace();
    readonly query = new SessionQuery(this);
    protected messages = new Map<string, Message>();
    protected system: Message;
    protected turnId?: string;
    protected structureVersion = 0;
    private subscriptions = new Map<string, () => void>();
    private meta: Record<string, unknown> = immutable({});
    private lease?: {
        structure: number;
        versions: Map<string, number>;
    };
    constructor(systemPrompt = "", sessionId = id("session")) {
        assert(typeof sessionId === "string" && sessionId, "Invalid session identity");
        this.id = sessionId;
        this.system = Message.system(systemPrompt);
        this.register(this.system);
    }
    get currentTurnId(): string | undefined {
        return this.turnId;
    }
    get isGenerating(): boolean {
        return !!this.lease;
    }
    get metadata(): Readonly<Record<string, unknown>> { return this.meta; }
    setMeta(key: string, value: unknown): this { assertJson(value); this.meta = immutable(copy({ ...this.meta, [key]: value })); return this; }
    deleteMeta(key: string): this { const next = { ...this.meta }; delete next[key]; this.meta = immutable(next); return this; }
    get systemPrompt(): string {
        return this.system.text;
    }
    set systemPrompt(value: string) {
        this.system.setText(value);
    }
    getMessage(messageId: string): Message | undefined {
        return this.messages.get(messageId);
    }
    allMessages(): Message[] {
        return [...this.messages.values()];
    }
    protected register(message: Message): void {
        const existing = this.messages.get(message.id);
        assert(!existing || existing === message, "Distinct messages cannot share an identity");
        if (existing)
            return;
        this.messages.set(message.id, message);
        this.subscriptions.set(message.id, message.onChange(() => this.onMessageChanged(message)));
    }
    protected onMessageChanged(_message: Message): void {
    }
    protected unregister(messageId: string): void {
        this.subscriptions.get(messageId)?.();
        this.subscriptions.delete(messageId);
        this.messages.delete(messageId);
    }
    editMessage(messageId: string, edit: (message: Message) => void): Message {
        const message = this.getMessage(messageId);
        assert(message, "Unknown message");
        edit(message);
        return message;
    }
    addUser(content: MessageContent): Message {
        return this.addMessage(Message.user(content));
    }
    protected input(message: Message): void {
        if (message.role === Role.User)
            this.turnId = this.trace.turn([message.id]).id;
    }
    protected refreshTurn(): void {
        const ids = new Set(this.history().map(m => m.id));
        this.turnId = [...this.trace.records.turns].reverse().find(t => t.inputMessageIds.some(m => ids.has(m)))?.id;
    }
    beginGeneration(): void {
        assert(!this.lease, "Session already has an active generation");
        this.lease = { structure: this.structureVersion, versions: new Map(this.history().map(m => [m.id, m.requestRevision])) };
    }
    assertGenerationUnchanged(): void {
        assert(this.lease, "No active generation");
        if (this.structureVersion !== this.lease.structure || [...this.lease.versions].some(([key, version]) => this.messages.get(key)?.requestRevision !== version))
            throw new SessionConflictError();
    }
    protected acceptOwnChanges(): void {
        if (this.lease)
            this.lease = { structure: this.structureVersion, versions: new Map(this.history().map(m => [m.id, m.requestRevision])) };
    }
    appendGenerated(message: Message): Message {
        this.assertGenerationUnchanged();
        const result = this.append(message);
        this.acceptOwnChanges();
        return result;
    }
    appendContinuation(targetId: string, generated: Message, options: ContinuationCommitOptions = {}): Message {
        this.assertGenerationUnchanged();
        const target = this.getMessage(targetId);
        assert(target && target.role === Role.Assistant, "Invalid continuation target");
        const prepared = prepareContinuation(target, generated);
        const draft = options.draft ? rebaseContinuationDraft(prepared.draft, options.draft, options.baseline ?? prepared.draft) : prepared.draft;
        if (prepared.toolMessage) assert(!this.messages.has(prepared.toolMessage.id), "Generated tool-call message identity already exists");
        assert(JSON.stringify(draft.toolCalls) === JSON.stringify(target.toolCalls), "Tool calls belong to the generated step, not the merged continuation draft");
        target.update({ parts: draft.parts, metadata: copy(draft.metadata), tags: draft.tags, requestMetadataKeys: draft.requestMetadataKeys });
        if (prepared.toolMessage) this.append(prepared.toolMessage);
        this.acceptOwnChanges();
        return target;
    }
    endGeneration(): void {
        this.lease = undefined;
    }
    protected abstract append(message: Message): Message;
    abstract addMessage(message: Message): Message;
    abstract history(): Message[];
    protected abstract structure(): SessionData["structure"];
    toJSON(): SessionData {
        return { format: "agent-engine-session", version: 3, type: this.type, id: this.id, title: this.title, metadata: copy(this.meta), systemMessageId: this.system.id, messages: this.allMessages().map(m => m.toJSON()), trace: this.trace.toJSON(), structure: copy(this.structure()) } as SessionData;
    }
    protected restore(data: SessionData): void {
        assert(data?.format === "agent-engine-session" && data.version === 3 && data.type === this.type && data.id && Array.isArray(data.messages), "Invalid session format");
        for (const unsubscribe of this.subscriptions.values())
            unsubscribe();
        this.messages.clear();
        this.subscriptions.clear();
        for (const item of data.messages) {
            assert(!this.messages.has(item.id), "Duplicate message identity");
            this.register(Message.fromJSON(item));
        }
        const system = this.getMessage(data.systemMessageId);
        assert(system?.role === Role.System, "Invalid session system message");
        this.system = system;
        this.title = data.title;
        assert(data.metadata === undefined || data.metadata && typeof data.metadata === "object" && !Array.isArray(data.metadata), "Invalid session metadata");
        assertJson(data.metadata); this.meta = immutable(copy(data.metadata ?? {}));
        this.trace = ExecutionTrace.fromJSON(data.trace);
    }
    dispose(): void {
        for (const unsubscribe of this.subscriptions.values())
            unsubscribe();
        this.subscriptions.clear();
    }
}
