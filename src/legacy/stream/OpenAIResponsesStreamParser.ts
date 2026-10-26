import { Message } from "../message/Message";
import { FinishReason, StreamEvent, StreamEventType } from "./StreamEvent";
import { MessageStreamParser } from "./MessageStreamParser";
import { StreamParser } from "./StreamParser";

interface FunctionCallState {
  index: number;
  callId: string;
  itemId?: string;
  name: string;
  arguments: string;
  done: boolean;
  rawItem?: unknown;
}

/** Parses OpenAI Responses API semantic stream events. */
export class OpenAIResponsesStreamParser implements MessageStreamParser {
  private readonly parser = new StreamParser();
  private readonly calls = new Map<string, FunctionCallState>();
  private readonly reasoningItems: unknown[] = [];
  private nextCallIndex = 0;

  feed(chunk: unknown): StreamEvent[] {
    try {
      const event = chunk as any;

      switch (event?.type) {
        case "response.output_text.delta":
        case "response.refusal.delta":
          return this.parser.feed({
            choices: [{ delta: { content: event.delta ?? "" } }],
          });

        case "response.reasoning_summary_text.delta":
        case "response.reasoning_text.delta":
          return this.parser.feed({
            choices: [{ delta: { thinking: event.delta ?? "" } }],
          });

        case "response.output_item.added":
          return this.handleOutputItem(event.item, event.output_index);

        case "response.function_call_arguments.delta":
          return this.handleFunctionArgumentsDelta(event);

        case "response.function_call_arguments.done":
          return this.handleFunctionArgumentsDone(event);

        case "response.output_item.done":
          return this.handleOutputItemDone(event.item, event.output_index);

        case "response.completed":
          return this.handleCompleted(event.response);

        case "response.incomplete":
          return this.handleIncomplete(event.response);

        case "response.failed":
          return [{
            type: StreamEventType.ERROR,
            error: this.toError(event.response?.error ?? event),
          }];

        case "error":
          return [{
            type: StreamEventType.ERROR,
            error: this.toError(event.error ?? event),
          }];

        default:
          return [];
      }
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
    this.calls.clear();
    this.reasoningItems.length = 0;
    this.nextCallIndex = 0;
  }

  private handleOutputItem(item: any, outputIndex?: number): StreamEvent[] {
    if (item?.type !== "function_call") return [];
    const state = this.ensureCall(item, outputIndex);
    return this.parser.feed({
      choices: [{
        delta: {
          tool_calls: [{
            index: state.index,
            id: state.callId,
            function: { name: state.name, arguments: "" },
          }],
        },
      }],
    });
  }

  private handleFunctionArgumentsDelta(event: any): StreamEvent[] {
    const state = this.ensureCall({
      id: event.item_id,
      call_id: event.call_id,
      name: event.name,
    }, event.output_index);
    const delta = event.delta ?? "";
    state.arguments += delta;
    return this.parser.feed({
      choices: [{
        delta: {
          tool_calls: [{
            index: state.index,
            id: state.callId,
            function: {
              ...(state.name ? { name: state.name } : {}),
              arguments: delta,
            },
          }],
        },
      }],
    });
  }

  private handleFunctionArgumentsDone(event: any): StreamEvent[] {
    const state = this.ensureCall({
      id: event.item_id,
      call_id: event.call_id,
      name: event.name,
    }, event.output_index);
    if (!state.arguments && event.arguments) {
      state.arguments = event.arguments;
      return this.parser.feed({
        choices: [{
          delta: {
            tool_calls: [{
              index: state.index,
              id: state.callId,
              function: {
                ...(state.name ? { name: state.name } : {}),
                arguments: event.arguments,
              },
            }],
          },
        }],
      });
    }
    return [];
  }

  private handleOutputItemDone(item: any, outputIndex?: number): StreamEvent[] {
    if (item?.type === "reasoning") {
      this.addReasoningItem(item);
      return [];
    }
    if (item?.type !== "function_call") return [];

    const state = this.ensureCall(item, outputIndex);
    state.done = true;
    state.rawItem = item;
    const events = this.handleFunctionArgumentsDone({
      item_id: item.id,
      call_id: item.call_id,
      name: item.name,
      arguments: item.arguments,
      output_index: outputIndex,
    });
    return events;
  }

  private handleCompleted(response: any): StreamEvent[] {
    this.captureReasoningItems(response?.output);
    return this.parser.feed({
      usage: this.rawUsage(response?.usage),
      choices: [{
        delta: {},
        finish_reason: this.calls.size > 0 ? "tool_calls" : "stop",
      }],
    });
  }

  private handleIncomplete(response: any): StreamEvent[] {
    this.captureReasoningItems(response?.output);
    const reason = response?.incomplete_details?.reason;
    return this.parser.feed({
      usage: this.rawUsage(response?.usage),
      choices: [{
        delta: {},
        finish_reason: reason === "max_output_tokens" ? "length" : String(reason ?? "incomplete"),
      }],
    });
  }

  private ensureCall(item: any, outputIndex?: number): FunctionCallState {
    const key = item?.id ?? item?.call_id ?? `output_${outputIndex ?? this.nextCallIndex}`;
    let state = this.calls.get(key);
    if (!state) {
      state = {
        index: this.nextCallIndex++,
        callId: item?.call_id ?? item?.id ?? key,
        itemId: item?.id,
        name: item?.name ?? "",
        arguments: "",
        done: false,
      };
      this.calls.set(key, state);
    } else {
      if (item?.call_id) state.callId = item.call_id;
      if (item?.id) state.itemId = item.id;
      if (item?.name) state.name = item.name;
    }
    return state;
  }

  private rawUsage(usage: any): Record<string, number> | undefined {
    if (!usage) return undefined;
    const promptTokens = usage.input_tokens ?? 0;
    const completionTokens = usage.output_tokens ?? 0;
    return {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: usage.total_tokens ?? promptTokens + completionTokens,
    };
  }

  private captureReasoningItems(output: unknown): void {
    if (!Array.isArray(output)) return;
    for (const item of output) {
      if ((item as any)?.type === "reasoning") {
        this.addReasoningItem(item);
      } else if ((item as any)?.type === "function_call") {
        const state = this.ensureCall(item, (item as any).output_index);
        state.rawItem = item;
      }
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

  private addReasoningItem(item: unknown): void {
    const id = (item as any)?.id;
    if (id && this.reasoningItems.some((current) => (current as any)?.id === id)) {
      return;
    }
    if (!id && this.reasoningItems.includes(item)) return;
    this.reasoningItems.push(item);
  }

  private decorateMessage(message: Message): Message {
    if (this.reasoningItems.length > 0) {
      message.setMeta("openaiReasoningItems", [...this.reasoningItems]);
    }
    for (const toolCall of message.toolCalls) {
      const state = Array.from(this.calls.values())
        .find((candidate) => candidate.callId === toolCall.toolCallId);
      if (state?.itemId) {
        toolCall.metadata = {
          ...toolCall.metadata,
          itemId: state.itemId,
          ...(state.rawItem ? { rawItem: state.rawItem } : {}),
        };
      }
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
