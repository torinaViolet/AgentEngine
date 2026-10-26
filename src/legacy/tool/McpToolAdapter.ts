import { Tool, ToolSchema } from "./Tool";
import { McpClientLike } from "./ToolKit";

/**
 * MCP 工具适配器
 *
 * 自动将 MCP Server暴露的工具转换为我们的 Tool 实例，
 * 在ToolKit 中与手动定义的工具完全同构，使用者无感知。
 *
 * 转换逻辑:
 *   MCP listTools() → { name, description, inputSchema }
 *   ↓
 *   Tool.fromRaw(name, desc, schema, executeFn)
 *   ↓
 *   executeFn = (args) => client.callTool({ name, arguments: args })
 */
export class McpToolAdapter{
  /**
   * 从 MCP Client 自动发现所有工具并转换
   *
   * @param client MCP Client 实例
   * @returns Tool[] 转换后的工具数组
   */
  static async fromClient(client: McpClientLike): Promise<Tool[]> {
    const response = await client.listTools();
    const tools: Tool[] = [];

    for (const mcpTool of response.tools) {
      const tool = McpToolAdapter.convertTool(client, mcpTool);
      tools.push(tool);
    }

    return tools;
  }

  /**
   * 转换单个 MCP 工具定义
   */
  static convertTool(
    client: McpClientLike,
    mcpTool: {
      name: string;
      description?: string;
      inputSchema: Record<string, unknown>;
    }
  ): Tool {
    const { name, description = "", inputSchema } = mcpTool;

    // 构造 OpenAI tools 格式的schema
    const schema = McpToolAdapter.buildSchema(name, description, inputSchema);

    // 执行函数：委托给 MCP Client
    const executeFn = async(
      args: Record<string, unknown>
    ): Promise<string> => {
      const result = await client.callTool({
        name,
        arguments: args,
      });

      // 将MCP 返回的 content 数组拼接为字符串
      return McpToolAdapter.extractContent(result.content);
    };

    return Tool.fromRaw(name, description, schema, executeFn);
  }

  /**
   * 将MCP inputSchema 转换为 OpenAI ToolSchema
   *
   * MCP 的 inputSchema 本身就是JSON Schema 格式，
   * 结构基本与 OpenAI 兼容，只需要包装一层即可。
   */
  private static buildSchema(
    name: string,
    description: string,
    inputSchema: Record<string, unknown>
  ): ToolSchema {
    const properties = (inputSchema.properties as Record<string, unknown>) || {};
    const required = (inputSchema.required as string[]) || [];

    return {
      type: "function",
      function: {
        name,
        description,
        parameters: {
          type: "object",
          properties,
          required,
        },
      },
    };
  }

  /**
   * 提取 MCP 返回内容
   *
   * MCP callTool 返回 content 数组，格式:
   * [{ type: "text", text: "..." }, ...]
   */
  private static extractContent(
    content: Array<{ type: string; text?: string }>
  ): string {
    return content
      .filter((c) => c.type === "text" && c.text)
      .map((c) => c.text!)
      .join("\n");
  }
}