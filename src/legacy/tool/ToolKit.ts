import { Tool, ToolSchema } from "./Tool";
import { ToolCall } from "./ToolCall";
import { ToolCallPart } from "../message/MessagePart";
import { Message } from "../message/Message";

export type ToolErrorPolicy = "return_to_model" | "throw";

export class ToolExecutionError extends Error {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly cause?: unknown;

  constructor(toolCallId: string, toolName: string, cause: unknown) {
    const message = cause instanceof Error ? cause.message : String(cause);
    super(`工具执行失败 [${toolName}]: ${message}`);
    this.name = "ToolExecutionError";
    this.toolCallId = toolCallId;
    this.toolName = toolName;
    this.cause = cause;
  }
}

export class ToolArgumentsError extends Error {
  readonly rawArguments: string;

  constructor(message: string, rawArguments: string) {
    super(message);
    this.name = "ToolArgumentsError";
    this.rawArguments = rawArguments;
  }
}

export interface ToolExecutionOptions {
  /** 中断信号：传入 Tool Context，供工具内部响应取消 */
  signal?: AbortSignal;
  /** 工具错误策略：默认 return_to_model */
  errorPolicy?: ToolErrorPolicy;
}

/**
 * 工具包管理器
 *
 * 统一管理所有工具，作为 Message 系统与 Tool 系统之间的桥梁。
 *
 * 用法:
 *const toolkit = new ToolKit()
 *     .add(weatherTool, timeTool);
 *
 *   await toolkit.addMCP(mcpClient);// 自动发现 MCP 工具
 *
 *   const tools = toolkit.schemas;// 丢给LLM
 *   const results = await toolkit.executeAll(msg.toolCalls);  // 批量执行
 */
export class ToolKit {
  private _tools: Map<string, Tool> = new Map();

  // ========================
  //  注册工具
  // ========================

  /**
   * 添加一个或多个工具
   */
  add(...tools: Tool[]): this {
    for (const tool of tools) {
      if (this._tools.has(tool.toolName)) {
        throw new Error(`工具名重复: ${tool.toolName}`);
      }
      this._tools.set(tool.toolName, tool);
    }
    return this;
  }

  /**
   * 从 MCP Client 自动发现并注册工具
   *
   * @param client @modelcontextprotocol/sdk的 Client 实例
   */
  async addMCP(client: McpClientLike): Promise<this> {
    const { McpToolAdapter } = await import("./McpToolAdapter");
    const tools = await McpToolAdapter.fromClient(client);
    for (const tool of tools) {
      if (!this._tools.has(tool.toolName)) {
        this._tools.set(tool.toolName, tool);
      }
    }
    return this;
  }

  // ========================
  //  查询
  // ========================

  /** 按名称获取工具 */
  get(name: string): Tool | undefined {
    return this._tools.get(name);
  }

  /** 检查工具是否存在 */
  has(name: string): boolean {
    return this._tools.has(name);
  }

  /** 所有工具的schema，直接传给LLM 的 tools参数 */
  get schemas(): ToolSchema[] {
    return Array.from(this._tools.values()).map((t) => t.schema);
  }

  /** 所有工具名*/
  get names(): string[] {
    return Array.from(this._tools.keys());
  }

  /** 工具数量 */
  get size(): number {
    return this._tools.size;
  }

  // ========================
  //  执行 —桥接Message↔ Tool
  // ========================

  /**
   * 执行单个 ToolCallPart
   *
   * ToolCallPart(数据) → ToolCall(行为) → execute → Message(数据)
   */
  async execute(
    toolCallPart: ToolCallPart,
    options?: ToolExecutionOptions
  ): Promise<Message> {
    const tool = this._tools.get(toolCallPart.name);
    if (!tool) {
      const error = new Error(`未知工具: ${toolCallPart.name}`);
      if (options?.errorPolicy === "throw") {
        throw new ToolExecutionError(toolCallPart.toolCallId, toolCallPart.name, error);
      }

      return Message.tool(
        toolCallPart.toolCallId,
        JSON.stringify({ error: error.message }),
        toolCallPart.name
      ).setMeta("toolExecutionError", {
        message: error.message,
        code: "unknown_tool",
      });
    }

    let args: Record<string, unknown>;
    try {
      args = this.parseArguments(toolCallPart.arguments);
    } catch (e) {
      if (options?.errorPolicy === "throw") {
        throw new ToolExecutionError(toolCallPart.toolCallId, toolCallPart.name, e);
      }

      const errorMsg = e instanceof Error ? e.message : String(e);
      return Message.tool(
        toolCallPart.toolCallId,
        JSON.stringify({ error: errorMsg, code: "invalid_tool_arguments" }),
        toolCallPart.name
      ).setMeta("toolExecutionError", {
        message: errorMsg,
        code: "invalid_tool_arguments",
      });
    }
    try {
      const call = tool.create(toolCallPart.toolCallId, args, options?.signal);
      await call.execute();
      return call.toMessage();
    } catch (e) {
      if (options?.errorPolicy === "throw") {
        throw new ToolExecutionError(toolCallPart.toolCallId, toolCallPart.name, e);
      }

      // 执行失败，返回错误消息
      const errorMsg = e instanceof Error ? e.message : String(e);
      return Message.tool(
        toolCallPart.toolCallId,
        JSON.stringify({ error: errorMsg }),
        toolCallPart.name
      ).setMeta("toolExecutionError", {
        message: errorMsg,
        code: "tool_execution_error",
      });
    }
  }

  /**
   * 并行执行多个 ToolCallPart
   */
  async executeAll(
    toolCallParts: ToolCallPart[],
    options?: ToolExecutionOptions
  ): Promise<Message[]> {
    return Promise.all(toolCallParts.map((part) => this.execute(part, options)));
  }

  // ========================
  //  内部辅助
  // ========================

  private parseArguments(args: string): Record<string, unknown> {
    if (args.trim().length === 0) {
      return {};
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(args);
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      throw new ToolArgumentsError(`工具参数不是合法 JSON: ${detail}`, args);
    }

    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new ToolArgumentsError("工具参数必须是 JSON 对象", args);
    }

    return parsed as Record<string, unknown>;
  }
}

/**
 * MCP Client最小接口
 *避免直接依赖 @modelcontextprotocol/sdk 的具体类型
 */
export interface McpClientLike {
  listTools(): Promise<{
    tools: Array<{
      name: string;
      description?: string;
      inputSchema: Record<string, unknown>;
    }>;
  }>;
  callTool(params: {
    name: string;
    arguments?: Record<string, unknown>;
  }): Promise<{
    content: Array<{ type: string; text?: string }>;
  }>;
}
