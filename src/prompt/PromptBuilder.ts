import { assert, copy, immutable, id } from "../core/data";
import { Message, Role } from "../message";
export interface PromptSource {
    messageId: string;
    sourceMessageId?: string;
    sourceRevision?: number;
    injected: boolean;
    source?: string;
}
export interface PromptContext {
    messages: Message[];
    sources: PromptSource[];
}
export interface PromptBuildOptions {
    consume?: boolean;
    sources?: readonly PromptSourceInput[];
}
export interface PromptSourceInput {
    messageId: string; sourceMessageId?: string; sourceRevision?: number; injected?: boolean; source?: string;
}
export type PromptPosition = "start" | "end" | "beforeLastUser" | ((messages: readonly Message[]) => number);
export interface InjectionOptions {
    life?: number;
    source?: string;
    position?: PromptPosition;
}
export interface PromptTransformResult { messages: Message[]; sources?: readonly PromptSourceInput[]; }
export type PromptTransform = (messages: Message[]) => Message[] | PromptTransformResult | Promise<Message[] | PromptTransformResult>;
interface Injection {
    id: string;
    message: Message;
    life: number;
    source?: string;
    position: PromptPosition;
}
/** Independent request contexts. Neither transforms nor previews edit source messages. */
export class PromptBuilder {
    private injections: Injection[] = [];
    private operations: PromptTransform[] = [];
    inject(message: Message, options: InjectionOptions = {}): string {
        assert(options.life === undefined || Number.isSafeInteger(options.life) && options.life >= -1, "Injection life must be -1 or a nonnegative integer");
        const injection = { id: id("injection"), message: message.snapshot(), life: options.life ?? -1, source: options.source, position: options.position ?? "start" };
        this.injections.push(injection);
        return injection.id;
    }
    injectSystem(text: string, options: InjectionOptions = {}): string {
        return this.inject(Message.system(text), options);
    }
    remove(injectionId: string): void {
        this.injections = this.injections.filter(i => i.id !== injectionId);
    }
    clear(): void {
        this.injections = [];
        this.operations = [];
    }
    use(transform: PromptTransform): this {
        this.operations.push(transform);
        return this;
    }
    slice(start: number, end?: number): this {
        return this.use(messages => messages.slice(start, end));
    }
    async preview(history: readonly Message[], options: Omit<PromptBuildOptions, "consume"> = {}): Promise<PromptContext> {
        return this.buildContext(history, { ...options, consume: false });
    }
    async build(history: readonly Message[], options: PromptBuildOptions = {}): Promise<Message[]> {
        return (await this.buildContext(history, options)).messages;
    }
    async buildContext(history: readonly Message[], options: PromptBuildOptions = {}): Promise<PromptContext> {
        let messages = history.map(m => m.snapshot());
        const origins = new Map(history.map(m => [m.id, m.revision]));
        const labels = new Map<string, PromptSourceInput>();
        const label = (sources: readonly PromptSourceInput[]) => {
            const seen = new Set<string>();
            for (const source of sources) {
                assert(source && typeof source.messageId === "string" && !seen.has(source.messageId) && messages.some(message => message.id === source.messageId), "Invalid prompt source message reference");
                assert(source.source === undefined || typeof source.source === "string", "Invalid prompt source label");
                assert(source.sourceMessageId === undefined || typeof source.sourceMessageId === "string", "Invalid prompt source identity");
                assert(source.sourceRevision === undefined || Number.isSafeInteger(source.sourceRevision) && source.sourceRevision >= 0, "Invalid prompt source revision");
                assert(source.injected === undefined || typeof source.injected === "boolean", "Invalid prompt source injection flag");
                seen.add(source.messageId); labels.set(source.messageId, { ...labels.get(source.messageId), ...copy(source) });
            }
        };
        label(options.sources ?? []);
        const consumed: Injection[] = [];
        for (const injection of this.injections) {
            if (injection.life === 0)
                continue;
            const position = injection.position;
            let index = typeof position === "function" ? position(messages) : position === "start" ? 0 : position === "end" ? messages.length : messages.map(m => m.role).lastIndexOf(Role.User);
            if (index < 0)
                index = messages.length;
            const message = injection.message.clone();
            labels.set(message.id, { messageId: message.id, source: injection.source, injected: true });
            messages.splice(Math.min(index, messages.length), 0, message);
            consumed.push(injection);
        }
        for (const operation of this.operations) {
            const result = await operation(messages);
            messages = Array.isArray(result) ? result : result.messages;
            assert(Array.isArray(messages) && messages.every(message => message instanceof Message), "Prompt transforms must return Message instances");
            if (!Array.isArray(result)) label(result.sources ?? []);
        }
        messages = messages.filter(m => !m.isEmpty);
        if (options.consume !== false)
            for (const injection of consumed)
                if (injection.life > 0)
                    injection.life--;
        return { messages, sources: immutable(copy(messages.map(m => {
            const explicit = labels.get(m.id);
            const injected = explicit?.injected ?? !origins.has(m.id);
            return { messageId: m.id, sourceMessageId: explicit?.sourceMessageId ?? (injected ? undefined : origins.has(m.id) ? m.id : undefined), sourceRevision: explicit?.sourceRevision ?? (explicit?.sourceMessageId ? origins.get(explicit.sourceMessageId) : injected ? undefined : origins.get(m.id)), injected, source: explicit?.source };
        }))) };
    }
}
