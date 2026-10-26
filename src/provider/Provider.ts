import { Message } from "../message";
import type { TokenUsage } from "../session/trace";
import type { MediaResolver } from "./media";
import { abortable, assert } from "../core/data";
import { BrowserMediaResolver } from "../legacy/media/BrowserMediaResolver";
import { fetchTransport, decodeSSE, readResponseBytes } from "./transport";
import type { SSEOptions } from "./transport";
export interface ThinkingConfig {
    mode?: "none" | "native" | "message" | "auto";
    scope?: "none" | "last" | "tool_call" | "all";
    include?: (message: Message, index: number, messages: readonly Message[]) => boolean;
    messagePrefix?: string;
}
export interface ToolDefinition {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
}
export interface GenerationConfig {
    temperature?: number;
    topP?: number;
    topK?: number;
    maxOutputTokens?: number;
    stop?: string[];
    frequencyPenalty?: number;
    presencePenalty?: number;
    seed?: number;
    responseFormat?: {
        type: "text" | "json_object" | "json_schema";
        name?: string;
        schema?: Record<string, unknown>;
    };
    /** Explicit protocol escape hatch, never mixed with execution controls. */
    providerOptions?: Record<string, unknown>;
}
export interface ModelRequest {
    model: string;
    messages: readonly Message[];
    tools?: readonly ToolDefinition[];
    generation?: GenerationConfig;
    thinking?: ThinkingConfig;
}
export interface ModelResponse {
    message: Message;
    usage?: TokenUsage;
    finishReason?: string;
    model?: string;
}
export interface SerializedMessages { messages: unknown[]; systemMessage?: string; }
export type ModelEvent = {
    type: "textDelta" | "thinkingDelta";
    delta: string;
    snapshot: string;
} | {
    type: "toolCallDelta";
    index: number;
    delta?: string;
    snapshot?: string;
    toolCallId?: string;
    name?: string;
};
/** Structural capability accepted by Agent and Generator; inheritance is optional. */
export interface ChatProvider {
    generate(request: ModelRequest, options: {
        signal?: AbortSignal;
        stream: boolean;
    }, emit?: (event: ModelEvent) => Promise<void>): Promise<ModelResponse>;
}
export interface HttpRequest {
    url: string;
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
    headers: Record<string, string>;
    body?: Record<string, unknown> | BodyInit;
    signal?: AbortSignal;
    stream: boolean;
    purpose?: RequestPurpose;
}
export type RequestPurpose = "chat" | "image" | "audio" | "video" | "embedding" | "models" | "custom";
export interface ChatHttpRequest extends HttpRequest {
    method: "POST";
    body: Record<string, unknown>;
}
export type Transport = (request: HttpRequest) => Promise<Response>;
export interface ProviderOptions {
    apiKey?: string | (() => string | Promise<string>);
    baseURL?: string;
    headers?: Record<string, string>;
    transport?: Transport;
    mediaResolver?: MediaResolver;
}
export type HttpProviderOptions = ProviderOptions;
export interface ProviderRequestOptions {
    method?: HttpRequest["method"];
    body?: HttpRequest["body"];
    headers?: Record<string, string>;
    signal?: AbortSignal;
    stream?: boolean;
    purpose?: RequestPurpose;
}
/** Shared HTTP/media infrastructure. A subclass implements only the capabilities it offers. */
export abstract class Provider {
    protected readonly options: ProviderOptions;
    private readonly resolver: MediaResolver;
    constructor(options: ProviderOptions = {}) {
        this.options = { ...options, headers: { ...options.headers } };
        this.resolver = options.mediaResolver ?? new BrowserMediaResolver();
    }
    protected get baseURL(): string { return (this.options.baseURL ?? "").replace(/\/+$/, ""); }
    protected async resolveApiKey(signal?: AbortSignal): Promise<string> {
        signal?.throwIfAborted();
        return typeof this.options.apiKey === "function" ? abortable(Promise.resolve(this.options.apiKey()), signal) : this.options.apiKey ?? "";
    }
    protected async authHeaders(signal?: AbortSignal): Promise<Record<string, string>> {
        const key = await this.resolveApiKey(signal);
        return key ? { authorization: `Bearer ${key}` } : {};
    }
    protected async buildHttpRequest(path: string, init: ProviderRequestOptions = {}): Promise<HttpRequest> {
        assert(this.baseURL, "A baseURL is required for this provider request");
        assert(!/^[a-z][a-z\d+.-]*:/i.test(path) && !path.startsWith("//"), "Provider requests use paths relative to baseURL");
        const method = init.method ?? "POST";
        assert(method !== "GET" || init.body === undefined, "GET requests cannot contain a body");
        const headers = new Headers(isJsonBody(init.body) ? { "content-type": "application/json" } : {});
        for (const group of [await this.authHeaders(init.signal), this.options.headers, init.headers])
            for (const [key, value] of Object.entries(group ?? {})) headers.set(key, value);
        // Fetch generates the multipart boundary. A shared JSON header must not replace it.
        if (typeof FormData !== "undefined" && init.body instanceof FormData) headers.delete("content-type");
        assert(init.stream === undefined || typeof init.stream === "boolean", "stream must be a boolean");
        return { url: `${this.baseURL}/${path.replace(/^\/+/, "")}`, method, headers: Object.fromEntries(headers.entries()), body: init.body, signal: init.signal, stream: init.stream ?? false, purpose: init.purpose ?? "custom" };
    }
    protected async send(request: HttpRequest): Promise<Response> {
        request.signal?.throwIfAborted();
        const response = await abortable((this.options.transport ?? fetchTransport)(request), request.signal);
        if (!response.ok) {
            const body = await abortable(response.text(), request.signal);
            let detail = body;
            try { const data = JSON.parse(body); detail = data.error?.message ?? data.message ?? body; } catch {}
            throw new ProviderRequestError(`HTTP ${response.status}: ${detail}`, response.status);
        }
        return response;
    }
    protected async request(path: string, init: ProviderRequestOptions = {}): Promise<Response> { return this.send(await this.buildHttpRequest(path, init)); }
    protected async requestJSON<T = unknown>(path: string, init: ProviderRequestOptions = {}): Promise<T> {
        return abortable((await this.request(path, init)).json(), init.signal) as Promise<T>;
    }
    protected readEvents(response: Response, signal?: AbortSignal, options?: SSEOptions): AsyncIterable<unknown> { return decodeSSE(response, signal, options); }
    protected readBytes(response: Response, signal?: AbortSignal, maxBytes?: number): Promise<Uint8Array> { return readResponseBytes(response, signal, maxBytes); }
    protected resolveMedia(url: string, signal?: AbortSignal) { signal?.throwIfAborted(); return abortable(this.resolver.resolve(url), signal); }
}
/** Kept separate from binary and multipart bodies at the fetch boundary. */
export function isJsonBody(body: HttpRequest["body"]): body is Record<string, unknown> {
    if (!body || typeof body !== "object") return false;
    const prototype = Object.getPrototypeOf(body);
    return prototype === null || Object.getPrototypeOf(prototype) === null && prototype.constructor?.name === "Object";
}
export class ProviderRequestError extends Error {
    readonly code = "PROVIDER_REQUEST";
    constructor(message: string, readonly status?: number) {
        super(message);
        this.name = "ProviderRequestError";
    }
}
export class GenerationError extends Error {
    constructor(readonly cause: unknown, readonly partial?: ModelResponse) {
        super(cause instanceof Error ? cause.message : String(cause));
        this.name = cause instanceof Error ? cause.name : "GenerationError";
    }
}
