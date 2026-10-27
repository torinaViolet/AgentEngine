import { assert, copy, Events, id, abortable } from "../core/data";
import { Message } from "../message";
import { GenerationConfig, GenerationError, HttpProvider, ModelEvent, ModelRequest, ModelResponse, ChatProvider, ToolDefinition, ThinkingConfig } from "../provider";
export interface GenerationIdentity {
    runId?: string;
    stepId: string;
    messageId: string;
}
export type GenerationEvent = (ModelEvent & GenerationIdentity) | ({
    type: "messageStarted" | "messageGenerated";
    result?: ModelResponse;
} & GenerationIdentity);
export interface GeneratorOptions {
    provider: ChatProvider;
    model: string;
    generation?: GenerationConfig;
    thinking?: ThinkingConfig;
    /** Timeout for one complete model request (including streaming), in milliseconds; 0 means unlimited. */
    requestTimeoutMs?: number;
}
export interface GenerateInput {
    messages: readonly Message[];
    tools?: readonly ToolDefinition[];
    generation?: GenerationConfig;
    stream?: boolean;
    signal?: AbortSignal;
    /** Overrides the Generator's per-request timeout; 0 means unlimited. */
    requestTimeoutMs?: number;
    thinking?: ModelRequest["thinking"];
    identity?: Partial<GenerationIdentity>;
    onEvent?: (event: GenerationEvent) => unknown | Promise<unknown>;
}
/** A single model call. It never writes a session, executes tools or repeats a request. */
export class Generator {
    private events = new Events<GenerationEvent>();
    constructor(readonly options: GeneratorOptions) {
        assert(options.model.trim(), "A model is required");
    }
    on(type: GenerationEvent["type"] | "*", handler: (event: GenerationEvent) => unknown): () => void {
        return this.events.on(type, handler);
    }
    effectiveConfig(overrides?: GenerationConfig): GenerationConfig {
        const config = { ...copy(this.options.generation ?? {}), ...copy(overrides ?? {}) };
        for (const key of ["temperature", "topP", "topK", "maxOutputTokens", "frequencyPenalty", "presencePenalty", "seed"] as const)
            if (config[key] !== undefined)
                assert(Number.isFinite(config[key]), `Invalid ${key}`);
        if (config.maxOutputTokens !== undefined)
            assert(Number.isSafeInteger(config.maxOutputTokens) && config.maxOutputTokens > 0, "maxOutputTokens must be a positive integer");
        if (config.topP !== undefined)
            assert(config.topP >= 0 && config.topP <= 1, "topP must be between 0 and 1");
        if (config.topK !== undefined)
            assert(Number.isSafeInteger(config.topK) && config.topK > 0, "topK must be a positive integer");
        return config;
    }
    async generate(input: GenerateInput): Promise<ModelResponse> {
        const requestTimeoutMs = input.requestTimeoutMs ?? this.options.requestTimeoutMs ?? 0;
        assert(Number.isFinite(requestTimeoutMs) && requestTimeoutMs >= 0, "requestTimeoutMs must be non-negative (0 means unlimited)");
        const identity = { runId: input.identity?.runId, stepId: input.identity?.stepId ?? id("step"), messageId: input.identity?.messageId ?? id("msg") };
        const emit = async (event: GenerationEvent) => {
            await this.events.emit(event);
            await input.onEvent?.(event);
        };
        const assign = (response: ModelResponse): ModelResponse => ({ ...response, message: Message.fromJSON({ ...response.message.toJSON(), id: identity.messageId }) });
        input.signal?.throwIfAborted();
        await emit({ type: "messageStarted", ...identity });
        const controller = requestTimeoutMs > 0 ? new AbortController() : undefined;
        const signal = controller?.signal ?? input.signal;
        const externalAbort = () => controller?.abort(input.signal?.reason);
        if (controller) {
            input.signal?.addEventListener("abort", externalAbort, { once: true });
            if (input.signal?.aborted) externalAbort();
        }
        const timer = controller ? setTimeout(() => controller.abort(new DOMException("Model request timed out", "TimeoutError")), requestTimeoutMs) : undefined;
        const partial = Message.assistant();
        let finished = false;
        try {
            signal?.throwIfAborted();
            const thinking = this.options.thinking || input.thinking ? { ...this.options.thinking, ...input.thinking } : undefined;
            const work = this.options.provider.generate({ model: this.options.model, messages: input.messages.map(m => m.snapshot()), tools: copy(input.tools), generation: this.effectiveConfig(input.generation), thinking }, { signal, stream: input.stream ?? true }, async (event) => {
                if (finished)
                    return;
                if (event.type === "textDelta")
                    partial.setText(event.snapshot);
                if (event.type === "thinkingDelta")
                    partial.setThinking(event.snapshot);
                await emit({ ...event, ...identity });
            });
            // Built-in HTTP providers retain native parser state while cancelling their reader.
            const result = assign(await (this.options.provider instanceof HttpProvider ? work : abortable(work, signal)));
            if (timer !== undefined) clearTimeout(timer);
            await emit({ type: "messageGenerated", result, ...identity });
            return result;
        }
        catch (error) {
            if (error instanceof GenerationError)
                throw new GenerationError(error.cause, error.partial ? assign(error.partial) : undefined);
            if (signal?.aborted && !partial.isEmpty)
                throw new GenerationError(error, assign({ message: partial }));
            throw error;
        }
        finally {
            finished = true;
            if (timer !== undefined) clearTimeout(timer);
            if (controller) input.signal?.removeEventListener("abort", externalAbort);
        }
    }
}
