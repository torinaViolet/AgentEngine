import { Message } from "../message/Message";
import { Role } from "../message/Role";
import { Usage } from "../message/Usage";
import { MessagePart, ImagePart, FilePart, AudioPart } from "../message/MessagePart";
import { MediaResolver } from "../media/MediaResolver";
import { DefaultMediaResolver } from "../media/DefaultMediaResolver";
import {
  MessageAdapter,
  SerializedResult,
  SerializeOptions,
  BuildModelRequestInput,
  normalizeThinkingOptions,
  shouldSerializeThinking,
} from "./MessageAdapter";

/**
 * OpenAI 消息适配器
 *
 * 将统一 Message 模型转换为 OpenAI Chat Completions API 格式，
 * 并将OpenAI 响应反序列化回统一 Message。
 *
 * 懒加载策略：
 * - https:// 图片 → 直接传URL给 OpenAI（它原生支持）
 * - 本地文件 / data URI → 通过 MediaResolver 转为 data URI
 */
export class OpenAIAdapter implements MessageAdapter {
  readonly capabilities = {
    nativeThinking: true,
    messageThinking: true,
  };

  private resolver: MediaResolver;

  constructor(resolver?: MediaResolver) {
    this.resolver = resolver || new DefaultMediaResolver();
  }

  //========================
  //Serialize: Message[] → OpenAI JSON
  // ========================

  async serialize(messages: Message[], options?: SerializeOptions): Promise<SerializedResult> {
    const thinkingOptions = normalizeThinkingOptions(options, this.capabilities);
    const systemMessages: string[] = [];
    const serialized: unknown[] = [];

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      const includeThinking = shouldSerializeThinking(msg, i, messages, thinkingOptions);
      if (msg.role === Role.System) {
        // System消息正常放入 messages 数组（OpenAI 支持）
        serialized.push({
          role: "system",
          content: msg.text,
          ...this.extractNameMeta(msg),
        });
        systemMessages.push(msg.text);
        continue;
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

    return {
      messages: serialized,
      systemMessage:
        systemMessages.length > 0 ? systemMessages.join("\n") : undefined,
    };
  }

  buildRequest(input: BuildModelRequestInput): Record<string, unknown> {
    const request: Record<string, unknown> = {
      model: input.model,
      messages: input.serialized.messages,
      ...input.options,
      stream: input.stream ?? true,
    };

    if (input.tools && input.tools.length > 0) {
      request.tools = input.tools;
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
    const toolCalls = msg.toolCalls;
    const result: Record<string, unknown> = {
      role: "assistant",
      ...this.extractNameMeta(msg),
    };

    // 思考内容按序列化策略回传：默认不回传，避免浪费 token
    const thinking = includeThinking ? msg.thinking : "";
    if (thinking && thinkingMode === "native") {
      result.reasoning_content = thinking;
    }

    // 文本内容
    const text = msg.text;
    const composed =
      thinking && thinkingMode === "message"
        ? `${thinkingPrefix}${thinking}\n\n${text}`
        : text;

    // 当 assistant 仅有 tool_calls 而无文本时，用空字符串而非 null。
    // —— OpenAI 标准对 null / "" / string 都接受，但部分 OpenAI 兼容代理
    //    （尤其 Anthropic 的 OpenAI 兼容层）会因 content: null 而丢弃 tool_calls，
    //    导致下一轮 tool_result 找不到对应的 tool_use。
    if (composed) {
      result.content = composed;
    } else if (toolCalls.length > 0) {
      result.content = "";
    } else {
      result.content = null;
    }

    // 工具调用
    if (toolCalls.length > 0) {
      result.tool_calls = toolCalls.map((tc) => ({
        id: tc.toolCallId,
        type: "function",
        function: {
          name: tc.name,
          arguments: tc.arguments,
        },
      }));
    }

    return result;
  }

  // ---- User 消息 ----

  private async serializeUserMessage(msg: Message): Promise<unknown> {
    if (!msg.hasMedia) {
      //纯文本，简洁格式
      return {
        role: "user",
        content: msg.text,
        ...this.extractNameMeta(msg),
      };
    }

    // 多模态 → content 数组（并行处理各 part 以加速多媒体解析）
    const contentParts = (await Promise.all(
      msg.parts.map(async (part): Promise<unknown> => {
        switch (part.type) {
          case "text":
            return { type: "text", text: part.text };
          case "image":
            return await this.serializeImagePart(part);
          case "audio":
            return await this.serializeAudioPart(part);
          case "file":
            return await this.serializeFilePart(part);
          default:
            // tool_call / tool_result 不该出现在 user 消息里，跳过
            return null;
        }
      })
    )).filter((p) => p !== null);

    return {
      role: "user",
      content: contentParts,
      ...this.extractNameMeta(msg),
    };
  }

  // ---- Tool 消息 ----

  private serializeToolMessage(msg: Message): unknown {
    const toolResult = msg.parts.find((p) => p.type === "tool_result");
    if (!toolResult || toolResult.type !== "tool_result") {
      throw new Error("Tool message must contain a tool_result part");
    }
    return {
      role: "tool",
      tool_call_id: toolResult.toolCallId,
      content: toolResult.result,
    };
  }

  // ---- 媒体 Part序列化 ----

  private async serializeImagePart(part: ImagePart): Promise<unknown> {
    const url = await this.resolveMediaUrl(part.url, part.mimeType);
    return {
      type: "image_url",
      image_url: { url },
    };
  }

  private async serializeAudioPart(part: AudioPart): Promise<unknown> {
    // OpenAI input_audio 格式
    const resolved = await this.resolver.resolve(part.url);
    return {
      type: "input_audio",
      input_audio: {
        data: resolved.base64,
        format: this.audioFormat(resolved.mimeType),
      },
    };
  }

  private async serializeFilePart(part: FilePart): Promise<unknown> {
    const resolved = await this.resolver.resolve(part.url);
    const label = part.fileName || "file";
    const mime = part.mimeType || resolved.mimeType;

    // 文本文件：直接嵌入内容
    if (mime.startsWith("text/") || mime === "application/json") {
      const text = Buffer.from(resolved.base64, "base64").toString("utf-8");
      return {
        type: "text",
        text: `[File: ${label}]\n${text}`,
      };
    }

    // PDF：使用 OpenAI Chat Completions 的 file content part(GPT-4o 等支持 file_data)
    if (mime === "application/pdf") {
      return {
        type: "file",
        file: {
          filename: label,
          file_data: `data:${mime};base64,${resolved.base64}`,
        },
      };
    }

    // 其他二进制：用文本占位符提示模型；避免伪装为 image_url 触发模型解码失败
    const approxBytes = Math.ceil(resolved.base64.length * 0.75);
    return {
      type: "text",
      text: `[Attached binary file: ${label} (${mime}, ~${approxBytes} bytes) — content not inlined]`,
    };
  }

  /**
   * 懒加载核心：
   * - https:// 直接返回原始URL（OpenAI 原生支持）
   * - 其他格式通过 MediaResolver 转为 data URI
   */
  private async resolveMediaUrl(
    url: string,
    mimeType?: string
  ): Promise<string> {
    if (url.startsWith("http://") || url.startsWith("https://")) {
      return url;
    }
    if (url.startsWith("data:")) {
      return url;
    }
    // 本地文件 →解析为 data URI
    const resolved = await this.resolver.resolve(url);
    const mime = mimeType || resolved.mimeType;
    return `data:${mime};base64,${resolved.base64}`;
  }

  private audioFormat(mimeType: string): string {
    const map: Record<string, string> = {
      "audio/wav": "wav",
      "audio/mpeg": "mp3",
      "audio/mp3": "mp3",
      "audio/mp4": "mp4",
      "audio/ogg": "ogg",
      "audio/flac": "flac",
    };
    return map[mimeType] || "wav";
  }

  // ========================
  //  Deserialize: OpenAI Response → Message
  // ========================

  deserialize(raw: unknown): Message {
    const data = raw as Record<string, unknown>;

    // OpenAI Chat Completion choice.message 结构
    const role = data.role as string;
    const content = data.content as string | undefined;

    // 提取思考内容（兼容 reasoning_content / thinking）
    const thinkingContent =
      (data.reasoning_content ?? data.thinking ?? null) as string | null;

    // 工具调用列表
    const toolCallsRaw = data.tool_calls as
      | Array<{ id: string; function: { name: string; arguments: string } }>
      | undefined;

    // 1. Assistant 带 tool_calls
    if (role === "assistant" && toolCallsRaw && toolCallsRaw.length > 0) {
      const parts: MessagePart[] = [];

      // 思考内容
      if (thinkingContent) {
        parts.push({ type: "thinking", text: thinkingContent });
      }

      // 可能同时有文本
      if (content) {
        parts.push({ type: "text", text: content });
      }

      for (const tc of toolCallsRaw) {
        parts.push({
          type: "tool_call",
          toolCallId: tc.id,
          name: tc.function.name,
          arguments: tc.function.arguments,
        });
      }

      return new Message(Role.Assistant, parts);
    }

    // 2. Assistant 纯文本（可能有思考）
    if (role === "assistant") {
      const parts: MessagePart[] = [];
      if (thinkingContent) {
        parts.push({ type: "thinking", text: thinkingContent });
      }
      if (content) {
        parts.push({ type: "text", text: content });
      }
      return new Message(Role.Assistant, parts);
    }

    // 3. 其他角色（通常反序列化只处理 assistant 响应）
    const roleMap: Record<string, Role> = {
      system: Role.System,
      user: Role.User,
      tool: Role.Tool,
    };
    const mappedRole = roleMap[role] || Role.User;
    return new Message(mappedRole, [{ type: "text", text: content || "" }]);
  }

  // ========================
  //  Deserialize: 完整 API Response → Message
  // ========================

  /**
   * 从完整的 OpenAI Chat Completion 响应解析
   * 自动提取 usage 和 model 信息填充到 Message 上
   *
   * @param raw 完整的 chat.completions.create() 返回值
   */
  deserializeResponse(raw: unknown): Message {
    const data = raw as Record<string, unknown>;

    // 从 choices[0].message 解析消息本体
    const choices = data.choices as Array<Record<string, unknown>> | undefined;
    const choice = choices?.[0];
    if (!choice) {
      throw new Error("API响应中没有 choices");
    }

    const message = this.deserialize(choice.message as Record<string, unknown>);

    // 填充 model
    if (data.model) {
      message.model = data.model as string;
    }

    // 填充 usage
    if (data.usage) {
      message.usage = Usage.fromRaw(data.usage);
    }

    return message;
  }

  getFinishReason(raw: unknown): string | undefined {
    const data = raw as Record<string, unknown>;
    const choices = data.choices as Array<Record<string, unknown>> | undefined;
    return choices?.[0]?.finish_reason as string | undefined;
  }

  // ========================
  //  辅助
  // ========================

  private extractNameMeta(msg: Message): Record<string, unknown> {
    const extra: Record<string, unknown> = {};
    if (msg.metadata.name) {
      extra.name = msg.metadata.name;
    }
    return extra;
  }
}
