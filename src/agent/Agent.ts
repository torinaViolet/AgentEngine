import { Message } from "../message/Message";
import { MessagePart } from "../message/MessagePart";
import { Usage } from "../message/Usage";
import { MessageAdapter } from "../adapter/MessageAdapter";
import type { SerializeOptions, ThinkingSerializationMode } from "../adapter/MessageAdapter";
import { OpenAIAdapter } from "../adapter/OpenAIAdapter";
import {
  ToolKit,
  ToolExecutionError,
} from "../tool/ToolKit";
import { Session } from "../session/Session";
import { StreamParser } from "../stream/StreamParser";
import {
  StreamEvent,
  StreamEventType,
  StreamEventMap,
} from "../stream/StreamEvent";
import { PromptBuilder } from "../prompt/PromptBuilder";
import type { BuildOptions } from "../prompt/PromptBuilder";
import { RequestConfig } from "../config/RequestConfig";
import { generateId } from "../utils";

/** OpenAI Client 最小接口（避免直接依赖 openai 包的类型） */
export interface OpenAIClientLike {
  chat: {
    completions: {
      create(params: any, options?: any): Promise<any>;
    };
  };
}

/** Agent 配置 */
export interface AgentOptions {
  /** OpenAI 兼容客户端 */
  client: OpenAIClientLike;
  /** 模型名*/
  model: string;
  /** 消息适配器（默认OpenAIAdapter） */
  adapter?: MessageAdapter;
  /** 工具包 */
  toolkit?: ToolKit;
  /** 工具调用审批函数：返回 false 或 { approved:false } 可拒绝执行 */
  toolApproval?: ToolApprovalHandler;
  /** 工具审批模式：auto=无审批函数时自动通过；manual=等待 approve/reject API */
  toolApprovalMode?: ToolApprovalMode;
  /** manual 审批超时时间（毫秒），不设置则一直等待 */
  toolApprovalTimeoutMs?: number;
  /** manual 审批超时策略，默认 reject */
  toolApprovalTimeoutPolicy?: ToolApprovalTimeoutPolicy;
  /** 工具执行错误策略，默认 return_to_model */
  toolErrorPolicy?: AgentToolErrorPolicy;
  /** 会话 */
  session: Session;
  /** 最大循环轮次（防无限循环），默认10*/
  maxTurns?: number;
  /** 提示词构建器 */
  promptBuilder?: PromptBuilder;
  /** 请求参数配置 */
  config?: RequestConfig;
  /** 额外请求参数（temperature, max_tokens等）—兼容旧 API */
  requestOptions?: Record<string, unknown>;
}

/** 单次运行控制选项 + 临时请求参数 */
export interface AgentRunOptions extends Record<string, unknown> {
  /** 中断信号：可取消请求、流读取和工具等待 */
  signal?: AbortSignal;
  /** 本次运行超时时间（毫秒） */
  timeoutMs?: number;
  /** PromptBuilder 本次构建选项，例如 { strategy: "immediate" } */
  promptBuildOptions?: BuildOptions;
  /** 本次 Adapter 序列化选项，尤其用于按需控制 thinking 回传 */
  serializeOptions?: SerializeOptions;
}

/** Agent 停止原因 */
export type AgentStopReason =
  | "final"
  | "continue"
  | "abort"
  | "timeout"
  | "network_error"
  | "stream_error"
  | "tool_approval_rejected"
  | "tool_execution_error"
  | "max_tokens"
  | "max_turns"
  | "unknown_error";

/** Agent 运行状态 */
export interface AgentRunState {
  id: string;
  status: "running" | "completed" | "interrupted" | "failed";
  stopReason?: AgentStopReason;
  error?: Error;
  partialMessage?: Message;
  lastMessage?: Message;
  turn: number;
  canResume: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/** 工具审批请求 */
export interface ToolApprovalRequest {
  approvalId: string;
  toolCallId: string;
  name: string;
  arguments: Record<string, unknown>;
  rawArguments: string;
  turn: number;
}

/** 工具审批结果 */
export type ToolApprovalResult =
  | boolean
  | {
    approved: boolean;
    reason?: string;
  };

/** 工具审批函数 */
export type ToolApprovalHandler = (
  request: ToolApprovalRequest
) => ToolApprovalResult | Promise<ToolApprovalResult>;

/** 工具审批模式 */
export type ToolApprovalMode = "auto" | "manual";

/** manual 审批超时策略 */
export type ToolApprovalTimeoutPolicy = "reject" | "abort";

/** Agent 工具执行错误策略 */
export type AgentToolErrorPolicy = "return_to_model" | "pause" | "throw";

interface PendingToolApproval extends ToolApprovalRequest {
  createdAt: Date;
  resolve: (result: ToolApprovalResult) => void;
  reject: (error: Error) => void;
}

/** Continue / Resume 选项 */
export interface AgentContinueOptions extends AgentRunOptions {
  /** auto=有中断则恢复，否则普通继续；resume=严格恢复；continue=普通继续 */
  mode?: "auto" | "resume" | "continue";
  /** 继续时追加的提示词 */
  prompt?: string;
  /** thinking 回传策略；resume 默认 auto，普通 continue 默认 none */
  thinkingMode?: ThinkingSerializationMode;
}

/** Agent 主动中断错误 */
export class AgentAbortError extends Error {
  constructor(message: string = "Agent run aborted") {
    super(message);
    this.name = "AbortError";
  }
}

/** Agent 超时错误 */
export class AgentTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Agent run timed out after ${timeoutMs}ms`);
    this.name = "TimeoutError";
  }
}

interface PreparedRunOptions {
  requestOptions: Record<string, unknown>;
  signal?: AbortSignal;
  promptBuildOptions?: BuildOptions;
  serializeOptions?: SerializeOptions;
  cleanup: () => void;
}

/** 自定义事件接口 */
export interface CustomEvent {
  type: string;
  [key: string]: unknown;
}

/** 事件处理函数签名 */
type EventHandler = (event: StreamEvent | CustomEvent) => void;

/**
 * 智能体 — 自动循环层
 *
 * 串联Session + Adapter + ToolKit + StreamParser，
 * 实现流式调用→ 解析 → 工具执行 → 再调用的自动循环。
 *
 * 用法:
 *const agent = new Agent({ client, model, session, toolkit });
 *   agent
 *     .on(StreamEventType.TEXT_DELTA, (e) => process.stdout.write(e.delta))
 *     .on(StreamEventType.TOOL_CALL_START, (e) => console.log(`🔧 ${e.name}`));
 *
 *   const reply = await agent.run("北京天气怎么样？");
 */
export class Agent {
  private _client: OpenAIClientLike;
  private _model: string;
  private _adapter: MessageAdapter;
  private _toolkit?: ToolKit;
  private _session: Session;
  private _promptBuilder?: PromptBuilder;
  private _maxTurns: number;
  private _config?: RequestConfig;
  private _requestOptions: Record<string, unknown>;
  private _toolApproval?: ToolApprovalHandler;
  private _toolApprovalMode: ToolApprovalMode;
  private _toolApprovalTimeoutMs?: number;
  private _toolApprovalTimeoutPolicy: ToolApprovalTimeoutPolicy;
  private _toolErrorPolicy: AgentToolErrorPolicy;
  private _pendingApprovals: Map<string, PendingToolApproval> = new Map();
  private _handlers: Map<string, EventHandler[]> = new Map();
  private _activeAbortController?: AbortController;
  private _lastRunState?: AgentRunState;

  constructor(options: AgentOptions) {
    this._client = options.client;
    this._model = options.model;
    this._adapter = options.adapter || new OpenAIAdapter();
    this._toolkit = options.toolkit;
    this._session = options.session;
    this._promptBuilder = options.promptBuilder;
    this._config = options.config;
    this._maxTurns = options.maxTurns ?? 10;
    this._requestOptions = options.requestOptions ?? {};
    this._toolApproval = options.toolApproval;
    this._toolApprovalMode = options.toolApprovalMode ?? "auto";
    this._toolApprovalTimeoutMs = options.toolApprovalTimeoutMs;
    this._toolApprovalTimeoutPolicy = options.toolApprovalTimeoutPolicy ?? "reject";
    this._toolErrorPolicy = options.toolErrorPolicy ?? "return_to_model";

    // 初始化所有事件的handler列表
    for (const type of Object.values(StreamEventType)) {
      this._handlers.set(type as string, []);
    }
  }

  //========================
  //  事件监听
  // ========================

  /**
   * 注册事件监听（链式）
   *
   * 支持类型安全的事件推断：
   *   agent.on(StreamEventType.TEXT_DELTA, (e) => e.delta) // e自动推断为 TextDeltaEvent
   *
   * 也支持自定义事件类型（任意字符串）：
   *   agent.on("my_custom_event", (e) => console.log(e.data))
   */
  on<T extends StreamEventType>(
    event: T,
    handler: (event: StreamEventMap[T]) => void
  ): this;
  on<T extends StreamEventType>(
    event: T[],
    handler: (event: StreamEventMap[T]) => void
  ): this;
  on(event: string, handler: EventHandler): this;
  on(event: string[], handler: EventHandler): this;
  on(
    event: string | string[],
    handler: EventHandler
  ): this {
    const events = Array.isArray(event) ? event : [event];
    for (const e of events) {
      if (!this._handlers.has(e)) {
        this._handlers.set(e, []);
      }
      this._handlers.get(e)!.push(handler);
    }
    return this;
  }

  /**
   * 移除事件监听
   */
  off<T extends StreamEventType>(
    event: T,
    handler: (event: StreamEventMap[T]) => void
  ): this;
  off(event: string, handler: EventHandler): this;
  off(event: string, handler: EventHandler): this {
    const handlers = this._handlers.get(event);
    if (handlers) {
      const index = handlers.indexOf(handler);
      if (index !== -1) handlers.splice(index, 1);
    }
    return this;
  }

  /**
   * 注册一次性事件监听（触发一次后自动移除）
   */
  once<T extends StreamEventType>(
    event: T,
    handler: (event: StreamEventMap[T]) => void
  ): this;
  once(event: string, handler: EventHandler): this;
  once(event: string, handler: EventHandler): this {
    const wrapper: EventHandler = (e: any) => {
      this.off(event, wrapper);
      handler(e);
    };
    return this.on(event, wrapper);
  }

  /**
   * 移除指定事件的所有监听器，不传参则移除所有事件的所有监听器
   */
  removeAllListeners(event?: string): this {
    if (event) {
      this._handlers.set(event, []);
    } else {
      for (const key of this._handlers.keys()) {
        this._handlers.set(key, []);
      }
    }
    return this;
  }

  // ========================
  //  运行
  // ========================

  /**
   * 流式运行 — 最常用的入口
   *
   * 自动addUser → 循环(stream → parse → toolCall → execute) → addAssistant
   *
   * @param content 用户输入
   * @param options 临时覆盖的请求参数
   * @returns 最终的Assistant Message
   */
  async run(
    content: string | MessagePart | MessagePart[],
    options?: AgentRunOptions
  ): Promise<Message> {
    const userMsg = Message.user(content);
    return this.runWith(userMsg, options);
  }

  /**
   * 传入已构建的 Message 运行
   *
   * 直接将完整的 Message 对象追加到 Session，
   * 保留其所有 parts（多模态内容）、tags、metadata。
   */
  async runWith(
    message: Message,
    options?: AgentRunOptions
  ): Promise<Message> {
    this._session.addMessage(message);
    return this.executeLoop(options);
  }

  /**
   * 直接传入历史运行（不走Session）
   */
  async runRaw(
    messages: Message[],
    options?: AgentRunOptions
  ): Promise<Message> {
    const run = this.prepareRunOptions(options);

    try {
      this.throwIfAborted(run.signal);

      const configParams = this._config ? this._config.build() : {};
      const mergedOptions = { ...configParams, ...this._requestOptions, ...run.requestOptions };
      const parser = new StreamParser();

      const { messages: serialized } = await this.raceWithAbort(
        this._adapter.serialize(messages, run.serializeOptions),
        run.signal
      );

      const requestParams: Record<string, unknown> = {
        model: this._model,
        messages: serialized,
        stream: true,
        ...mergedOptions,
      };

      if (this._toolkit && this._toolkit.size > 0) {
        requestParams.tools = this._toolkit.schemas;
      }

      const stream = await this.raceWithAbort(
        this._client.chat.completions.create(requestParams, this.createClientOptions(run.signal)),
        run.signal
      );

      for await (const chunk of stream as AsyncIterable<any>) {
        this.throwIfAborted(run.signal);
        const events = parser.feed(chunk);
        this.emitAll(events);
      }

      this.throwIfAborted(run.signal);
      const finalEvents = parser.finish();
      this.emitAll(finalEvents);

      const message = this.extractMessage(finalEvents);
      return message;
    } catch (e) {
      const error = this.toError(e);
      this.emitError(error);
      throw error;
    } finally {
      run.cleanup();
    }
  }

  // ========================
  //  配置
  // ========================

  /** 修改模型 */
  setModel(model: string): this {
    this._model = model;
    return this;
  }

  /** 修改最大轮次 */
  setMaxTurns(n: number): this {
    this._maxTurns = n;
    return this;
  }

  /** 设置请求参数配置 */
  setConfig(config: RequestConfig | undefined): this {
    this._config = config;
    return this;
  }

  /** 获取请求参数配置 */
  get config(): RequestConfig | undefined {
    return this._config;
  }

  /** 设置额外请求参数（兼容旧 API） */
  setRequestOptions(options: Record<string, unknown>): this {
    this._requestOptions = { ...this._requestOptions, ...options };
    return this;
  }

  /** 获取关联的Session */
  get session(): Session {
    return this._session;
  }

  /** 获取提示词构建器 */
  get promptBuilder(): PromptBuilder | undefined {
    return this._promptBuilder;
  }

  /** 设置提示词构建器 */
  setPromptBuilder(builder: PromptBuilder | undefined): this {
    this._promptBuilder = builder;
    return this;
  }

  /** 设置工具审批函数 */
  setToolApproval(handler: ToolApprovalHandler | undefined): this {
    this._toolApproval = handler;
    return this;
  }

  /** 设置工具审批模式 */
  setToolApprovalMode(mode: ToolApprovalMode): this {
    this._toolApprovalMode = mode;
    return this;
  }

  /** 获取工具审批函数 */
  get toolApproval(): ToolApprovalHandler | undefined {
    return this._toolApproval;
  }

  /** 获取当前等待外部决策的审批请求 */
  get pendingApprovals(): ToolApprovalRequest[] {
    return Array.from(this._pendingApprovals.values()).map(({ resolve, reject, createdAt, ...req }) => req);
  }

  /** 外部批准一个 manual 工具审批请求 */
  approve(approvalId: string): boolean {
    return this.resolvePendingApproval(approvalId, true);
  }

  /** 外部拒绝一个 manual 工具审批请求 */
  reject(approvalId: string, reason?: string): boolean {
    return this.resolvePendingApproval(approvalId, { approved: false, reason });
  }

  /** 设置工具错误策略 */
  setToolErrorPolicy(policy: AgentToolErrorPolicy): this {
    this._toolErrorPolicy = policy;
    return this;
  }

  /** 获取工具错误策略 */
  get toolErrorPolicy(): AgentToolErrorPolicy {
    return this._toolErrorPolicy;
  }

  /** 获取当前模型 */
  get model(): string {
    return this._model;
  }

  /** 最近一次运行状态 */
  get lastRunState(): AgentRunState | undefined {
    return this._lastRunState;
  }

  /** 是否存在可恢复的异常中断现场 */
  get canResume(): boolean {
    return this._lastRunState?.canResume ?? false;
  }

  /** 是否可以继续当前任务：异常可恢复，或当前 Session 光标在 assistant 消息上 */
  get canContinue(): boolean {
    return this.canResume || this._session.cursor.role === "assistant";
  }

  /** 当前是否有运行中的请求 */
  get isRunning(): boolean {
    return !!this._activeAbortController && !this._activeAbortController.signal.aborted;
  }

  /**
   * 中断当前运行中的 Agent。
   *
   * 返回 true 表示确实触发了中断；返回 false 表示当前没有可中断的运行。
   */
  abort(reason?: string | Error): boolean {
    if (!this._activeAbortController || this._activeAbortController.signal.aborted) {
      return false;
    }

    const error = reason instanceof Error
      ? reason
      : new AgentAbortError(reason ?? "Agent run aborted by user");
    this._activeAbortController.abort(error);
    return true;
  }

  /**
   * 继续当前任务。
   *
   * mode=auto 时：若上次运行可恢复，则走 resume 语义；否则追加普通继续提示。
   */
  async continue(options?: AgentContinueOptions): Promise<Message> {
    const mode = options?.mode ?? "auto";
    const shouldResume = mode === "resume" || (mode === "auto" && this.canResume);

    if (mode === "resume" && !this.canResume) {
      throw new Error("当前没有可恢复的中断任务");
    }

    if (!shouldResume && !this.canContinue) {
      throw new Error("当前没有可继续的上下文");
    }

    const prompt = options?.prompt ?? (shouldResume
      ? "请从上一次中断的位置继续完成任务。不要重复已经完成的内容。如果上一次停在句子中间，请自然衔接；如果停在工具调用或操作流程中，请继续完成剩余步骤。"
      : "请继续完成上一个任务，保持相同的结构和风格，不要重复已经完成的内容。");

    const serializeOptions = options?.serializeOptions ?? {
      thinking: {
        mode: options?.thinkingMode ?? (shouldResume ? "auto" : "none"),
        scope: shouldResume ? "last" : "none",
      },
    };

    const { mode: _mode, prompt: _prompt, thinkingMode: _thinkingMode, ...runOptions } = options ?? {};
    return this.run(prompt, {
      ...runOptions,
      serializeOptions,
    });
  }

  /** 严格从异常中断处恢复 */
  async resume(options?: Omit<AgentContinueOptions, "mode">): Promise<Message> {
    return this.continue({ ...options, mode: "resume" });
  }

  // ========================
  //  核心循环
  // ========================

  private async executeLoop(
    options?: AgentRunOptions
  ): Promise<Message> {
    const run = this.prepareRunOptions(options);
    this.startRunState();
    let currentParser: StreamParser | undefined;
    let partialAlreadyPersisted = false;

    try {
      const mergedOptions = this.buildMergedOptions(run.requestOptions);
      let lastAssistantMsg: Message | undefined;

      for (let turn = 0; turn < this._maxTurns; turn++) {
        this.throwIfAborted(run.signal);
        const parser = new StreamParser();
        currentParser = parser;
        partialAlreadyPersisted = false;
        this.updateRunState({ turn });

        this.emit({ type: StreamEventType.TURN_START, turn });

        // 流式调用 + 解析
        const { assistantMsg, finishReason } = await this.executeSingleStream(
          parser, mergedOptions, run
        );

        // 添加到 Session
        this._session.addAssistant(assistantMsg);
        lastAssistantMsg = assistantMsg;
        currentParser = undefined;
        partialAlreadyPersisted = true;
        this.updateRunState({ lastMessage: assistantMsg });

        // 输出长度限制
        if (finishReason === "length") {
          this.failRunState(
            new Error("模型输出达到长度限制，未完成最终回复"),
            "max_tokens",
            assistantMsg,
            true
          );
          return assistantMsg;
        }

        const hasToolCalls = assistantMsg.toolCalls.length > 0;

        this.emit({ type: StreamEventType.TURN_END, turn, hasToolCalls });

        // 如果没有工具调用，循环结束
        if (!hasToolCalls || !this._toolkit) {
          this.completeRunState(assistantMsg, "final");
          return assistantMsg;
        }

        // 工具审批 + 执行
        await this.processToolCalls(assistantMsg.toolCalls, turn, run.signal);
      }

      // 循环结束后的检查
      return this.handleLoopExhausted(lastAssistantMsg);
    } catch (e) {
      const error = this.toError(e);
      const reason = this.classifyStopReason(error);
      const partial = currentParser && !partialAlreadyPersisted
        ? this.persistPartialSnapshot(currentParser, reason)
        : undefined;

      if (this._lastRunState?.error !== error) {
        this.failRunState(
          error,
          reason,
          partial,
          !!partial || this.isContinuableError(error)
        );
      }
      this.emitError(error);
      throw error;
    } finally {
      run.cleanup();
    }
  }

  /**
   * 合并请求参数：Config → requestOptions → run options
   */
  private buildMergedOptions(runOptions: Record<string, unknown>): Record<string, unknown> {
    const configParams = this._config ? this._config.build() : {};
    return { ...configParams, ...this._requestOptions, ...runOptions };
  }

  /**
   * 执行单轮流式调用：序列化 → 请求 → 解析 → 返回 Message
   */
  private async executeSingleStream(
    parser: StreamParser,
    mergedOptions: Record<string, unknown>,
    run: PreparedRunOptions
  ): Promise<{ assistantMsg: Message; finishReason: string | undefined }> {
    // 获取会话历史，经 PromptBuilder 注入后序列化
    const history = this._session.history();
    const context = this._promptBuilder
      ? this._promptBuilder.build(history, run.promptBuildOptions)
      : history;
    const { messages: serialized } = await this.raceWithAbort(
      this._adapter.serialize(context, run.serializeOptions),
      run.signal
    );

    // 构建请求参数
    const requestParams: Record<string, unknown> = {
      model: this._model,
      messages: serialized,
      stream: true,
      ...mergedOptions,
    };

    if (this._toolkit && this._toolkit.size > 0) {
      requestParams.tools = this._toolkit.schemas;
    }

    // 流式调用
    const stream = await this.raceWithAbort(
      this._client.chat.completions.create(requestParams, this.createClientOptions(run.signal)),
      run.signal
    );

    // 解析 chunks
    let streamUsage: Usage | undefined;
    for await (const chunk of stream as AsyncIterable<any>) {
      this.throwIfAborted(run.signal);

      if (chunk.usage) {
        streamUsage = Usage.fromRaw(chunk.usage);
      }

      const events = parser.feed(chunk);
      this.emitAll(events);
    }

    this.throwIfAborted(run.signal);

    // 结束解析
    const finalEvents = parser.finish();
    this.emitAll(finalEvents);

    // 提取组装好的 Message
    const assistantMsg = this.extractMessage(finalEvents);
    const finishReason = this.extractFinishReason(finalEvents);

    // 填充 model 和 usage
    assistantMsg.model = this._model;
    if (streamUsage) {
      assistantMsg.usage = streamUsage;
    }

    return { assistantMsg, finishReason };
  }

  /**
   * 处理工具调用：审批 → 执行 → 结果回写 Session
   */
  private async processToolCalls(
    toolCalls: Message["toolCalls"],
    turn: number,
    signal?: AbortSignal
  ): Promise<void> {
    // 工具审批
    const approvalResults = await this.approveToolCalls(toolCalls, turn, signal);
    const approvedToolCalls = approvalResults
      .filter((item) => item.approved)
      .map((item) => item.toolCall);
    const rejectedToolResults = approvalResults
      .filter((item) => !item.approved)
      .map((item) => Message.tool(
        item.toolCall.toolCallId,
        JSON.stringify({ error: item.reason || "工具调用被拒绝", rejected: true })
      ));

    if (approvedToolCalls.length === 0) {
      if (rejectedToolResults.length > 0) {
        this._session.addTool(rejectedToolResults);
      }
      const error = new Error("所有工具调用均被审批拒绝");
      this.failRunState(error, "tool_approval_rejected", undefined, true);
      throw error;
    }

    // 为每个工具调用发出 START 事件
    for (const tc of approvedToolCalls) {
      this.throwIfAborted(signal);
      this.emit({
        type: StreamEventType.TOOL_EXECUTE_START,
        toolCallId: tc.toolCallId,
        name: tc.name,
      });
    }

    // 并行执行所有工具调用
    const toolResults = await this.executeApprovedToolCalls(
      approvedToolCalls,
      rejectedToolResults,
      signal
    );

    // 添加工具结果到 Session
    this._session.addTool(toolResults);
  }

  /**
   * 循环耗尽后的结果检查
   */
  private handleLoopExhausted(lastAssistantMsg: Message | undefined): Message {
    if (!lastAssistantMsg) {
      throw new Error("Agent 运行失败：未获得任何回复");
    }

    if (lastAssistantMsg.toolCalls.length > 0 && this._toolkit) {
      const error = new Error(`Agent 达到最大循环轮次 maxTurns=${this._maxTurns}，但仍未获得最终回复`);
      this.failRunState(error, "max_turns", lastAssistantMsg, true);
      throw error;
    }

    this.completeRunState(lastAssistantMsg, "final");
    return lastAssistantMsg;
  }

  // ========================
  //  事件分发
  // ========================

  /**
   * 发射事件（支持内置事件和自定义事件）
   *
   * 内置事件由 Agent 循环自动发射，用户也可手动发射自定义事件：
   *
   *   agent.emit({ type: "my_abort", reason: "用户取消" });
   *
   * 结合 on() 可实现自定义中断等高级功能：
   *
   *   agent.on("abort", (e) => { ... });
   *   agent.emit({ type: "abort" });
   */
  emit(event: StreamEvent | CustomEvent): void {
    const handlers = this._handlers.get(event.type) || [];
    for (const handler of handlers) {
      try {
        handler(event);
      } catch (e) {
        // handler异常不应中断流程
        console.error(`Event handler error [${event.type}]:`, e);
      }
    }
  }

  private emitAll(events: StreamEvent[]): void {
    for (const event of events) {
      this.emit(event);
    }
  }

  // ========================
  //  辅助
  // ========================

  private extractMessage(events: StreamEvent[]): Message {
    for (const event of events) {
      if (event.type === StreamEventType.MESSAGE_DONE) {
        return event.message;
      }
    }
    throw new Error("未找到 MESSAGE_DONE 事件");
  }

  private extractFinishReason(events: StreamEvent[]): string | undefined {
    for (const event of events) {
      if (event.type === StreamEventType.MESSAGE_DONE) {
        return event.finishReason;
      }
    }
    return undefined;
  }

  private async executeApprovedToolCalls(
    approvedToolCalls: Message["toolCalls"],
    rejectedToolResults: Message[],
    signal?: AbortSignal
  ): Promise<Message[]> {
    const policy = this._toolErrorPolicy;
    const toolResults: Message[] = [];

    if (policy === "throw") {
      try {
        const results = await this.raceWithAbort(
          this._toolkit!.executeAll(approvedToolCalls, {
            signal,
            errorPolicy: "throw",
          }),
          signal
        );
        toolResults.push(...results);
      } catch (e) {
        const error = this.toError(e);
        this.emitToolExecutionError(error);
        this.failRunState(error, "tool_execution_error", undefined, false);
        throw error;
      }
    } else {
      for (const toolCall of approvedToolCalls) {
        this.throwIfAborted(signal);
        const result = await this.raceWithAbort(
          this._toolkit!.execute(toolCall, {
            signal,
            errorPolicy: policy === "pause" ? "throw" : "return_to_model",
          }),
          signal
        ).catch((e) => this.handleToolExecutionFailure(toolCall, e, policy));

        if (result) {
          toolResults.push(result);
        }
      }
    }

    for (let i = 0; i < approvedToolCalls.length; i++) {
      const result = toolResults.find((msg) =>
        msg.parts.some((part) =>
          part.type === "tool_result" && part.toolCallId === approvedToolCalls[i].toolCallId
        )
      );
      if (!result) continue;
      this.throwIfAborted(signal);
      this.emit({
        type: StreamEventType.TOOL_EXECUTE_DONE,
        toolCallId: approvedToolCalls[i].toolCallId,
        name: approvedToolCalls[i].name,
        result,
      });
    }

    return [...rejectedToolResults, ...toolResults];
  }

  private handleToolExecutionFailure(
    toolCall: Message["toolCalls"][number],
    errorLike: unknown,
    policy: AgentToolErrorPolicy
  ): Message | undefined {
    const error = this.toError(errorLike);

    if (policy === "pause") {
      const result = Message.tool(
        toolCall.toolCallId,
        JSON.stringify({ error: error.message, paused: true })
      );
      this.emitToolExecutionError(error, toolCall, result);
      this._session.addTool([result]);
      this.failRunState(error, "tool_execution_error", result, true);
      throw error;
    }

    this.emitToolExecutionError(error, toolCall);
    return Message.tool(toolCall.toolCallId, JSON.stringify({ error: error.message }));
  }

  private emitToolExecutionError(
    error: Error,
    toolCall?: Message["toolCalls"][number],
    result?: Message
  ): void {
    const toolError = error instanceof ToolExecutionError ? error : undefined;
    this.emit({
      type: StreamEventType.TOOL_EXECUTE_ERROR,
      toolCallId: toolCall?.toolCallId ?? toolError?.toolCallId ?? "",
      name: toolCall?.name ?? toolError?.toolName ?? "",
      error,
      result,
    });
  }

  private async approveToolCalls(
    toolCalls: Message["toolCalls"],
    turn: number,
    signal?: AbortSignal
  ): Promise<Array<{ toolCall: Message["toolCalls"][number]; approved: boolean; reason?: string }>> {
    const results: Array<{ toolCall: Message["toolCalls"][number]; approved: boolean; reason?: string }> = [];

    for (const toolCall of toolCalls) {
      this.throwIfAborted(signal);

      const approvalId = this.generateApprovalId();
      const request: ToolApprovalRequest = {
        approvalId,
        toolCallId: toolCall.toolCallId,
        name: toolCall.name,
        arguments: this.safeParseArguments(toolCall.arguments),
        rawArguments: toolCall.arguments,
        turn,
      };

      this.emit({
        type: StreamEventType.TOOL_APPROVAL_REQUIRED,
        ...request,
      });

      const normalized = this.normalizeApprovalResult(
        await this.resolveToolApproval(request, signal)
      );

      if (normalized.approved) {
        this.emit({
          type: StreamEventType.TOOL_APPROVAL_ACCEPTED,
          approvalId,
          toolCallId: toolCall.toolCallId,
          name: toolCall.name,
        });
      } else {
        this.emit({
          type: StreamEventType.TOOL_APPROVAL_REJECTED,
          approvalId,
          toolCallId: toolCall.toolCallId,
          name: toolCall.name,
          reason: normalized.reason,
        });
      }

      results.push({ toolCall, ...normalized });
    }

    return results;
  }

  private normalizeApprovalResult(result: ToolApprovalResult): { approved: boolean; reason?: string } {
    if (typeof result === "boolean") return { approved: result };
    return {
      approved: result.approved,
      reason: result.reason,
    };
  }

  private resolveToolApproval(
    request: ToolApprovalRequest,
    signal?: AbortSignal
  ): Promise<ToolApprovalResult> {
    if (this._toolApproval) {
      return this.raceWithAbort(Promise.resolve(this._toolApproval(request)), signal);
    }

    if (this._toolApprovalMode !== "manual") {
      return Promise.resolve(true);
    }

    return this.waitForManualApproval(request, signal);
  }

  private waitForManualApproval(
    request: ToolApprovalRequest,
    signal?: AbortSignal
  ): Promise<ToolApprovalResult> {
    return new Promise<ToolApprovalResult>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const cleanup = () => {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        this._pendingApprovals.delete(request.approvalId);
      };

      const settleResolve = (result: ToolApprovalResult) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(result);
      };

      const settleReject = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };

      const onAbort = () => settleReject(this.getAbortReason(signal!));

      if (signal?.aborted) {
        settleReject(this.getAbortReason(signal));
        return;
      }

      if (signal) {
        signal.addEventListener("abort", onAbort, { once: true });
      }

      if (this._toolApprovalTimeoutMs !== undefined) {
        timer = setTimeout(() => {
          if (this._toolApprovalTimeoutPolicy === "abort") {
            settleReject(new Error(`工具审批超时: ${request.name}`));
          } else {
            settleResolve({ approved: false, reason: "工具审批超时" });
          }
        }, Math.max(0, this._toolApprovalTimeoutMs));
      }

      this._pendingApprovals.set(request.approvalId, {
        ...request,
        createdAt: new Date(),
        resolve: settleResolve,
        reject: settleReject,
      });
    });
  }

  private resolvePendingApproval(approvalId: string, result: ToolApprovalResult): boolean {
    const pending = this._pendingApprovals.get(approvalId);
    if (!pending) return false;
    pending.resolve(result);
    return true;
  }

  private safeParseArguments(args: string): Record<string, unknown> {
    try {
      const parsed = JSON.parse(args);
      return typeof parsed === "object" && parsed !== null ? parsed : {};
    } catch {
      return {};
    }
  }

  private generateApprovalId(): string {
    return generateId("approval");
  }

  private prepareRunOptions(options?: AgentRunOptions): PreparedRunOptions {
    const { signal: externalSignal, timeoutMs, promptBuildOptions, serializeOptions, ...requestOptions } = options ?? {};
    const cleanupFns: Array<() => void> = [];
    const controller = new AbortController();
    const signal = controller.signal;

    this._activeAbortController = controller;

    if (externalSignal?.aborted) {
      controller.abort(this.getAbortReason(externalSignal));
    } else if (externalSignal) {
      const onAbort = () => controller.abort(this.getAbortReason(externalSignal));
      externalSignal.addEventListener("abort", onAbort, { once: true });
      cleanupFns.push(() => externalSignal.removeEventListener("abort", onAbort));
    }

    if (timeoutMs !== undefined) {
      const timer = setTimeout(() => {
        controller.abort(new AgentTimeoutError(timeoutMs));
      }, Math.max(0, timeoutMs));
      cleanupFns.push(() => clearTimeout(timer));
    }

    return {
      requestOptions,
      signal,
      promptBuildOptions,
      serializeOptions,
      cleanup: () => {
        for (const fn of cleanupFns) fn();
        if (this._activeAbortController === controller) {
          this._activeAbortController = undefined;
        }
      },
    };
  }

  private createClientOptions(signal?: AbortSignal): Record<string, unknown> | undefined {
    return signal ? { signal } : undefined;
  }

  private throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) {
      throw this.getAbortReason(signal);
    }
  }

  private getAbortReason(signal: AbortSignal): Error {
    const reason = (signal as AbortSignal & { reason?: unknown }).reason;
    if (reason instanceof Error) return reason;
    if (reason !== undefined) return new AgentAbortError(String(reason));
    return new AgentAbortError();
  }

  private async raceWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
    this.throwIfAborted(signal);
    if (!signal) return promise;

    return Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        const onAbort = () => reject(this.getAbortReason(signal));
        const cleanup = () => signal.removeEventListener("abort", onAbort);
        signal.addEventListener("abort", onAbort, { once: true });
        promise.then(cleanup, cleanup);
      }),
    ]);
  }

  private toError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
  }

  private emitError(error: Error): void {
    this.emit({
      type: StreamEventType.ERROR,
      error,
    });
  }

  private startRunState(): void {
    const now = new Date();
    this._lastRunState = {
      id: generateId("run"),
      status: "running",
      turn: 0,
      canResume: false,
      createdAt: now,
      updatedAt: now,
    };
  }

  private updateRunState(patch: Partial<AgentRunState>): void {
    if (!this._lastRunState) return;
    this._lastRunState = {
      ...this._lastRunState,
      ...patch,
      updatedAt: new Date(),
    };
  }

  private completeRunState(message: Message, reason: AgentStopReason): void {
    this.updateRunState({
      status: "completed",
      stopReason: reason,
      lastMessage: message,
      canResume: false,
    });
  }

  private failRunState(
    error: Error,
    reason: AgentStopReason,
    partial?: Message,
    canResume: boolean = false
  ): void {
    this.updateRunState({
      status: reason === "abort" || reason === "timeout" ? "interrupted" : "failed",
      stopReason: reason,
      error,
      partialMessage: partial,
      canResume,
    });
  }

  private classifyStopReason(error: Error): AgentStopReason {
    if (error instanceof AgentTimeoutError || error.name === "TimeoutError") return "timeout";
    if (error instanceof AgentAbortError || error.name === "AbortError") return "abort";
    if (error instanceof ToolExecutionError || error.name === "ToolExecutionError") return "tool_execution_error";
    return "unknown_error";
  }

  private persistPartialSnapshot(parser: StreamParser, reason: AgentStopReason): Message | undefined {
    if (!parser.hasSnapshotContent) return undefined;

    const partial = parser.snapshot;
    partial.model = this._model;
    partial
      .setMeta("partial", true)
      .setMeta("stopReason", reason)
      .setMeta("finishReason", parser.finishReason);
    partial.tag("partial", "recoverable");

    this._session.addAssistant(partial);
    return partial;
  }

  private isContinuableError(error: Error): boolean {
    return error instanceof AgentTimeoutError ||
      error instanceof AgentAbortError ||
      error instanceof ToolExecutionError ||
      error.name === "TimeoutError" ||
      error.name === "AbortError" ||
      error.name === "ToolExecutionError";
  }
}
