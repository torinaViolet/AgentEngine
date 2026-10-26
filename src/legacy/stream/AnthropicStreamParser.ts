import { Message } from "../message/Message";
import { MessageStreamParser } from "./MessageStreamParser";
import { FinishReason, StreamEvent, StreamEventType } from "./StreamEvent";
import { StreamParser } from "./StreamParser";

/** Parses Anthropic Messages stream events into unified stream events. */
export class AnthropicStreamParser implements MessageStreamParser {
  private readonly parser = new StreamParser();
  private inputTokens = 0;
  private outputTokens = 0;
  private thinkingSignature = "";

  feed(chunk: unknown): StreamEvent[] {
    try {
      const event = chunk as any;

      switch (event?.type) {
        case "message_start":
          this.updateUsage(event.message?.usage);
          return this.feedUsage();
        case "content_block_start":
          return this.feedContentBlockStart(event.index ?? 0, event.content_block);
        case "content_block_delta":
          return this.feedContentBlockDelta(event.index ?? 0, event.delta);
        case "message_delta": {
          this.updateUsage(event.usage);
          return this.parser.feed({
            usage: this.rawUsage(),
            choices: [{
              delta: {},
              finish_reason: this.normalizeFinishReason(event.delta?.stop_reason),
            }],
          });
        }
        case "error":
          return [{
            type: StreamEventType.ERROR,
            error: this.toError(event.error ?? event),
          }];
        default:
          return [];
      }
    } catch (error) {
      return [{ type: StreamEventType.ERROR, error: this.toError(error) }];
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
    this.inputTokens = 0;
    this.outputTokens = 0;
    this.thinkingSignature = "";
  }

  private feedContentBlockStart(index: number, block: any): StreamEvent[] {
    if (block?.type === "text" && block.text) {
      return this.parser.feed({ choices: [{ delta: { content: block.text } }] });
    }

    if (block?.type === "thinking") {
      if (block.signature) this.thinkingSignature += block.signature;
      return block.thinking
        ? this.parser.feed({ choices: [{ delta: { thinking: block.thinking } }] })
        : [];
    }

    if (block?.type === "tool_use") {
      const input = block.input && Object.keys(block.input).length > 0
        ? JSON.stringify(block.input)
        : "";
      return this.parser.feed({
        choices: [{
          delta: {
            tool_calls: [{
              index,
              id: block.id,
              function: { name: block.name, arguments: input },
            }],
          },
        }],
      });
    }

    return [];
  }

  private feedContentBlockDelta(index: number, delta: any): StreamEvent[] {
    if (delta?.type === "text_delta") {
      return this.parser.feed({ choices: [{ delta: { content: delta.text ?? "" } }] });
    }

    if (delta?.type === "thinking_delta") {
      return this.parser.feed({ choices: [{ delta: { thinking: delta.thinking ?? "" } }] });
    }

    if (delta?.type === "signature_delta") {
      this.thinkingSignature += delta.signature ?? "";
      return [];
    }

    if (delta?.type === "input_json_delta") {
      return this.parser.feed({
        choices: [{
          delta: {
            tool_calls: [{
              index,
              function: { arguments: delta.partial_json ?? "" },
            }],
          },
        }],
      });
    }

    return [];
  }

  private updateUsage(usage: any): void {
    if (!usage) return;
    if (typeof usage.input_tokens === "number") this.inputTokens = usage.input_tokens;
    if (typeof usage.output_tokens === "number") this.outputTokens = usage.output_tokens;
  }

  private feedUsage(): StreamEvent[] {
    return this.parser.feed({ usage: this.rawUsage(), choices: [] });
  }

  private rawUsage(): Record<string, number> {
    return {
      prompt_tokens: this.inputTokens,
      completion_tokens: this.outputTokens,
      total_tokens: this.inputTokens + this.outputTokens,
    };
  }

  private normalizeFinishReason(reason: unknown): FinishReason | undefined {
    switch (reason) {
      case "end_turn":
      case "stop_sequence":
        return "stop";
      case "max_tokens":
        return "length";
      case "tool_use":
        return "tool_calls";
      case null:
      case undefined:
        return undefined;
      default:
        return String(reason);
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
      message.setMeta("thinkingSignature", this.thinkingSignature);
    }
    return message;
  }

  private toError(error: unknown): Error {
    if (error instanceof Error) return error;
    if (typeof (error as any)?.message === "string") {
      return new Error((error as any).message);
    }
    return new Error(String(error));
  }
}
