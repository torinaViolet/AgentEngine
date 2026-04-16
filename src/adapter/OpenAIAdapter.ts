import { Message } from "../message/Message";
import { Role } from "../message/Role";
import { Usage } from "../message/Usage";
import { MessagePart, ImagePart, FilePart, AudioPart } from "../message/MessagePart";
import { MediaResolver } from "../media/MediaResolver";
import { DefaultMediaResolver } from "../media/DefaultMediaResolver";
import { MessageAdapter, SerializedResult } from "./MessageAdapter";

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
  private resolver: MediaResolver;

  constructor(resolver?: MediaResolver) {
    this.resolver = resolver || new DefaultMediaResolver();
  }

  //========================
  //Serialize: Message[] → OpenAI JSON
  // ========================

  async serialize(messages: Message[]): Promise<SerializedResult> {
    const systemMessages: string[] = [];
    const serialized: unknown[] = [];

    for (const msg of messages) {
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
        serialized.push(this.serializeAssistantMessage(msg));
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

  // ---- Assistant 消息 ----

  private serializeAssistantMessage(msg: Message): unknown {
    const toolCalls = msg.toolCalls;

    if (toolCalls.length > 0) {
      // 包含工具调用
      const result: Record<string, unknown> = {
        role: "assistant",
        ...this.extractNameMeta(msg),
      };

      // 如果同时有文本内容（不含thinking）
      const text = msg.text;
      if (text) {
        result.content = text;
      } else {
        result.content = null;
      }

      result.tool_calls = toolCalls.map((tc) => ({
        id: tc.toolCallId,
        type: "function",
        function: {
          name: tc.name,
          arguments: tc.arguments,
        },
      }));

      return result;
    }

    // 纯文本（序列化时跳过 thinking，不回传给 API）
    return {
      role: "assistant",
      content: msg.text || null,
      ...this.extractNameMeta(msg),
    };
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

    // 多模态 → content 数组
    const contentParts: unknown[] = [];

    for (const part of msg.parts) {
      switch (part.type) {
        case "text":
          contentParts.push({ type: "text", text: part.text });
          break;
        case "image":
          contentParts.push(await this.serializeImagePart(part));
          break;
        case "audio":
          contentParts.push(await this.serializeAudioPart(part));
          break;
        case "file":
          contentParts.push(await this.serializeFilePart(part));
          break;
        default:
          // tool_call / tool_result 不该出现在 user 消息里，跳过
          break;
      }
    }

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
    // 文件作为文本附件或base64，目前以文本方式呈现
    const resolved = await this.resolver.resolve(part.url);
    const label = part.fileName || "file";
    if (resolved.mimeType.startsWith("text/") || resolved.mimeType === "application/json") {
      // 文本文件直接以文本形式展示
      const text = Buffer.from(resolved.base64, "base64").toString("utf-8");
      return {
        type: "text",
        text: `[File: ${label}]\n${text}`,
      };
    }
    // 二进制文件以 data URI 格式嵌入
    return {
      type: "image_url",
      image_url: {
        url: `data:${resolved.mimeType};base64,${resolved.base64}`,
      },
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
    const data = raw as Record<string, any>;

    // OpenAI Chat Completion choice.message 结构
    const role = data.role as string;

    // 提取思考内容（兼容 reasoning_content / thinking）
    const thinkingContent =
      data.reasoning_content ?? data.thinking ?? null;

    // 1. Assistant 带 tool_calls
    if (role === "assistant" && data.tool_calls && data.tool_calls.length > 0) {
      const parts: MessagePart[] = [];

      // 思考内容
      if (thinkingContent) {
        parts.push({ type: "thinking", text: thinkingContent });
      }

      // 可能同时有文本
      if (data.content) {
        parts.push({ type: "text", text: data.content });
      }

      for (const tc of data.tool_calls) {
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
      if (data.content) {
        parts.push({ type: "text", text: data.content });
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
    return new Message(mappedRole, [{ type: "text", text: data.content || "" }]);
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
    const data = raw as Record<string, any>;

    // 从 choices[0].message 解析消息本体
    const choice = data.choices?.[0];
    if (!choice) {
      throw new Error("API响应中没有 choices");
    }

    const message = this.deserialize(choice.message);

    // 填充 model
    if (data.model) {
      message.model = data.model;
    }

    // 填充 usage
    if (data.usage) {
      message.usage = Usage.fromRaw(data.usage);
    }

    return message;
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