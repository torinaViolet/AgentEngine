import { abortable, assert, copy } from "../core/data";
import { Message, MessagePart } from "../message";
import { Message as ProtocolMessage } from "../legacy/message/Message";
import { OpenAIAdapter, OpenAIResponsesAdapter, AnthropicAdapter, GeminiAdapter } from "../legacy/adapter";
import type { MessageAdapter } from "../legacy/adapter";
import { StreamParser, OpenAIResponsesStreamParser, AnthropicStreamParser, GeminiStreamParser } from "../legacy/stream";
import type { MessageStreamParser } from "../legacy/stream";
import { Provider, ChatProvider, HttpProviderOptions, ChatHttpRequest, ModelRequest, ModelResponse, ModelEvent, GenerationConfig, GenerationError, SerializedMessages } from './Provider';
import { decodeSSE } from './transport';
type Protocol = "openai" | "responses" | "anthropic" | "gemini";
const defaults: Record<Protocol, string> = { openai: "https://api.openai.com/v1", responses: "https://api.openai.com/v1", anthropic: "https://api.anthropic.com/v1", gemini: "https://generativelanguage.googleapis.com/v1beta" };
export class HttpProvider extends Provider implements ChatProvider {
    private adapter: MessageAdapter;
    constructor(readonly protocol: Protocol, options: HttpProviderOptions = {}) {
        super({ ...options, baseURL: options.baseURL ?? defaults[protocol] });
        this.adapter = protocol === "openai" ? new OpenAIAdapter(options.mediaResolver) : protocol === "responses" ? new OpenAIResponsesAdapter(options.mediaResolver) : protocol === "anthropic" ? new AnthropicAdapter(options.mediaResolver) : new GeminiAdapter(options.mediaResolver);
    }
    private parser(): MessageStreamParser {
        return this.protocol === "openai" ? new StreamParser() : this.protocol === "responses" ? new OpenAIResponsesStreamParser() : this.protocol === "anthropic" ? new AnthropicStreamParser() : new GeminiStreamParser();
    }
    /** Override this hook to add protocol-specific content such as video input. */
    protected async serializeMessages(request: ModelRequest, signal?: AbortSignal): Promise<SerializedMessages> {
        const selected = request.messages.filter(m => !m.isEmpty).map(message => message.snapshot());
        assert(!selected.some(message => message.parts.some(part => part.type === "video")), "Video input is not supported by this chat codec; override serializeMessages in a provider subclass");
        const messages = selected.map(message => new ProtocolMessage(message.role, copy(message.parts.filter(part => part.type !== "video")), copy(message.metadata)));
        const thinking = request.thinking ? { ...request.thinking, include: request.thinking.include ? (_message: ProtocolMessage, index: number) => request.thinking!.include!(selected[index], index, selected) : undefined } : undefined;
        return abortable(this.adapter.serialize(messages, { thinking }), signal);
    }
    protected async authHeaders(signal?: AbortSignal): Promise<Record<string, string>> {
        const key = await this.resolveApiKey(signal);
        if (this.protocol === "anthropic") return { ...(key ? { "x-api-key": key } : {}), "anthropic-version": "2023-06-01" };
        if (this.protocol === "gemini") return key ? { "x-goog-api-key": key } : {};
        return key ? { authorization: `Bearer ${key}` } : {};
    }
    /** Inspect the actual wire request without sending it. */
    async buildRequest(request: ModelRequest, stream = true, signal?: AbortSignal): Promise<ChatHttpRequest> {
        const serialized = await this.serializeMessages(request, signal);
        const generation = request.generation ?? {};
        const native = copy(generation.providerOptions ?? {});
        const unsupported: Partial<Record<Protocol, Array<keyof GenerationConfig>>> = { openai: ["topK"], responses: ["topK", "stop", "seed", "frequencyPenalty", "presencePenalty"], anthropic: ["frequencyPenalty", "presencePenalty", "seed", "responseFormat"] };
        for (const key of unsupported[this.protocol] ?? [])
            assert(generation[key] === undefined, `${key} is not supported by ${this.protocol}`);
        if (this.protocol === "gemini" && generation.responseFormat?.type === "text")
            native.responseMimeType = "text/plain";
        const mapping: Record<string, string> = { temperature: "temperature", topP: "top_p", topK: "top_k", maxOutputTokens: "max_tokens", stop: "stop", frequencyPenalty: "frequency_penalty", presencePenalty: "presence_penalty", seed: "seed" };
        for (const [key, wire] of Object.entries(mapping)) {
            const value = generation[key as keyof GenerationConfig];
            const aliases: Record<string, string> = this.protocol === "gemini" ? { maxOutputTokens: "maxOutputTokens", topP: "topP", topK: "topK", stop: "stopSequences", frequencyPenalty: "frequencyPenalty", presencePenalty: "presencePenalty" } : this.protocol === "anthropic" ? { stop: "stop_sequences" } : this.protocol === "responses" ? { maxOutputTokens: "max_output_tokens" } : {};
            if (value !== undefined) {
                assert(native[wire] === undefined && (!aliases[key] || native[aliases[key]] === undefined), `Conflicting configuration: ${key} and providerOptions.${aliases[key] ?? wire}`);
                native[wire] = copy(value);
            }
        }
        if (generation.responseFormat && !(this.protocol === "gemini" && generation.responseFormat.type === "text")) {
            assert(native.response_format === undefined, "Conflicting response format");
            const format = generation.responseFormat;
            native.response_format = format.type === "json_schema" ? { type: format.type, json_schema: { name: format.name ?? "output", schema: format.schema } } : { type: format.type };
        }
        if (this.protocol === "anthropic")
            native.max_tokens ??= 4096;
        if (this.protocol === "openai" && stream)
            native.stream_options ??= { include_usage: true };
        const body = this.adapter.buildRequest!({ model: request.model, serialized, stream, options: native, tools: request.tools?.map(tool => ({ type: "function", function: { name: tool.name, description: tool.description ?? "", parameters: tool.parameters as never } })) });
        let path: string;
        let wireBody = body;
        if (this.protocol === "gemini") {
            const { systemInstruction, tools, toolConfig, safetySettings, ...generationConfig } = (body.config ?? {}) as Record<string, unknown>;
            wireBody = { contents: body.contents, ...(systemInstruction ? { systemInstruction: { parts: [{ text: systemInstruction }] } } : {}), ...(tools ? { tools } : {}), ...(toolConfig ? { toolConfig } : {}), ...(safetySettings ? { safetySettings } : {}), generationConfig };
            const resource = request.model.startsWith("models/") ? request.model : `models/${request.model}`;
            path = `${resource.split("/").map(encodeURIComponent).join("/")}:${stream ? "streamGenerateContent?alt=sse" : "generateContent"}`;
        }
        else {
            path = this.protocol === "openai" ? "chat/completions" : this.protocol === "responses" ? "responses" : "messages";
        }
        for (const reserved of ["model", "messages", "input", "contents", "stream", "tools", "system"])
            assert(generation.providerOptions?.[reserved] === undefined, `Provider option ${reserved} is managed by the framework`);
        return { ...await this.buildHttpRequest(path, { method: "POST", body: wireBody, signal, stream, purpose: "chat", headers: { accept: stream ? "text/event-stream" : "application/json" } }), method: "POST", body: wireBody };
    }
    async generate(request: ModelRequest, options: {
        signal?: AbortSignal;
        stream: boolean;
    }, emit?: (event: ModelEvent) => Promise<void>): Promise<ModelResponse> {
        const wire = await this.buildRequest(request, options.stream, options.signal);
        const response = await this.send(wire);
        let message: ProtocolMessage;
        let finishReason: string | undefined;
        if (!options.stream) {
            const raw = await abortable(response.json(), options.signal);
            message = this.adapter.deserializeResponse ? this.adapter.deserializeResponse(raw) : this.adapter.deserialize(raw);
            finishReason = this.adapter.getFinishReason?.(raw);
        }
        else {
            const parser = this.parser();
            const send = async (events: ReturnType<MessageStreamParser["feed"]>) => {
                for (const event of events) {
                    if (event.type === "error")
                        throw event.error;
                    if (event.type === "text_delta" || event.type === "thinking_delta")
                        await emit?.({ type: event.type === "text_delta" ? "textDelta" : "thinkingDelta", delta: event.delta, snapshot: event.snapshot });
                    if (event.type === "tool_call_start")
                        await emit?.({ type: "toolCallDelta", index: event.index, toolCallId: event.toolCallId, name: event.name });
                    if (event.type === "tool_call_delta")
                        await emit?.({ type: "toolCallDelta", index: event.index, delta: event.argsDelta, snapshot: event.argsSnapshot });
                }
            };
            try {
                for await (const chunk of decodeSSE(response, options.signal))
                    await send(parser.feed(chunk));
                await send(parser.finish());
            }
            catch (error) {
                throw new GenerationError(error, this.convert(parser.snapshot, parser.finishReason));
            }
            message = parser.snapshot;
            finishReason = parser.finishReason;
        }
        return this.convert(message, finishReason);
    }
    private convert(message: ProtocolMessage, finishReason?: string): ModelResponse {
        const parts = copy(message.parts) as MessagePart[];
        for (const part of parts)
            if (part.type === "thinking") {
                const state: Record<string, unknown> = {};
                for (const key of ["thinkingSignature", "geminiThinkingSignature"])
                    if (message.metadata[key])
                        state[key] = message.metadata[key];
                if (Object.keys(state).length)
                    part.metadata = { ...state, ...part.metadata };
            }
        return { message: new Message(message.role, parts, copy(message.metadata)), finishReason, model: message.model,
            usage: message.usage ? { inputTokens: message.usage.promptTokens, outputTokens: message.usage.completionTokens, totalTokens: message.usage.totalTokens } : undefined };
    }
}
export class OpenAICompatibleProvider extends HttpProvider {
    constructor(options: HttpProviderOptions = {}) {
        super("openai", options);
    }
}
export class OpenAIResponsesProvider extends HttpProvider {
    constructor(options: HttpProviderOptions = {}) {
        super("responses", options);
    }
}
export class AnthropicProvider extends HttpProvider {
    constructor(options: HttpProviderOptions = {}) {
        super("anthropic", options);
    }
}
export class GeminiProvider extends HttpProvider {
    constructor(options: HttpProviderOptions = {}) {
        super("gemini", options);
    }
}
