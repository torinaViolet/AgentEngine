import { Message } from "../message/Message";
import { Role } from "../message/Role";
import { MessagePart } from "../message/MessagePart";
import {
  StreamEvent,
  StreamEventType,
} from "./StreamEvent";

/** 内部工具调用累积器 */
interface ToolCallAccumulator {
  id: string;
  name: string;
  argsBuffer: string;
  started: boolean;
}

/**
 * 流式解析器
 *
 * 将 OpenAI 流式 API 返回的一个个chunk 解析为结构化事件，
 * 并最终组装成完整的 Message 对象。
 *
 * StreamParser 是纯粹的、无副作用的，不依赖 Session 或ToolKit。
 *
 * 用法:
 *const parser = new StreamParser();
 *   for await (const chunk of stream) {
 *     const events = parser.feed(chunk);
 *     for (const event of events) { ... }
 *   }
 *const finalEvents = parser.finish();
 */
export class StreamParser {
  private _thinkingBuffer: string = "";
  private _textBuffer: string = "";
  private _toolCalls: Map<number, ToolCallAccumulator> = new Map();
  private _finished: boolean = false;

  //========================
  //喂入Chunk
  // ========================

  /**
   * 喂入一个 OpenAI stream chunk，返回本次产出的事件
   */
  feed(chunk: any): StreamEvent[] {
    const events: StreamEvent[] = [];

    try {
      const choices = chunk.choices;
      if (!choices || choices.length === 0) return events;

      const choice = choices[0];
      const delta = choice.delta;
      if (!delta) return events;

      // ---- 思考/推理增量 ----
      //兼容多种字段名：reasoning_content (DeepSeek/Qwen), thinking (Claude)
      const thinkingDelta =
        delta.reasoning_content ?? delta.thinking ?? null;

      if (thinkingDelta) {
        this._thinkingBuffer += thinkingDelta;
        events.push({
          type: StreamEventType.THINKING_DELTA,
          delta: thinkingDelta,
          snapshot: this._thinkingBuffer,
        });
      }

      // ---- 文本增量 ----
      if (delta.content) {
        this._textBuffer += delta.content;
        events.push({
          type: StreamEventType.TEXT_DELTA,
          delta: delta.content,
          snapshot: this._textBuffer,
        });
      }

      // ---- 工具调用增量 ----
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const index: number = tc.index ?? 0;

          if (!this._toolCalls.has(index)) {
            // 新的工具调用
            this._toolCalls.set(index, {
              id: tc.id || "",
              name: tc.function?.name || "",
              argsBuffer: tc.function?.arguments || "",
              started: false,
            });
          } else {
            // 累积
            const acc = this._toolCalls.get(index)!;
            if (tc.id) acc.id = tc.id;
            if (tc.function?.name) acc.name = tc.function.name;
            if (tc.function?.arguments) {
              acc.argsBuffer += tc.function.arguments;
            }
          }

          const acc = this._toolCalls.get(index)!;

          // 首次拿到 id + name时触发 START
          if (!acc.started && acc.id && acc.name) {
            acc.started = true;
            events.push({
              type: StreamEventType.TOOL_CALL_START,
              index,
              toolCallId: acc.id,
              name: acc.name,
            });
          }

          // 参数增量
          if (tc.function?.arguments) {
            events.push({
              type: StreamEventType.TOOL_CALL_DELTA,
              index,
              argsDelta: tc.function.arguments,
              argsSnapshot: acc.argsBuffer,
            });
          }
        }
      }
    } catch (e) {
      events.push({
        type: StreamEventType.ERROR,
        error: e instanceof Error ? e : new Error(String(e)),
      });
    }

    return events;
  }

  // ========================
  //  结束
  // ========================

  /**
   * 通知流结束，产出最终事件（TEXT_DONE、TOOL_CALL_DONE、MESSAGE_DONE）
   */
  finish(): StreamEvent[] {
    if (this._finished) return [];
this._finished = true;

    const events: StreamEvent[] = [];

    // THINKING_DONE
    if (this._thinkingBuffer.length > 0) {
      events.push({
        type: StreamEventType.THINKING_DONE,
        thinking: this._thinkingBuffer,
      });
    }

    // TEXT_DONE
    if (this._textBuffer.length > 0) {
      events.push({
        type: StreamEventType.TEXT_DONE,
        text: this._textBuffer,
      });
    }

    // TOOL_CALL_DONE
    for (const [index, acc] of this._toolCalls) {
      events.push({
        type: StreamEventType.TOOL_CALL_DONE,
        index,
        toolCallId: acc.id,
        name: acc.name,
        arguments: acc.argsBuffer,
      });
    }

    // MESSAGE_DONE
    const message = this.buildMessage();
    events.push({
      type: StreamEventType.MESSAGE_DONE,
      message,
    });

    return events;
  }

  // ========================
  //  快照
  // ========================

  /**
   * 获取当前已组装的 Message 快照（随时可用）
   */
  get snapshot(): Message {
    return this.buildMessage();
  }

  // ========================
  //  重置
  // ========================

  /**
   * 重置解析器状态，可复用于下一轮
   */
  reset(): void {
    this._thinkingBuffer = "";
    this._textBuffer = "";
    this._toolCalls.clear();
    this._finished = false;
  }

  // ========================
  //  内部
  // ========================

  private buildMessage(): Message {
    const parts: MessagePart[] = [];

    // 思考
    if (this._thinkingBuffer.length > 0) {
      parts.push({ type: "thinking", text: this._thinkingBuffer });
    }

    // 文本
    if (this._textBuffer.length > 0) {
      parts.push({ type: "text", text: this._textBuffer });
    }

    // 工具调用
    for (const [, acc] of this._toolCalls) {
      parts.push({
        type: "tool_call",
        toolCallId: acc.id,
        name: acc.name,
        arguments: acc.argsBuffer,
      });
    }

    return new Message(Role.Assistant, parts);
  }
}