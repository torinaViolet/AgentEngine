import { generateId } from "../utils";
import { Message } from "../message/Message";
import { MessageStreamParser } from "./MessageStreamParser";
import { FinishReason, StreamEvent, StreamEventType } from "./StreamEvent";
import { StreamParser } from "./StreamParser";

/** Parses Gemini generateContentStream chunks into unified stream events. */
export class GeminiStreamParser implements MessageStreamParser {
  private readonly parser = new StreamParser();
  private nextToolIndex = 0;
  private readonly toolSignatures = new Map<string, unknown>();
  private thinkingSignature?: unknown;

  feed(chunk: unknown): StreamEvent[] {
    try {
      const data = chunk as any;
      const candidate = data?.candidates?.[0];
      const events: StreamEvent[] = [];

      if (data?.usageMetadata) {
        events.push(...this.parser.feed({
          usage: this.rawUsage(data.usageMetadata),
          choices: [],
        }));
      }

      const parts = candidate?.content?.parts ?? [];
      for (let index = 0; index < parts.length; index++) {
        const part = parts[index];
        if (typeof part?.text === "string") {
          if (part.thought && part.thoughtSignature) {
            this.thinkingSignature = part.thoughtSignature;
          }
          const delta = part.thought
            ? { thinking: part.text }
            : { content: part.text };
          events.push(...this.parser.feed({ choices: [{ delta }] }));
        }

        if (part?.functionCall) {
          const toolIndex = this.nextToolIndex++;
          const callId = part.functionCall.id ?? generateId("gemini_call");
          if (part.thoughtSignature) {
            this.toolSignatures.set(callId, part.thoughtSignature);
          }
          events.push(...this.parser.feed({
            choices: [{
              delta: {
                tool_calls: [{
                  index: toolIndex,
                  id: callId,
                  function: {
                    name: part.functionCall.name,
                    arguments: JSON.stringify(part.functionCall.args ?? {}),
                  },
                }],
              },
            }],
          }));
        }
      }

      if (candidate?.finishReason) {
        events.push(...this.parser.feed({
          choices: [{
            delta: {},
            finish_reason: this.normalizeFinishReason(candidate.finishReason),
          }],
        }));
      }

      return events;
    } catch (error) {
      return [{
        type: StreamEventType.ERROR,
        error: error instanceof Error ? error : new Error(String(error)),
      }];
    }
  }

  finish(): StreamEvent[] {
    return this.decorate(this.parser.finish());
  }

  get snapshot(): Message {
    return this.decorateMessage(this.parser.snapshot);
  }

  get finishReason(): FinishReason | undefined {
    return this.parser.finishReason;
  }

  get hasSnapshotContent(): boolean {
    return this.parser.hasSnapshotContent;
  }

  reset(): void {
    this.parser.reset();
    this.nextToolIndex = 0;
    this.toolSignatures.clear();
    this.thinkingSignature = undefined;
  }

  private rawUsage(usage: any): Record<string, number> {
    const promptTokens = usage.promptTokenCount ?? 0;
    const completionTokens = usage.candidatesTokenCount ?? 0;
    return {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: usage.totalTokenCount ?? promptTokens + completionTokens,
    };
  }

  private normalizeFinishReason(reason: unknown): FinishReason {
    switch (String(reason).toUpperCase()) {
      case "STOP":
        return "stop";
      case "MAX_TOKENS":
        return "length";
      case "SAFETY":
      case "RECITATION":
      case "BLOCKLIST":
      case "PROHIBITED_CONTENT":
        return "content_filter";
      case "MALFORMED_FUNCTION_CALL":
        return "function_call";
      default:
        return String(reason).toLowerCase();
    }
  }

  private decorate(events: StreamEvent[]): StreamEvent[] {
    for (const event of events) {
      if (event.type === StreamEventType.MESSAGE_DONE) {
        this.decorateMessage(event.message);
      }
    }
    return events;
  }

  private decorateMessage(message: Message): Message {
    if (this.thinkingSignature) {
      message.setMeta("geminiThinkingSignature", this.thinkingSignature);
    }
    for (const toolCall of message.toolCalls) {
      const signature = this.toolSignatures.get(toolCall.toolCallId);
      if (signature) {
        toolCall.metadata = {
          ...toolCall.metadata,
          thoughtSignature: signature,
        };
      }
    }
    return message;
  }
}
