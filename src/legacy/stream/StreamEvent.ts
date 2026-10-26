import { Message } from "../message/Message";

/** 模型流式完成原因（兼容 OpenAI finish_reason，并允许扩展字符串） */
export type FinishReason =
  | "stop"
  | "length"
  | "tool_calls"
  | "content_filter"
  | "function_call"
  | string;

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
  /** 工具调用需要审批 */
  TOOL_APPROVAL_REQUIRED = "tool_approval_required",
  /** 工具调用审批通过 */
  TOOL_APPROVAL_ACCEPTED = "tool_approval_accepted",
  /** 工具调用审批拒绝 */
  TOOL_APPROVAL_REJECTED = "tool_approval_rejected",
  /** 工具开始执行 */
  TOOL_EXECUTE_START = "tool_execute_start",
  /** 工具执行完成 */
  TOOL_EXECUTE_DONE = "tool_execute_done",
  /** 工具执行失败 */
  TOOL_EXECUTE_ERROR = "tool_execute_error",
  /** Assistant 写入 Session 前的可等待生命周期 */
  BEFORE_ASSISTANT_COMMIT = "before_assistant_commit",
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

export interface ToolApprovalRequiredEvent {
  type: StreamEventType.TOOL_APPROVAL_REQUIRED;
  approvalId: string;
  toolCallId: string;
  name: string;
  /** 已解析参数 */
  arguments: Record<string, unknown>;
  /** 原始参数 JSON string */
  rawArguments: string;
  /** 当前 Agent turn */
  turn: number;
}

export interface ToolApprovalAcceptedEvent {
  type: StreamEventType.TOOL_APPROVAL_ACCEPTED;
  approvalId: string;
  toolCallId: string;
  name: string;
}

export interface ToolApprovalRejectedEvent {
  type: StreamEventType.TOOL_APPROVAL_REJECTED;
  approvalId: string;
  toolCallId: string;
  name: string;
  reason?: string;
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

export interface ToolExecuteErrorEvent {
  type: StreamEventType.TOOL_EXECUTE_ERROR;
  toolCallId: string;
  name: string;
  error: Error;
  /** 写回模型的错误结果；throw 策略下可能为空 */
  result?: Message;
}

export interface BeforeAssistantCommitEvent {
  type: StreamEventType.BEFORE_ASSISTANT_COMMIT;
  /** 即将写入 Session 的 Assistant，可直接安全修改或替换 */
  message: Message;
  /** 当前 Agent turn */
  turn: number;
  /** 模型完成原因，例如 stop / length / tool_calls */
  finishReason?: FinishReason;
}

export interface MessageDoneEvent {
  type: StreamEventType.MESSAGE_DONE;
  /** 组装完成的 Message */
  message: Message;
  /** 模型完成原因，例如 stop / length / tool_calls */
  finishReason?: FinishReason;
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
  | ToolApprovalRequiredEvent
  | ToolApprovalAcceptedEvent
  | ToolApprovalRejectedEvent
  | ToolExecuteStartEvent
  | ToolExecuteDoneEvent
  | ToolExecuteErrorEvent
  | BeforeAssistantCommitEvent
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
  [StreamEventType.TOOL_APPROVAL_REQUIRED]: ToolApprovalRequiredEvent;
  [StreamEventType.TOOL_APPROVAL_ACCEPTED]: ToolApprovalAcceptedEvent;
  [StreamEventType.TOOL_APPROVAL_REJECTED]: ToolApprovalRejectedEvent;
  [StreamEventType.TOOL_EXECUTE_START]: ToolExecuteStartEvent;
  [StreamEventType.TOOL_EXECUTE_DONE]: ToolExecuteDoneEvent;
  [StreamEventType.TOOL_EXECUTE_ERROR]: ToolExecuteErrorEvent;
  [StreamEventType.BEFORE_ASSISTANT_COMMIT]: BeforeAssistantCommitEvent;
  [StreamEventType.MESSAGE_DONE]: MessageDoneEvent;
  [StreamEventType.TURN_START]: TurnStartEvent;
  [StreamEventType.TURN_END]: TurnEndEvent;
  [StreamEventType.ERROR]: ErrorEvent;
}
