/** Options shared by model client transports. */
export interface ModelClientOptions {
  signal?: AbortSignal;
}

/**
 * Minimal transport boundary used by Agent.
 *
 * A client sends an already adapted provider request and returns either raw
 * stream chunks or one complete response. It does not know about Message,
 * Session, tools, or stream events.
 */
export interface ModelClient {
  stream(
    request: Record<string, unknown>,
    options?: ModelClientOptions
  ): Promise<AsyncIterable<unknown>>;

  /** Send a request that returns one complete provider response. */
  complete?(
    request: Record<string, unknown>,
    options?: ModelClientOptions
  ): Promise<unknown>;
}

/** Minimal OpenAI-compatible client shape kept for backwards compatibility. */
export interface OpenAIClientLike {
  chat: {
    completions: {
      create(params: any, options?: any): Promise<any>;
    };
  };
}

/** Minimal OpenAI Responses SDK shape. */
export interface OpenAIResponsesClientLike {
  responses: {
    create(params: any, options?: any): Promise<any>;
  };
}

/** Minimal Anthropic Messages SDK shape. */
export interface AnthropicClientLike {
  messages: {
    create(params: any, options?: any): Promise<any>;
  };
}

/** Minimal Gemini SDK shape. */
export interface GeminiClientLike {
  models: {
    generateContentStream(params: any): Promise<any> | any;
    generateContent?(params: any): Promise<any> | any;
  };
}

/** Adapts an OpenAI Chat Completions compatible SDK to ModelClient. */
export class OpenAIChatClient implements ModelClient {
  constructor(readonly client: OpenAIClientLike) {}

  async stream(
    request: Record<string, unknown>,
    options?: ModelClientOptions
  ): Promise<AsyncIterable<unknown>> {
    return this.client.chat.completions.create(
      request,
      options?.signal ? { signal: options.signal } : undefined
    );
  }

  async complete(
    request: Record<string, unknown>,
    options?: ModelClientOptions
  ): Promise<unknown> {
    return this.client.chat.completions.create(
      request,
      options?.signal ? { signal: options.signal } : undefined
    );
  }
}

/** Adapts the OpenAI Responses SDK surface to ModelClient. */
export class OpenAIResponsesClient implements ModelClient {
  constructor(readonly client: OpenAIResponsesClientLike) {}

  async stream(
    request: Record<string, unknown>,
    options?: ModelClientOptions
  ): Promise<AsyncIterable<unknown>> {
    return this.client.responses.create(
      request,
      options?.signal ? { signal: options.signal } : undefined
    );
  }

  async complete(
    request: Record<string, unknown>,
    options?: ModelClientOptions
  ): Promise<unknown> {
    return this.client.responses.create(
      request,
      options?.signal ? { signal: options.signal } : undefined
    );
  }
}

/** Adapts an Anthropic Messages compatible SDK to ModelClient. */
export class AnthropicMessagesClient implements ModelClient {
  constructor(readonly client: AnthropicClientLike) {}

  async stream(
    request: Record<string, unknown>,
    options?: ModelClientOptions
  ): Promise<AsyncIterable<unknown>> {
    return this.client.messages.create(
      request,
      options?.signal ? { signal: options.signal } : undefined
    );
  }

  async complete(
    request: Record<string, unknown>,
    options?: ModelClientOptions
  ): Promise<unknown> {
    return this.client.messages.create(
      request,
      options?.signal ? { signal: options.signal } : undefined
    );
  }
}

/** Adapts a Gemini generateContentStream compatible SDK to ModelClient. */
export class GeminiModelClient implements ModelClient {
  constructor(readonly client: GeminiClientLike) {}

  async stream(
    request: Record<string, unknown>,
    options?: ModelClientOptions
  ): Promise<AsyncIterable<unknown>> {
    const config = {
      ...((request.config as Record<string, unknown> | undefined) ?? {}),
      ...(options?.signal ? { abortSignal: options.signal } : {}),
    };
    return this.client.models.generateContentStream({
      ...request,
      ...(Object.keys(config).length > 0 ? { config } : {}),
    });
  }

  async complete(
    request: Record<string, unknown>,
    options?: ModelClientOptions
  ): Promise<unknown> {
    if (!this.client.models.generateContent) {
      throw new Error("Gemini client does not provide models.generateContent()");
    }
    const config = {
      ...((request.config as Record<string, unknown> | undefined) ?? {}),
      ...(options?.signal ? { abortSignal: options.signal } : {}),
    };
    return this.client.models.generateContent({
      ...request,
      ...(Object.keys(config).length > 0 ? { config } : {}),
    });
  }
}

export function isModelClient(client: ModelClient | OpenAIClientLike): client is ModelClient {
  return typeof (client as ModelClient).stream === "function";
}

export function toModelClient(client: ModelClient | OpenAIClientLike): ModelClient {
  return isModelClient(client) ? client : new OpenAIChatClient(client);
}
