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
import { generateId } from "../utils";
import {
  MessageAdapter,
  SerializedResult,
  SerializeOptions,
  BuildModelRequestInput,
  normalizeThinkingOptions,
  shouldSerializeThinking,
} from "./MessageAdapter";

/**
 * Google Gemini 消息适配器
 *
 * 将统一 Message 模型转换为 Gemini API 格式：
 * - System 消息提取到顶层 system_instruction
 * - 角色映射：assistant → model, user → user
 * - Content 使用 parts 数组（text / inline_data / functionCall / functionResponse）
 * - 思考内容使用 thought: true标记的text part
 * - Tool 结果使用 functionResponse part
 *
 * 用法:
 *   const adapter = new GeminiAdapter();
 *   const { messages, systemMessage } = await adapter.serialize(history);
 *   // systemMessage → 传给Gemini API 的 system_instruction
 *  // messages → 传给 Gemini API 的 contents参数
 */
export class GeminiAdapter implements MessageAdapter {
  readonly capabilities = {
    nativeThinking: true,
    messageThinking: true,
  };

  private resolver: MediaResolver;

  constructor(resolver?: MediaResolver) {
    this.resolver = resolver || new BrowserMediaResolver();
  }

  // ========================
  //  Serialize: Message[] → Gemini JSON
  // ========================

  async serialize(messages: Message[], options?: SerializeOptions): Promise<SerializedResult> {
    const thinkingOptions = normalizeThinkingOptions(options, this.capabilities);
    const systemParts: string[] = [];
    const serialized: unknown[] = [];

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      const includeThinking = shouldSerializeThinking(msg, i, messages, thinkingOptions);
      if (msg.role === Role.System) {
        // System 消息提取到顶层 system_instruction
        const text = msg.text;
        if (text) systemParts.push(text); continue;
      }

      if (msg.role === Role.Tool) {
        serialized.push(this.serializeToolMessage(msg));
        continue;
      }

      if (msg.role === Role.Assistant) {
        serialized.push(await this.serializeModelMessage(msg, includeThinking, thinkingOptions.mode, thinkingOptions.messagePrefix));
        continue;
      }

      if (msg.role === Role.User) {
        serialized.push(await this.serializeUserMessage(msg));
        continue;
      }
    }

    // Gemini 要求 user/model 交替，合并连续同角色消息
    const merged = this.mergeConsecutiveRoles(serialized);

    return {
      messages: merged,
      systemMessage:
        systemParts.length > 0 ? systemParts.join("\n\n") : undefined,
    };
  }

  buildRequest(input: BuildModelRequestInput): Record<string, unknown> {
    const config: Record<string, unknown> = { ...input.options };
    const moveOption = (from: string, to: string) => {
      if (config[from] !== undefined && config[to] === undefined) {
        config[to] = config[from];
      }
      delete config[from];
    };

    moveOption("max_tokens", "maxOutputTokens");
    moveOption("top_p", "topP");
    moveOption("top_k", "topK");
    moveOption("frequency_penalty", "frequencyPenalty");
    moveOption("presence_penalty", "presencePenalty");
    moveOption("stop", "stopSequences");

    const responseFormat = config.response_format as
      | { type?: string; json_schema?: { schema?: Record<string, unknown> } }
      | undefined;
    if (responseFormat?.type === "json_object") {
      config.responseMimeType ??= "application/json";
      delete config.response_format;
    } else if (responseFormat?.type === "json_schema") {
      config.responseMimeType ??= "application/json";
      config.responseJsonSchema ??= responseFormat.json_schema?.schema;
      delete config.response_format;
    }

    if (input.serialized.systemMessage) {
      config.systemInstruction = input.serialized.systemMessage;
    }

    if (input.tools && input.tools.length > 0) {
      config.tools = [{
        functionDeclarations: input.tools.map((tool) => ({
          name: tool.function.name,
          description: tool.function.description,
          parameters: tool.function.parameters,
        })),
      }];
    }

    return {
      model: input.model,
      contents: input.serialized.messages,
      config,
    };
  }

  // ---- Model (Assistant)消息 ----

  private async serializeModelMessage(
    msg: Message,
    includeThinking: boolean,
    thinkingMode: "none" | "native" | "message",
    thinkingPrefix: string
  ): Promise<unknown> {
    const parts: unknown[] = [];

    for (const part of msg.parts) {
      switch (part.type) {
        case "thinking":
          if (!includeThinking) break;
          if (thinkingMode === "native") {
            parts.push({
              text: part.text,
              thought: true,
              ...(msg.metadata.geminiThinkingSignature
                ? { thoughtSignature: msg.metadata.geminiThinkingSignature }
                : {}),
            });
          } else if (thinkingMode === "message") {
            parts.push({ text: `${thinkingPrefix}${part.text}` });
          }
          break;
        case "text":
          if (part.text) {
            parts.push({ text: part.text });
          }
          break;
        case "tool_call":
          parts.push({
            functionCall: {
              name: part.name,
              args: this.safeParseJson(part.arguments),
            },
            ...(part.metadata?.thoughtSignature
              ? { thoughtSignature: part.metadata.thoughtSignature }
              : {}),
          });
          break;
        default:
          break;
      }
    }

    return {
      role: "model",
      parts: parts.length > 0 ? parts : [{ text: "" }],
    };
  }

  // ---- User 消息 ----

  private async serializeUserMessage(msg: Message): Promise<unknown> {
    // 并行处理各 part 以加速多媒体解析
    const parts = (await Promise.all(
      msg.parts.map(async (part): Promise<unknown> => {
        switch (part.type) {
          case "text":
            return { text: part.text };
          case "image":
          case "audio":
            return await this.serializeInlineData(part);
          case "file":
            return await this.serializeFilePart(part);
          default:
            return null;
        }
      })
    )).filter((p) => p !== null);

    return {
      role: "user",
      parts: parts.length > 0 ? parts : [{ text: "" }],
    };
  }

  // ---- Tool 消息 → user role with functionResponse ----

  private serializeToolMessage(msg: Message): unknown {
    const toolResult = msg.parts.find((p) => p.type === "tool_result");
    if (!toolResult || toolResult.type !== "tool_result") {
      throw new Error("Tool message must contain a tool_result part");
    }

    return {
      role: "user",
      parts: [
        {
          functionResponse: {
            name: toolResult.name || msg.metadata.toolName || "unknown",
            response: this.safeParseJson(toolResult.result),
          },
        },
      ],
    };
  }

  // ---- 媒体序列化 ----

  private async serializeInlineData(
    part: ImagePart | AudioPart
  ): Promise<unknown> {
    if (part.url.startsWith("http://") || part.url.startsWith("https://")) {
      return {
        fileData: {
          mimeType: part.mimeType || this.guessMimeType(part.url),
          fileUri: part.url,
        },
      };
    }

    const resolved = await this.resolver.resolve(part.url);
    return {
      inlineData: {
        mimeType: part.mimeType || resolved.mimeType,
        data: resolved.base64,
      },
    };
  }

  private async serializeFilePart(part: FilePart): Promise<unknown> {
    if (part.url.startsWith("http://") || part.url.startsWith("https://")) {
      return {
        fileData: {
          mimeType: part.mimeType || this.guessMimeType(part.url),
          fileUri: part.url,
        },
      };
    }

    const resolved = await this.resolver.resolve(part.url);
    const mime = part.mimeType || resolved.mimeType;

    // 文本文件直接嵌入
    if (mime.startsWith("text/") || mime === "application/json") {
      const text = Buffer.from(resolved.base64, "base64").toString("utf-8");
      const label = part.fileName || "file";
      return { text: `[File: ${label}]\n${text}` };
    }

    return {
      inlineData: {
        mimeType: mime,
        data: resolved.base64,
      },
    };
  }

  // ========================
  //  Deserialize: Gemini Response → Message
  // ========================

  deserialize(raw: unknown): Message {
    const data = raw as Record<string, unknown>;

    // Gemini candidate 结构
    const content = (data.content || data) as Record<string, unknown>;
    const role = content.role as string;

    if (role === "model") {
      const parts: MessagePart[] = [];
      let thinkingSignature: unknown;
      const geminiParts = content.parts as Array<Record<string, unknown>> | undefined;

      if (Array.isArray(geminiParts)) {
        for (const gPart of geminiParts) {
          if (gPart.thought && gPart.text) {
            // 思考内容
            parts.push({ type: "thinking", text: gPart.text as string });
            thinkingSignature ??= gPart.thoughtSignature;
          } else if (gPart.text !== undefined) {
            // 普通文本
            if (gPart.text) {
              parts.push({ type: "text", text: gPart.text as string });
            }
          } else if (gPart.functionCall) {
            // 工具调用 —— Gemini 原生 functionCall 没有 id，生成唯一 id 避免批量冲突
            const fc = gPart.functionCall as Record<string, unknown>;
            parts.push({
              type: "tool_call",
              toolCallId: generateId(fc.name as string),
              name: fc.name as string,
              arguments: JSON.stringify(fc.args || {}),
              ...(gPart.thoughtSignature
                ? { metadata: { thoughtSignature: gPart.thoughtSignature } }
                : {}),
            });
          }
        }
      }

      const message = new Message(Role.Assistant, parts);
      if (thinkingSignature) {
        message.setMeta("geminiThinkingSignature", thinkingSignature);
      }
      return message;
    }

    // 其他角色
    const geminiParts = (content.parts as Array<Record<string, unknown>>) || [];
    const text = geminiParts
      .filter((p) => p.text !== undefined)
      .map((p) => p.text as string)
      .join("");

    return new Message(Role.User, [{ type: "text", text }]);
  }

  /**
   * 从完整的 Gemini API 响应解析
   */
  deserializeResponse(raw: unknown): Message {
    const data = raw as Record<string, unknown>;

    // Gemini 响应结构: { candidates: [{ content: { ... } }], usageMetadata: { ... } }
    const candidates = data.candidates as Array<Record<string, unknown>> | undefined;
    const candidate = candidates?.[0];
    if (!candidate) {
      throw new Error("Gemini API 响应中没有 candidates");
    }

    const message = this.deserialize(candidate);

    if (data.modelVersion) {
      message.model = data.modelVersion as string;
    }

    if (data.usageMetadata) {
      const usage = data.usageMetadata as Record<string, number>;
      message.usage = new Usage(
        usage.promptTokenCount || 0,
        usage.candidatesTokenCount || usage.totalTokenCount || 0,
        usage.totalTokenCount || 0
      );
    }

    return message;
  }

  getFinishReason(raw: unknown): string | undefined {
    const data = raw as Record<string, unknown>;
    const candidates = data.candidates as Array<Record<string, unknown>> | undefined;
    const reason = candidates?.[0]?.finishReason as string | undefined;
    switch (reason) {
      case "MAX_TOKENS":
        return "length";
      case "STOP":
        return "stop";
      case "SAFETY":
      case "RECITATION":
        return "content_filter";
      default:
        return reason?.toLowerCase();
    }
  }

  // ========================
  //  辅助
  // ========================

  /**
   * 合并连续同角色消息
   *
   * Gemini 要求 user/model 交替出现
   */
  private mergeConsecutiveRoles(messages: unknown[]): unknown[] {
    if (messages.length === 0) return messages;

    interface SerializedMessage {
      role: string;
      parts: unknown[];
    }

    const merged: SerializedMessage[] = [];
    for (const raw of messages) {
      const msg = raw as SerializedMessage;
      const last = merged[merged.length - 1];
      if (last && last.role === msg.role) {
        // 合并 parts 数组
        last.parts = [...(last.parts || []), ...(msg.parts || [])];
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

  private guessMimeType(url: string): string {
    const ext = url.split(".").pop()?.toLowerCase() || "";
    const map: Record<string, string> = {
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      gif: "image/gif",
      webp: "image/webp",
      svg: "image/svg+xml",
      mp3: "audio/mpeg",
      wav: "audio/wav",
      ogg: "audio/ogg",
      mp4: "video/mp4",
      pdf: "application/pdf",
    };
    return map[ext] || "application/octet-stream";
  }
}
