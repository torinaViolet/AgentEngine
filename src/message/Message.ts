import { assert, assertJson, copy, id, immutable } from "../core/data";
export { Role } from "./Role";
import { Role } from "./Role";
import type { MessagePart as ProtocolPart } from "./MessagePart";
export type MessagePart = ProtocolPart & {
    id?: string;
};
export type { TextPart, ThinkingPart, ImagePart, AudioPart, VideoPart, FilePart, ToolCallPart, ToolResultPart } from "./MessagePart";
export type MessageContent = string | readonly MessagePart[];
export interface MessageData {
    id: string;
    revision: number;
    requestRevision?: number;
    requestMetadataKeys?: string[];
    role: Role;
    parts: MessagePart[];
    metadata: Record<string, unknown>;
    tags: string[];
}
/** Metadata consumed by the built-in wire codecs, rather than business state. */
export const PROTOCOL_METADATA_KEYS = ["thinkingSignature", "geminiThinkingSignature", "openaiReasoningItems", "toolName", "name"] as const;
export interface MessageUpdate {
    parts?: MessageContent;
    metadata?: Record<string, unknown>;
    tags?: readonly string[];
    requestMetadataKeys?: readonly string[];
}
export interface MessageChange {
    message: Message;
    revision: number;
}
/** An editable content object. It has no parents, children or session ownership. */
export class Message {
    readonly id: string;
    readonly role: Role;
    private version: number;
    private requestVersion: number;
    private requestKeys: Set<string>;
    private content: MessagePart[];
    private meta: Record<string, unknown>;
    private labels: string[];
    private observers = new Set<(event: MessageChange) => void>();
    constructor(role: Role, content: MessageContent = "", metadata: Record<string, unknown> = {}, identity?: {
        id: string;
        revision?: number;
        requestRevision?: number;
        requestMetadataKeys?: string[];
        tags?: string[];
    }) {
        assert(Object.values(Role).includes(role), "Invalid message role");
        this.id = identity?.id ?? id("msg");
        this.version = identity?.revision ?? 0;
        this.requestVersion = identity?.requestRevision ?? this.version;
        assert(Number.isSafeInteger(this.requestVersion) && this.requestVersion >= 0 && this.requestVersion <= this.version, "Invalid request revision");
        assert((identity?.requestMetadataKeys ?? []).every(key => typeof key === "string"), "Invalid request metadata keys");
        this.requestKeys = new Set([...PROTOCOL_METADATA_KEYS, ...identity?.requestMetadataKeys ?? []]);
        assert(typeof this.id === "string" && this.id && Number.isSafeInteger(this.version) && this.version >= 0, "Invalid message identity");
        assert(metadata && typeof metadata === "object" && !Array.isArray(metadata), "Invalid message metadata");
        assertJson(metadata);
        assert((identity?.tags ?? []).every(tag => typeof tag === "string"), "Invalid message tags");
        this.role = role;
        this.content = this.normalize(content);
        this.meta = immutable(copy(metadata));
        this.labels = immutable([...new Set(identity?.tags ?? [])]);
    }
    static user(content: MessageContent): Message {
        return new Message(Role.User, content);
    }
    static assistant(content: MessageContent = ""): Message {
        return new Message(Role.Assistant, content);
    }
    static system(content: MessageContent = ""): Message {
        return new Message(Role.System, content);
    }
    static tool(toolCallId: string, result: unknown, name?: string): Message {
        return new Message(Role.Tool, [{ type: "tool_result", toolCallId, name, result: typeof result === "string" ? result : JSON.stringify(result ?? null) }]);
    }
    get revision(): number {
        return this.version;
    }
    get requestRevision(): number { return this.requestVersion; }
    get requestMetadataKeys(): readonly string[] { return immutable([...this.requestKeys]); }
    get parts(): readonly MessagePart[] {
        return this.content;
    }
    get metadata(): Readonly<Record<string, unknown>> {
        return this.meta;
    }
    get tags(): readonly string[] {
        return this.labels;
    }
    get text(): string {
        return this.content.map(p => p.type === "text" ? p.text : p.type === "tool_result" ? p.result : "").join("");
    }
    get thinking(): string {
        return this.content.filter(p => p.type === "thinking").map(p => p.text).join("");
    }
    get toolCalls(): readonly Extract<MessagePart, {
        type: "tool_call";
    }>[] {
        return this.content.filter(p => p.type === "tool_call");
    }
    get isEmpty(): boolean {
        return !this.content.some(p => p.type === "text" || p.type === "thinking" ? p.text.trim() : true);
    }
    get hasMedia(): boolean {
        return this.content.some(p => ["image", "audio", "video", "file"].includes(p.type));
    }
    onChange(handler: (event: MessageChange) => void): () => void {
        this.observers.add(handler);
        return () => this.observers.delete(handler);
    }
    setParts(content: MessageContent): this {
        this.content = this.normalize(content);
        return this.changed(true);
    }
    /** Validate and apply a staged update atomically, preserving this object's identity. */
    update(update: MessageUpdate): this {
        const parts = update.parts === undefined ? this.content : this.normalize(update.parts);
        const metadata = update.metadata ?? this.meta;
        assert(metadata && typeof metadata === "object" && !Array.isArray(metadata), "Invalid message metadata"); assertJson(metadata);
        const tags = update.tags ?? this.labels; assert(tags.every(tag => typeof tag === "string"), "Invalid message tags");
        const keys = new Set([...this.requestKeys, ...update.requestMetadataKeys ?? []]);
        assert([...keys].every(key => typeof key === "string"), "Invalid request metadata keys");
        const affectsRequest = update.parts !== undefined || [...keys].some(key => JSON.stringify(this.meta[key]) !== JSON.stringify(metadata[key]));
        const nextMeta = immutable(copy(metadata)); const nextTags = immutable([...new Set(tags)]);
        this.content = parts; this.meta = nextMeta; this.labels = nextTags; this.requestKeys = keys;
        return this.changed(affectsRequest);
    }
    private replaceText(type: "text" | "thinking", text: string): this {
        const next: MessagePart[] = [];
        let inserted = false;
        for (const part of this.content) {
            if (part.type === type) {
                if (!inserted && text)
                    next.push({ type, text, id: part.id });
                inserted = true;
            }
            else
                next.push(part);
        }
        if (!inserted && text)
            next.push({ type, text });
        return this.setParts(next);
    }
    setText(text: string): this {
        return this.replaceText("text", text);
    }
    setThinking(text: string): this {
        return this.replaceText("thinking", text);
    }
    appendText(text: string): this {
        return this.addPart({ type: "text", text });
    }
    appendThinking(text: string): this {
        return this.addPart({ type: "thinking", text });
    }
    addPart(part: MessagePart): this {
        return this.setParts([...this.content, part]);
    }
    replacePart(partId: string, replacement: MessagePart): this {
        assert(this.content.some(p => p.id === partId), "Unknown content part");
        return this.setParts(this.content.map(p => p.id === partId ? { ...replacement, id: partId } : p));
    }
    removePart(partId: string): this {
        assert(this.content.some(p => p.id === partId), "Unknown content part");
        return this.setParts(this.content.filter(p => p.id !== partId));
    }
    addImage(url: string, mimeType?: string): this {
        return this.addPart({ type: "image", url, mimeType });
    }
    addAudio(url: string, mimeType?: string): this {
        return this.addPart({ type: "audio", url, mimeType });
    }
    addVideo(url: string, mimeType?: string): this {
        return this.addPart({ type: "video", url, mimeType });
    }
    addFile(url: string, options: {
        mimeType?: string;
        fileName?: string;
    } = {}): this {
        return this.addPart({ type: "file", url, ...options });
    }
    setMeta(key: string, value: unknown, options: { affectsRequest?: boolean } = {}): this {
        assertJson(value);
        this.meta = immutable(copy({ ...this.meta, [key]: value }));
        if (options.affectsRequest) this.requestKeys.add(key);
        return this.changed(this.requestKeys.has(key));
    }
    deleteMeta(key: string, options: { affectsRequest?: boolean } = {}): this {
        const next = { ...this.meta };
        delete next[key];
        this.meta = immutable(next);
        if (options.affectsRequest) this.requestKeys.add(key);
        return this.changed(this.requestKeys.has(key));
    }
    tag(...tags: string[]): this {
        this.labels = immutable([...new Set([...this.labels, ...tags])]);
        return this.changed();
    }
    untag(...tags: string[]): this {
        this.labels = immutable(this.labels.filter(tag => !tags.includes(tag)));
        return this.changed();
    }
    hasTag(tag: string): boolean {
        return this.labels.includes(tag);
    }
    /** Detached request snapshot preserves source identity, while clone creates new identity. */
    snapshot(): Message {
        return Message.fromJSON(this.toJSON());
    }
    clone(): Message {
        return new Message(this.role, this.content, this.meta, { id: id("msg"), tags: this.labels, requestMetadataKeys: [...this.requestKeys] });
    }
    toJSON(): MessageData {
        return copy({ id: this.id, revision: this.version, requestRevision: this.requestVersion, requestMetadataKeys: [...this.requestKeys], role: this.role, parts: this.content, metadata: this.meta, tags: this.labels });
    }
    static fromJSON(data: MessageData): Message {
        assert(data && typeof data.id === "string" && Number.isSafeInteger(data.revision) && data.metadata && Array.isArray(data.parts) && Array.isArray(data.tags) && data.tags.every(t => typeof t === "string"), "Invalid message data");
        return new Message(data.role, data.parts, data.metadata, data);
    }
    private normalize(content: MessageContent): MessagePart[] {
        const parts = typeof content === "string" ? (content ? [{ type: "text" as const, text: content }] : []) : copy([...content]);
        const ids = new Set<string>();
        for (const part of parts) {
            assert(part && ["text", "thinking", "image", "audio", "video", "file", "tool_call", "tool_result"].includes(part.type), "Invalid message part");
            if (part.type === "text" || part.type === "thinking")
                assert(typeof part.text === "string", "Invalid text part");
            else if (part.type === "tool_call")
                assert(typeof part.toolCallId === "string" && typeof part.name === "string" && typeof part.arguments === "string", "Invalid tool call");
            else if (part.type === "tool_result")
                assert(typeof part.toolCallId === "string" && typeof part.result === "string", "Invalid tool result");
            else
                assert(typeof part.url === "string", "Invalid media part");
            assertJson(part);
            part.id ??= id("part");
            assert(typeof part.id === "string" && part.id && !ids.has(part.id), "Invalid or duplicate part identity");
            ids.add(part.id);
        }
        return immutable(parts);
    }
    private changed(affectsRequest = false): this {
        this.version++;
        if (affectsRequest) this.requestVersion++;
        for (const observer of [...this.observers])
            observer({ message: this, revision: this.version });
        return this;
    }
}
