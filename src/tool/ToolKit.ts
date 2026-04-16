import { Tool, ToolSchema } from "./Tool";
import { ToolCall } from "./ToolCall";
import { ToolCallPart } from "../message/MessagePart";
import { Message } from "../message/Message";

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
  async execute(toolCallPart: ToolCallPart): Promise<Message> {
    const tool = this._tools.get(toolCallPart.name);
    if (!tool) {
      //工具不存在，返回错误消息
      return Message.tool(
        toolCallPart.toolCallId,
        JSON.stringify({ error: `未知工具: ${toolCallPart.name}` })
      );
    }

    const args = this.parseArguments(toolCallPart.arguments);
    const call = tool.create(toolCallPart.toolCallId, args);

    try {
      await call.execute();
    } catch (e) {
      // 执行失败，返回错误消息
      const errorMsg = e instanceof Error ? e.message : String(e);
      return Message.tool(
        toolCallPart.toolCallId,
        JSON.stringify({ error: errorMsg })
      );
    }

    return call.toMessage();
  }

  /**
   * 并行执行多个 ToolCallPart
   */
  async executeAll(toolCallParts: ToolCallPart[]): Promise<Message[]> {
    return Promise.all(toolCallParts.map((part) => this.execute(part)));
  }

  // ========================
  //  内部辅助
  // ========================

  private parseArguments(args: string): Record<string, unknown> {
    try {
      const parsed = JSON.parse(args);
      if (typeof parsed === "object" && parsed !== null) {
        return parsed;
      }
      return {};
    } catch {
      return {};
    }
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