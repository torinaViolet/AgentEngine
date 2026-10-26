import {
  AnthropicAdapter,
  GeminiAdapter,
  MessageAdapter,
  OpenAIAdapter,
  OpenAIResponsesAdapter,
} from "../adapter";
import {
  AnthropicClientLike,
  AnthropicMessagesClient,
  GeminiClientLike,
  GeminiModelClient,
  ModelClient,
  OpenAIClientLike,
  OpenAIChatClient,
  OpenAIResponsesClient,
  OpenAIResponsesClientLike,
} from "../client";
import {
  AnthropicStreamParser,
  GeminiStreamParser,
  MessageStreamParser,
  MessageStreamParserFactory,
  OpenAIResponsesStreamParser,
  StreamParser,
} from "../stream";

export interface ProviderOptions {
  client: ModelClient;
  adapter: MessageAdapter;
  parserFactory: MessageStreamParserFactory;
}

/** Groups replaceable provider components without owning Agent execution. */
export class Provider {
  readonly client: ModelClient;
  readonly adapter: MessageAdapter;
  readonly parserFactory: MessageStreamParserFactory;

  constructor(options: ProviderOptions) {
    this.client = options.client;
    this.adapter = options.adapter;
    this.parserFactory = options.parserFactory;
  }

  createParser(): MessageStreamParser {
    return this.parserFactory();
  }

  /** Whether this Provider can return complete, non-streaming responses. */
  get supportsComplete(): boolean {
    return typeof this.client.complete === "function";
  }

  static create(options: ProviderOptions): Provider {
    return new Provider(options);
  }
}

export interface OpenAICompatibleProviderOptions {
  adapter?: MessageAdapter;
  parserFactory?: MessageStreamParserFactory;
}

export interface OpenAIResponsesProviderOptions {
  adapter?: MessageAdapter;
  parserFactory?: MessageStreamParserFactory;
}

/** Default preset for OpenAI Chat Completions compatible clients. */
export class OpenAICompatibleProvider extends Provider {
  constructor(
    client: OpenAIClientLike,
    options: OpenAICompatibleProviderOptions = {}
  ) {
    super({
      client: new OpenAIChatClient(client),
      adapter: options.adapter ?? new OpenAIAdapter(),
      parserFactory: options.parserFactory ?? (() => new StreamParser()),
    });
  }
}

/** Native OpenAI Responses API preset without a hard SDK dependency. */
export class OpenAIResponsesProvider extends Provider {
  constructor(
    client: OpenAIResponsesClientLike,
    options: OpenAIResponsesProviderOptions = {}
  ) {
    super({
      client: new OpenAIResponsesClient(client),
      adapter: options.adapter ?? new OpenAIResponsesAdapter(),
      parserFactory: options.parserFactory ?? (() => new OpenAIResponsesStreamParser()),
    });
  }
}

export interface NativeProviderOptions {
  adapter?: MessageAdapter;
  parserFactory?: MessageStreamParserFactory;
}

/** Native Anthropic Messages preset without a hard SDK dependency. */
export class AnthropicProvider extends Provider {
  constructor(
    client: AnthropicClientLike,
    options: NativeProviderOptions = {}
  ) {
    super({
      client: new AnthropicMessagesClient(client),
      adapter: options.adapter ?? new AnthropicAdapter(),
      parserFactory: options.parserFactory ?? (() => new AnthropicStreamParser()),
    });
  }
}

/** Native Gemini generateContentStream preset without a hard SDK dependency. */
export class GeminiProvider extends Provider {
  constructor(
    client: GeminiClientLike,
    options: NativeProviderOptions = {}
  ) {
    super({
      client: new GeminiModelClient(client),
      adapter: options.adapter ?? new GeminiAdapter(),
      parserFactory: options.parserFactory ?? (() => new GeminiStreamParser()),
    });
  }
}
