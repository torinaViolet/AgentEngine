import { BrowserMediaResolver } from "../media/BrowserMediaResolver";
import { MediaResolver } from "../media/MediaResolver";
import { Message } from "../message/Message";
import { AudioPart, FilePart, ImagePart, MessagePart } from "../message/MessagePart";
import { Role } from "../message/Role";
import { Usage } from "../message/Usage";
import {
  BuildModelRequestInput,
  MessageAdapter,
  SerializedResult,
  SerializeOptions,
  normalizeThinkingOptions,
  shouldSerializeThinking,
} from "./MessageAdapter";

/** Message and request adapter for the OpenAI Responses API. */
export class OpenAIResponsesAdapter implements MessageAdapter {
  readonly capabilities = {
    nativeThinking: true,
    messageThinking: true,
  };

  private readonly resolver: MediaResolver;

  constructor(resolver?: MediaResolver) {
    this.resolver = resolver ?? new BrowserMediaResolver();
  }

  async serialize(
    messages: Message[],
    options?: SerializeOptions
  ): Promise<SerializedResult> {
    const thinkingOptions = normalizeThinkingOptions(options, this.capabilities);
    const input: unknown[] = [];

    for (let index = 0; index < messages.length; index++) {
      const message = messages[index];
      const includeThinking = shouldSerializeThinking(
        message,
        index,
        messages,
        thinkingOptions
      );

      if (message.role === Role.Tool) {
        for (const part of message.parts) {
          if (part.type === "tool_result") {
            input.push({
              type: "function_call_output",
              call_id: part.toolCallId,
              output: part.result,
            });
          }
        }
        continue;
      }

      if (message.role === Role.Assistant) {
        const reasoningItems = message.metadata.openaiReasoningItems;
        if (
          Array.isArray(reasoningItems) &&
          (message.toolCalls.length > 0 || (includeThinking && thinkingOptions.mode === "native"))
        ) {
          input.push(...reasoningItems);
        }

        const textParts: MessagePart[] = [];
        if (includeThinking && thinkingOptions.mode === "message" && message.thinking) {
          textParts.push({
            type: "text",
            text: `${thinkingOptions.messagePrefix}${message.thinking}`,
          });
        }
        textParts.push(...message.parts.filter((part) => part.type === "text"));

        const text = textParts
          .filter((part): part is Extract<MessagePart, { type: "text" }> => part.type === "text")
          .map((part) => part.text)
          .join("");
        if (text) {
          input.push({ role: "assistant", content: text });
        }

        for (const toolCall of message.toolCalls) {
          const item = toolCall.metadata?.rawItem ?? {
              type: "function_call",
              call_id: toolCall.toolCallId,
              name: toolCall.name,
              arguments: toolCall.arguments,
              ...(toolCall.metadata?.itemId
                ? { id: toolCall.metadata.itemId }
                : {}),
            };
          input.push(item);
        }
        continue;
      }

      input.push(await this.serializeInputMessage(message));
    }

    return { messages: input };
  }

  buildRequest(input: BuildModelRequestInput): Record<string, unknown> {
    const options = { ...input.options };

    if (options.max_tokens !== undefined && options.max_output_tokens === undefined) {
      options.max_output_tokens = options.max_tokens;
    }
    delete options.max_tokens;
    delete options.stop;
    delete options.top_k;
    delete options.seed;

    const responseFormat = options.response_format as
      | {
        type?: string;
        json_schema?: {
          name?: string;
          schema?: Record<string, unknown>;
          strict?: boolean;
        };
      }
      | undefined;
    if (responseFormat) {
      const format = responseFormat.type === "json_schema"
        ? {
          type: "json_schema",
          name: responseFormat.json_schema?.name,
          schema: responseFormat.json_schema?.schema,
          ...(responseFormat.json_schema?.strict !== undefined
            ? { strict: responseFormat.json_schema.strict }
            : {}),
        }
        : { type: responseFormat.type };
      const currentText = (options.text as Record<string, unknown> | undefined) ?? {};
      options.text = { ...currentText, format };
      delete options.response_format;
    }

    if (options.store === false) {
      const include = Array.isArray(options.include) ? [...options.include] : [];
      if (!include.includes("reasoning.encrypted_content")) {
        include.push("reasoning.encrypted_content");
      }
      options.include = include;
    }

    const request: Record<string, unknown> = {
      model: input.model,
      input: input.serialized.messages,
      ...options,
      stream: input.stream ?? true,
    };

    if (input.tools && input.tools.length > 0) {
      request.tools = input.tools.map((tool) => ({
        type: "function",
        name: tool.function.name,
        description: tool.function.description,
        parameters: tool.function.parameters,
      }));
    }

    return request;
  }

  deserialize(raw: unknown): Message {
    const data = raw as any;
    const output = Array.isArray(data?.output) ? data.output : [data];
    const parts: MessagePart[] = [];
    const reasoningItems: unknown[] = [];

    for (const item of output) {
      if (item?.type === "message") {
        for (const content of item.content ?? []) {
          if (content?.type === "output_text" && content.text) {
            parts.push({ type: "text", text: content.text });
          }
        }
      } else if (item?.type === "function_call") {
        parts.push({
          type: "tool_call",
          toolCallId: item.call_id,
          name: item.name,
          arguments: item.arguments ?? "",
          ...(item.id ? { metadata: { itemId: item.id } } : {}),
        });
      } else if (item?.type === "reasoning") {
        reasoningItems.push(item);
        const summary = (item.summary ?? [])
          .filter((part: any) => part?.type === "summary_text")
          .map((part: any) => part.text ?? "")
          .join("");
        if (summary) parts.push({ type: "thinking", text: summary });
      }
    }

    const message = new Message(Role.Assistant, parts);
    if (data?.model) message.model = data.model;
    if (data?.usage) {
      message.usage = Usage.fromRaw({
        prompt_tokens: data.usage.input_tokens,
        completion_tokens: data.usage.output_tokens,
        total_tokens: data.usage.total_tokens,
      });
    }
    if (reasoningItems.length > 0) {
      message.setMeta("openaiReasoningItems", reasoningItems);
    }
    return message;
  }

  deserializeResponse(raw: unknown): Message {
    return this.deserialize(raw);
  }

  getFinishReason(raw: unknown): string | undefined {
    const data = raw as any;
    if (data?.status === "incomplete") {
      return data?.incomplete_details?.reason === "max_output_tokens"
        ? "length"
        : "incomplete";
    }
    if (Array.isArray(data?.output) && data.output.some((item: any) => item?.type === "function_call")) {
      return "tool_calls";
    }
    return data?.status === "failed" ? "failed" : "stop";
  }

  private async serializeInputMessage(message: Message): Promise<unknown> {
    if (!message.hasMedia) {
      return { role: message.role, content: message.text };
    }

    const content = (await Promise.all(message.parts.map(async (part) => {
      switch (part.type) {
        case "text":
          return { type: "input_text", text: part.text };
        case "image":
          return this.serializeImage(part);
        case "audio":
          return this.serializeAudio(part);
        case "file":
          return this.serializeFile(part);
        default:
          return null;
      }
    }))).filter((part) => part !== null);

    return { role: message.role, content };
  }

  private async serializeImage(part: ImagePart): Promise<unknown> {
    const imageUrl = await this.resolveDataUrl(part.url, part.mimeType);
    return { type: "input_image", image_url: imageUrl };
  }

  private async serializeAudio(part: AudioPart): Promise<unknown> {
    throw new Error(
      `OpenAI Responses Adapter does not support audio inputs yet: ${part.url}`
    );
  }

  private async serializeFile(part: FilePart): Promise<unknown> {
    const resolved = await this.resolver.resolve(part.url);
    const mimeType = part.mimeType ?? resolved.mimeType;
    return {
      type: "input_file",
      filename: part.fileName ?? "file",
      file_data: `data:${mimeType};base64,${resolved.base64}`,
    };
  }

  private async resolveDataUrl(url: string, mimeType?: string): Promise<string> {
    if (url.startsWith("http://") || url.startsWith("https://") || url.startsWith("data:")) {
      return url;
    }
    const resolved = await this.resolver.resolve(url);
    return `data:${mimeType ?? resolved.mimeType};base64,${resolved.base64}`;
  }
}
