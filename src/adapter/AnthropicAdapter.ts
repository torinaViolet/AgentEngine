import { Message } from "../message/Message";
import { Role } from "../message/Role";
import { Usage } from "../message/Usage";
import {
  MessagePart,
  ImagePart,
  FilePart,
  AudioPart,
} from "../message/MessagePart";
import { MediaResolver } from "../media/MediaResolver";
import { BrowserMediaResolver } from "../media/BrowserMediaResolver";
import {
  MessageAdapter,
  SerializedResult,
  SerializeOptions,
  BuildModelRequestInput,
  normalizeThinkingOptions,
  shouldSerializeThinking,
} from "./MessageAdapter";

/**
 * Anthropic (Claude) 消息适配器
 *
 * 将统一 Message 模型转换为 Anthropic Messages API 格式：
 * - System消息提取到顶层 system字段（不放在 messages 中）
 * - Content 使用 Block 数组格式（text / image / tool_use / tool_result / thinking）
 * - 思考内容使用 thinking block（含 signature 用于多轮延续）
 * - Tool 结果使用 tool_result block
 *
 * 用法:
 *   const adapter = new AnthropicAdapter();
 *   const { messages, systemMessage } = await adapter.serialize(history);
 *   // systemMessage →传给Anthropic API 的 system 参数
 *   // messages → 传给 Anthropic API 的 messages 参数
 */
export class AnthropicAdapter implements MessageAdapter {
  readonly capabilities = {
    nativeThinking: true,
    messageThinking: true,
  };

  private resolver: MediaResolver;

  constructor(resolver?: MediaResolver) {
    this.resolver = resolver || new BrowserMediaResolver();
  }

  // ========================
  //  Serialize: Message[] → Anthropic JSON
  // ========================

  async serialize(messages: Message[], options?: SerializeOptions): Promise<SerializedResult> {
    const thinkingOptions = normalizeThinkingOptions(options, this.capabilities);
    const systemParts: string[] = [];
    const serialized: unknown[] = [];

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      const includeThinking = shouldSerializeThinking(msg, i, messages, thinkingOptions);
      if (msg.role === Role.System) {
        // System消息提取到顶层，不放入 messages
        const text = msg.text;
        if (text) systemParts.push(text); continue;
      }

      if (msg.role === Role.Tool) {
        serialized.push(this.serializeToolMessage(msg));
        continue;
      }

      if (msg.role === Role.Assistant) {
        serialized.push(this.serializeAssistantMessage(msg, includeThinking, thinkingOptions.mode, thinkingOptions.messagePrefix));
        continue;
      }

      if (msg.role === Role.User) {
        serialized.push(await this.serializeUserMessage(msg));
        continue;
      }
    }

    // Anthropic 要求 messages 数组必须以 user 开头且user/assistant 交替
    // 合并连续同角色消息
    const merged = this.mergeConsecutiveRoles(serialized);

    return {
      messages: merged,
      systemMessage:
        systemParts.length > 0 ? systemParts.join("\n\n") : undefined,
    };
  }

  buildRequest(input: BuildModelRequestInput): Record<string, unknown> {
    const options = { ...input.options };
    if (options.stop !== undefined && options.stop_sequences === undefined) {
      options.stop_sequences = options.stop;
      delete options.stop;
    }

    const request: Record<string, unknown> = {
      model: input.model,
      messages: input.serialized.messages,
      ...options,
      stream: input.stream ?? true,
    };

    if (input.serialized.systemMessage) {
      request.system = input.serialized.systemMessage;
    }

    if (input.tools && input.tools.length > 0) {
      request.tools = input.tools.map((tool) => ({
        name: tool.function.name,
        description: tool.function.description,
        input_schema: tool.function.parameters,
      }));
    }

    return request;
  }

  // ---- Assistant 消息 ----

  private serializeAssistantMessage(
    msg: Message,
    includeThinking: boolean,
    thinkingMode: "none" | "native" | "message",
    thinkingPrefix: string
  ): unknown {
    const content: unknown[] = [];

    for (const part of msg.parts) {
      switch (part.type) {
        case "thinking":
          if (!includeThinking) break;
          if (thinkingMode === "native") {
            content.push({
              type: "thinking",
              thinking: part.text,
              // signature 从 metadata 获取（多轮对话延续需要）
              ...(msg.metadata.thinkingSignature
                ? { signature: msg.metadata.thinkingSignature as string }
                : {}),
            });
          } else if (thinkingMode === "message") {
            content.push({
              type: "text",
              text: `${thinkingPrefix}${part.text}`,
            });
          }
          break;
        case "text":
          if (part.text) {
            content.push({ type: "text", text: part.text });
          }
          break;
        case "tool_call":
          content.push({
            type: "tool_use",
            id: part.toolCallId,
            name: part.name,
            input: this.safeParseJson(part.arguments),
          });
          break;
        // tool_result 不应出现在 assistant 消息中
        default:
          break;
      }
    }

    return {
      role: "assistant",
      content: content.length > 0 ? content : [{ type: "text", text: "" }],
    };
  }

  // ---- User 消息 ----

  private async serializeUserMessage(msg: Message): Promise<unknown> {
    // 并行处理所有 part 以加速多媒体解析
    const content = (await Promise.all(
      msg.parts.map(async (part): Promise<unknown> => {
        switch (part.type) {
          case "text":
            return { type: "text", text: part.text };
          case "image":
            return await this.serializeImageBlock(part);
          case "audio":
            return await this.serializeAudioBlock(part);
          case "file":
            return await this.serializeFileBlock(part);
          default:
            return null;
        }
      })
    )).filter((c) => c !== null);

    return {
      role: "user",
      content: content.length > 0 ? content : [{ type: "text", text: "" }],
    };
  }

  // ---- Tool 消息 → user role with tool_result block ----

  private serializeToolMessage(msg: Message): unknown {
    const toolResult = msg.parts.find((p) => p.type === "tool_result");
    if (!toolResult || toolResult.type !== "tool_result") {
      throw new Error("Tool message must contain a tool_result part");
    }
    return {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: toolResult.toolCallId,
          content: toolResult.result,
        },
      ],
    };
  }

  // ---- 媒体 Block序列化 ----

  private async serializeImageBlock(part: ImagePart): Promise<unknown> {
    if (part.url.startsWith("http://") || part.url.startsWith("https://")) {
      return {
        type: "image",
        source: {
          type: "url",
          url: part.url,
        },
      };
    }

    const resolved = await this.resolver.resolve(part.url);
    return {
      type: "image",
      source: {
        type: "base64",
        media_type: part.mimeType || resolved.mimeType,
        data: resolved.base64,
      },
    };
  }

  private async serializeAudioBlock(part: AudioPart): Promise<unknown> {
    // Anthropic 暂不原生支持音频，以 base64 文档块呈现
    const resolved = await this.resolver.resolve(part.url);
    return {
      type: "document",
      source: {
        type: "base64",
        media_type: part.mimeType || resolved.mimeType,
        data: resolved.base64,
      },
    };
  }

  private async serializeFileBlock(part: FilePart): Promise<unknown> {
    if (part.url.startsWith("http://") || part.url.startsWith("https://")) {
      return {
        type: "document",
        source: {
          type: "url",
          url: part.url,
        },
      };
    }

    const resolved = await this.resolver.resolve(part.url);
    const mime = part.mimeType || resolved.mimeType;

    // 文本文件直接嵌入
    if (mime.startsWith("text/") || mime === "application/json") {
      const text = Buffer.from(resolved.base64, "base64").toString("utf-8");
      const label = part.fileName || "file";
      return {
        type: "text",
        text: `[File: ${label}]\n${text}`,
      };
    }

    return {
      type: "document",
      source: {
        type: "base64",
        media_type: mime,
        data: resolved.base64,
      },
    };
  }

  // ========================
  //  Deserialize: Anthropic Response → Message
  // ========================

  deserialize(raw: unknown): Message {
    const data = raw as Record<string, unknown>;
    const role = data.role as string;

    if (role === "assistant") {
      const parts: MessagePart[] = [];
      const content = data.content as Array<Record<string, unknown>> | undefined;
      let thinkingSignature: string | undefined;

      if (Array.isArray(content)) {
        for (const block of content) {
          switch (block.type) {
            case "thinking":
              parts.push({ type: "thinking", text: (block.thinking as string) || "" });
              if (block.signature) {
                thinkingSignature = block.signature as string;
              }
              break;
            case "text":
              if (block.text) {
                parts.push({ type: "text", text: block.text as string });
              }
              break;
            case "tool_use":
              parts.push({
                type: "tool_call",
                toolCallId: block.id as string,
                name: block.name as string,
                arguments: JSON.stringify(block.input || {}),
              });
              break;
          }
        }
      }

      const msg = new Message(Role.Assistant, parts);
      if (thinkingSignature) {
        msg.metadata.thinkingSignature = thinkingSignature;
      }
      return msg;
    }

    // 其他角色
    const rawContent = data.content;
    const text =
      typeof rawContent === "string"
        ? rawContent
        : Array.isArray(rawContent)
          ? (rawContent as Array<Record<string, unknown>>)
            .filter((b) => b.type === "text")
            .map((b) => b.text as string)
            .join("")
          : "";

    const roleMap: Record<string, Role> = {
      user: Role.User,
      system: Role.System,
    };
    return new Message(roleMap[role] || Role.User, [
      { type: "text", text },
    ]);
  }

  /**
   * 从完整的 Anthropic API 响应解析
   */
  deserializeResponse(raw: unknown): Message {
    const data = raw as Record<string, unknown>;
    const message = this.deserialize(data);

    if (data.model) {
      message.model = data.model as string;
    }

    if (data.usage) {
      const usage = data.usage as Record<string, number>;
      message.usage = new Usage(
        usage.input_tokens || 0,
        usage.output_tokens || 0,
        (usage.input_tokens || 0) + (usage.output_tokens || 0)
      );
    }

    return message;
  }

  getFinishReason(raw: unknown): string | undefined {
    const stopReason = (raw as Record<string, unknown>).stop_reason as string | undefined;
    switch (stopReason) {
      case "max_tokens":
        return "length";
      case "tool_use":
        return "tool_calls";
      case "end_turn":
      case "stop_sequence":
        return "stop";
      default:
        return stopReason;
    }
  }

  // ========================
  //  辅助
  // ========================

  /**
   * 合并连续同角色消息
   *
   * Anthropic 要求 user/assistant 严格交替，
   * 连续的同角色消息需要合并 content 数组。
   */
  private mergeConsecutiveRoles(messages: unknown[]): unknown[] {
    if (messages.length === 0) return messages;

    interface SerializedMessage {
      role: string;
      content: unknown[] | string;
    }

    const merged: SerializedMessage[] = [];
    for (const raw of messages) {
      const msg = raw as SerializedMessage;
      const last = merged[merged.length - 1];
      if (last && last.role === msg.role) {
        // 合并 content 数组
        const lastContent = Array.isArray(last.content)
          ? last.content
          : [{ type: "text", text: last.content || "" }];
        const msgContent = Array.isArray(msg.content)
          ? msg.content
          : [{ type: "text", text: msg.content || "" }];
        last.content = [...lastContent, ...msgContent];
      } else {
        merged.push({ ...msg });
      }
    }
    return merged;
  }

  private safeParseJson(jsonStr: string): unknown {
    try {
      return JSON.parse(jsonStr);
    } catch {
      return {};
    }
  }
}
