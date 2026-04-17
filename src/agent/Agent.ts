import { Message } from "../message/Message";
import { MessagePart } from "../message/MessagePart";
import { Usage } from "../message/Usage";
import { MessageAdapter } from "../adapter/MessageAdapter";
import { OpenAIAdapter } from "../adapter/OpenAIAdapter";
import {ToolKit } from "../tool/ToolKit";
import { Session } from "../session/Session";
import { StreamParser } from "../stream/StreamParser";
import {
  StreamEvent,
  StreamEventType,
  StreamEventMap,
} from "../stream/StreamEvent";
import { PromptBuilder } from "../prompt/PromptBuilder";
import { RequestConfig } from "../config/RequestConfig";

/** OpenAI Client 最小接口（避免直接依赖 openai 包的类型） */
export interface OpenAIClientLike {
  chat: {
    completions: {
      create(params: any): Promise<any>;
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

/** 事件处理函数签名 */
type EventHandler<T extends StreamEvent = StreamEvent> = (event: T) => void;

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
  private _handlers: Map<StreamEventType, EventHandler[]> = new Map();

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

    // 初始化所有事件的handler列表
    for (const type of Object.values(StreamEventType)) {
      this._handlers.set(type as StreamEventType, []);
    }
  }

  //========================
  //  事件监听
  // ========================

  /**
   * 注册事件监听（链式）
   *
   * 支持类型安全的事件推断：
   *agent.on(StreamEventType.TEXT_DELTA, (e) => e.delta) // e自动推断为 TextDeltaEvent
   *
   * 也支持同时监听多个事件类型。
   */
  on<T extends StreamEventType>(
    event: T,
    handler: (event: StreamEventMap[T]) => void
  ): this;
  on<T extends StreamEventType>(
    event: T[],
    handler: (event: StreamEventMap[T]) => void
  ): this;
  on(
    event: StreamEventType | StreamEventType[],
    handler: EventHandler
  ): this {
    const events = Array.isArray(event) ? event : [event];
    for (const e of events) {
      this._handlers.get(e)!.push(handler);
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
    options?: Record<string, unknown>
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
    options?: Record<string, unknown>
  ): Promise<Message> {
    this._session.addMessage(message);
    return this.executeLoop(options);
  }

  /**
   * 直接传入历史运行（不走Session）
   */
  async runRaw(
    messages: Message[],
    options?: Record<string, unknown>
  ): Promise<Message> {
    const configParams = this._config ? this._config.build() : {};
    const mergedOptions = { ...configParams, ...this._requestOptions, ...options };
    const parser = new StreamParser();

    const { messages: serialized } = await this._adapter.serialize(messages);

    const requestParams: Record<string, unknown> = {
      model: this._model,
      messages: serialized,
      stream: true,
      ...mergedOptions,
    };

    if (this._toolkit && this._toolkit.size > 0) {
      requestParams.tools = this._toolkit.schemas;
    }

    const stream = await this._client.chat.completions.create(requestParams);

    for await (const chunk of stream as AsyncIterable<any>) {
      const events = parser.feed(chunk);
      this.emitAll(events);
    }

    const finalEvents = parser.finish();
    this.emitAll(finalEvents);

    const message = this.extractMessage(finalEvents);
    return message;
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

  /** 获取当前模型 */
  get model(): string {
    return this._model;
  }

  // ========================
  //  核心循环
  // ========================

  private async executeLoop(
    options?: Record<string, unknown>
  ): Promise<Message> {
    const configParams = this._config ? this._config.build() : {};
    const mergedOptions = { ...configParams, ...this._requestOptions, ...options };
    let lastAssistantMsg: Message | undefined;

    for (let turn = 0; turn < this._maxTurns; turn++) {
      const parser = new StreamParser();

      //---- TURN_START ----
      this.emit({
        type: StreamEventType.TURN_START,
        turn,
      });

      // 获取会话历史，经PromptBuilder 注入后序列化
      const history = this._session.history();
      const context = this._promptBuilder
        ? this._promptBuilder.build(history)
        : history;
      const { messages: serialized } = await this._adapter.serialize(context);

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
      const stream = await this._client.chat.completions.create(requestParams);

      // 解析chunks
      let streamUsage: Usage | undefined;
      for await (const chunk of stream as AsyncIterable<any>) {
        // 提取usage（有些API在最后一个chunk里带usage）
        if (chunk.usage) {
          streamUsage = Usage.fromRaw(chunk.usage);
        }

        const events = parser.feed(chunk);
        this.emitAll(events);
      }

      // 结束解析
      const finalEvents = parser.finish();
      this.emitAll(finalEvents);

      // 提取组装好的Message
      const assistantMsg = this.extractMessage(finalEvents);

      // 填充 model和 usage
      assistantMsg.model = this._model;
      if (streamUsage) {
        assistantMsg.usage = streamUsage;
      }

      // 添加到Session
      this._session.addAssistant(assistantMsg);
      lastAssistantMsg = assistantMsg;

      const hasToolCalls = assistantMsg.toolCalls.length > 0;

      // ---- TURN_END ----
      this.emit({
        type: StreamEventType.TURN_END,
        turn,
        hasToolCalls,
      });

      // 如果没有工具调用，循环结束
      if (!hasToolCalls || !this._toolkit) {
        break;
      }

      // ---- 并行执行工具 ----
      const toolCalls = assistantMsg.toolCalls;

      // 为每个工具调用发出 START 事件
      for (const tc of toolCalls) {
        this.emit({
          type: StreamEventType.TOOL_EXECUTE_START,
          toolCallId: tc.toolCallId,
          name: tc.name,
        });
      }

      // 并行执行所有工具调用
      const toolResults = await this._toolkit.executeAll(toolCalls);

      // 为每个工具调用发出 DONE 事件
      for (let i = 0; i < toolCalls.length; i++) {
        this.emit({
          type: StreamEventType.TOOL_EXECUTE_DONE,
          toolCallId: toolCalls[i].toolCallId,
          name: toolCalls[i].name,
          result: toolResults[i],
        });
      }

      // 添加工具结果到Session
      this._session.addTool(toolResults);}

    if (!lastAssistantMsg) {
      throw new Error("Agent 运行失败：未获得任何回复");
    }

    return lastAssistantMsg;
  }

  // ========================
  //  事件分发
  // ========================

  private emit(event: StreamEvent): void {
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
}