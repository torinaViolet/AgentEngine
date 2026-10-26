import { Message } from "../message";
import type { ToolSchema } from "../tool/Tool";
import type { FinishReason } from "../stream/StreamEvent";

/** 思考内容序列化模式 */
export type ThinkingSerializationMode = "none" | "native" | "message" | "auto";

/** 思考内容选择范围 */
export type ThinkingSerializationScope = "none" | "last" | "tool_call" | "all";

/** Adapter 能力声明 */
export interface AdapterCapabilities {
  /** 是否支持以平台原生格式回传 thinking/reasoning_content */
  nativeThinking?: boolean;
  /** 是否支持将 thinking 降级为普通消息/文本块回传 */
  messageThinking?: boolean;
}

/** 思考内容序列化配置 */
export interface ThinkingSerializationOptions {
  /** none=不回传；native=原生字段；message=降级为普通文本；auto=优先 native，失败则 message */
  mode?: ThinkingSerializationMode;
  /** 选择哪些 assistant 消息的 thinking 参与回传 */
  scope?: ThinkingSerializationScope;
  /** 自定义选择器，优先级高于 scope */
  include?: (msg: Message, index: number, messages: Message[]) => boolean;
  /** message 降级模式下的提示前缀 */
  messagePrefix?: string;
}

/** 序列化选项 */
export interface SerializeOptions {
  /** 按需控制 thinking 是否以及如何回传，默认不回传 */
  thinking?: ThinkingSerializationOptions;
}

/** 规范化后的思考序列化配置（供 Adapter 内部使用） */
export interface NormalizedThinkingSerializationOptions {
  mode: Exclude<ThinkingSerializationMode, "auto">;
  scope: ThinkingSerializationScope;
  include?: (msg: Message, index: number, messages: Message[]) => boolean;
  messagePrefix: string;
}

const DEFAULT_THINKING_PREFIX = "[上次推理/思考上下文，仅用于任务恢复，请不要直接复述]\n";

/**
 * 序列化输出结构
 *
 * messages: 目标平台的 messages 数组
 * systemMessage: 被提取出的 system 消息内容（为Anthropic/Gemini 预留）
 */
export interface SerializedResult {
  messages: unknown[];
  systemMessage?: string;
}

/** Input used by adapters to build a provider-native streaming request. */
export interface BuildModelRequestInput {
  model: string;
  serialized: SerializedResult;
  tools?: ToolSchema[];
  options: Record<string, unknown>;
  /** Whether the provider should return a stream. Defaults to true. */
  stream?: boolean;
}

/**
 * 消息适配器接口
 *
 * 负责将统一 Message 模型与具体 API 平台的 JSON 格式相互转换。
 * serialize 为 async —— 因为媒体资源可能需要懒加载（fetch/读文件）。
 */
export interface MessageAdapter {
  /** Adapter 能力声明 */
  readonly capabilities?: AdapterCapabilities;

  /** 统一 Message[] → 平台 JSON */
  serialize(messages: Message[], options?: SerializeOptions): Promise<SerializedResult>;

  /** Build the provider-native request sent by ModelClient. */
  buildRequest?(input: BuildModelRequestInput): Record<string, unknown>;

  /** 平台 JSON响应 → 统一 Message */
  deserialize(raw: unknown): Message;

  /** Deserialize a provider's complete, non-streaming response. */
  deserializeResponse?(raw: unknown): Message;

  /** Extract and normalize the completion reason from a complete response. */
  getFinishReason?(raw: unknown): FinishReason | undefined;
}

/**
 * 根据 Adapter 能力与调用方配置，规范化 thinking 序列化选项。
 */
export function normalizeThinkingOptions(
  options: SerializeOptions | undefined,
  capabilities: AdapterCapabilities = {}
): NormalizedThinkingSerializationOptions {
  const thinking = options?.thinking;
  const requestedMode = thinking?.mode ?? "none";
  let mode: Exclude<ThinkingSerializationMode, "auto">;

  if (requestedMode === "auto") {
    if (capabilities.nativeThinking) {
      mode = "native";
    } else if (capabilities.messageThinking !== false) {
      mode = "message";
    } else {
      mode = "none";
    }
  } else if (requestedMode === "native" && !capabilities.nativeThinking) {
    mode = capabilities.messageThinking !== false ? "message" : "none";
  } else if (requestedMode === "message" && capabilities.messageThinking === false) {
    mode = "none";
  } else {
    mode = requestedMode;
  }

  return {
    mode,
    scope: thinking?.scope ?? "none",
    include: thinking?.include,
    messagePrefix: thinking?.messagePrefix ?? DEFAULT_THINKING_PREFIX,
  };
}

/** 判断某条消息是否应回传 thinking */
export function shouldSerializeThinking(
  msg: Message,
  index: number,
  messages: Message[],
  options: NormalizedThinkingSerializationOptions
): boolean {
  if (options.mode === "none") return false;
  if (!msg.thinking) return false;
  if (options.include) return options.include(msg, index, messages);

  switch (options.scope) {
    case "none":
      return false;
    case "last":
      return index === findLastAssistantWithThinkingIndex(messages);
    case "tool_call":
      return msg.toolCalls.length > 0;
    case "all":
      return true;
  }
}

function findLastAssistantWithThinkingIndex(messages: Message[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].thinking) return i;
  }
  return -1;
}
