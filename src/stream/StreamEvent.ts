import { Message } from "../message/Message";

/**
 * 流式事件类型枚举
 */
export enum StreamEventType {
  /** 思考/推理增量到达 */
  THINKING_DELTA = "thinking_delta",
  /** 思考/推理流结束 */
  THINKING_DONE = "thinking_done",
  /** 文本增量到达 */
  TEXT_DELTA = "text_delta",
  /** 文本流结束 */
  TEXT_DONE = "text_done",
  /** 工具调用开始（拿到 id + name） */
  TOOL_CALL_START = "tool_call_start",
  /** 工具参数增量 */
  TOOL_CALL_DELTA = "tool_call_delta",
  /** 单个工具调用完成（完整参数就绪） */
  TOOL_CALL_DONE = "tool_call_done",
  /** 工具开始执行 */
  TOOL_EXECUTE_START = "tool_execute_start",
  /** 工具执行完成 */
  TOOL_EXECUTE_DONE = "tool_execute_done",
  /** 整条消息组装完毕 */
  MESSAGE_DONE = "message_done",
  /** 新一轮循环开始 */
  TURN_START = "turn_start",
  /** 一轮循环结束 */
  TURN_END = "turn_end",
  /** 错误 */
  ERROR = "error",
}

//========================
//  各事件数据结构
// ========================

export interface ThinkingDeltaEvent {
  type: StreamEventType.THINKING_DELTA;
  /** 本次思考增量 */
  delta: string;
  /** 截至目前的完整思考文本 */
  snapshot: string;
}

export interface ThinkingDoneEvent {
  type: StreamEventType.THINKING_DONE;
  /** 最终完整思考文本 */
  thinking: string;
}

export interface TextDeltaEvent {
  type: StreamEventType.TEXT_DELTA;
  /** 本次增量文本 */
  delta: string;
  /** 截至目前的完整文本 */
  snapshot: string;
}

export interface TextDoneEvent {
  type: StreamEventType.TEXT_DONE;
  /** 最终完整文本 */
  text: string;
}

export interface ToolCallStartEvent {
  type: StreamEventType.TOOL_CALL_START;
  /** 工具调用在 tool_calls 数组中的索引 */
  index: number;
  /** tool_call_id */
  toolCallId: string;
  /**工具名*/
  name: string;
}

export interface ToolCallDeltaEvent {
  type: StreamEventType.TOOL_CALL_DELTA;
  index: number;
  /** 本次参数增量 */
  argsDelta: string;
  /** 截至目前的完整参数 JSON */
  argsSnapshot: string;
}

export interface ToolCallDoneEvent {
  type: StreamEventType.TOOL_CALL_DONE;
  index: number;
  toolCallId: string;
  name: string;
  /** 完整的参数 JSON string */
  arguments: string;
}

export interface ToolExecuteStartEvent {
  type: StreamEventType.TOOL_EXECUTE_START;
  toolCallId: string;
  name: string;
}

export interface ToolExecuteDoneEvent {
  type: StreamEventType.TOOL_EXECUTE_DONE;
  toolCallId: string;
  name: string;
  /** 工具执行结果 Message */
  result: Message;
}

export interface MessageDoneEvent {
  type: StreamEventType.MESSAGE_DONE;
  /** 组装完成的 Message */
  message: Message;
}

export interface TurnStartEvent {
  type: StreamEventType.TURN_START;
  /** 当前轮次（0-based） */
  turn: number;
}

export interface TurnEndEvent {
  type: StreamEventType.TURN_END;
  /** 当前轮次 */
  turn: number;
  /** 本轮是否有工具调用 */
  hasToolCalls: boolean;
}

export interface ErrorEvent {
  type: StreamEventType.ERROR;
  error: Error;
}

/**
 * 流式事件联合类型
 */
export type StreamEvent =
  | ThinkingDeltaEvent
  | ThinkingDoneEvent
  | TextDeltaEvent
  | TextDoneEvent
  | ToolCallStartEvent
  | ToolCallDeltaEvent
  | ToolCallDoneEvent
  | ToolExecuteStartEvent
  | ToolExecuteDoneEvent
  | MessageDoneEvent
  | TurnStartEvent
  | TurnEndEvent
  | ErrorEvent;

/**
 * 事件类型 → 事件数据结构的映射
 *
 * 用于 Agent.on() 的泛型推断，使注册特定事件时
 * handler 参数自动推断为对应的事件类型。
 *
 * 例如：
 *agent.on(StreamEventType.TEXT_DELTA, (e) => e.delta)
 *   // e自动推断为 TextDeltaEvent，可直接访问 .delta
 */
export interface StreamEventMap {
  [StreamEventType.THINKING_DELTA]: ThinkingDeltaEvent;
  [StreamEventType.THINKING_DONE]: ThinkingDoneEvent;
  [StreamEventType.TEXT_DELTA]: TextDeltaEvent;
  [StreamEventType.TEXT_DONE]: TextDoneEvent;
  [StreamEventType.TOOL_CALL_START]: ToolCallStartEvent;
  [StreamEventType.TOOL_CALL_DELTA]: ToolCallDeltaEvent;
  [StreamEventType.TOOL_CALL_DONE]: ToolCallDoneEvent;
  [StreamEventType.TOOL_EXECUTE_START]: ToolExecuteStartEvent;
  [StreamEventType.TOOL_EXECUTE_DONE]: ToolExecuteDoneEvent;
  [StreamEventType.MESSAGE_DONE]: MessageDoneEvent;
  [StreamEventType.TURN_START]: TurnStartEvent;
  [StreamEventType.TURN_END]: TurnEndEvent;
  [StreamEventType.ERROR]: ErrorEvent;
}