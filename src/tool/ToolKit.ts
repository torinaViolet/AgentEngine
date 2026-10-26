import { assert } from "../core/data";
import type { ToolDefinition } from "../provider";
import { Tool } from './Tool';
export class ToolKit {
    private tools = new Map<string, Tool<any>>();
    private visible = new Set<string>();
    add(...tools: Tool<any>[]): this {
        for (const tool of tools) {
            assert(!this.tools.has(tool.name), `Duplicate tool: ${tool.name}`);
            this.tools.set(tool.name, tool);
            this.visible.add(tool.name);
        }
        return this;
    }
    get(name: string): Tool<any> | undefined {
        return this.tools.get(name);
    }
    get size(): number {
        return this.tools.size;
    }
    has(name: string): boolean {
        return this.tools.has(name);
    }
    enable(name: string): this {
        assert(this.has(name), "Unknown tool");
        this.visible.add(name);
        return this;
    }
    disable(name: string): this {
        this.visible.delete(name);
        return this;
    }
    isEnabled(name: string): boolean {
        return this.visible.has(name);
    }
    get definitions(): ToolDefinition[] {
        return [...this.visible].map(name => this.tools.get(name)!.definition);
    }
    async addMCP(client: McpClientLike): Promise<this> {
        const { tools } = await client.listTools();
        for (const tool of tools)
            this.add(new Tool({ name: tool.name, description: tool.description, parameters: tool.inputSchema, execute: (args, context) => client.callTool({ name: tool.name, arguments: args }, { signal: context.signal }) }));
        return this;
    }
}
export interface McpClientLike {
    listTools(): Promise<{
        tools: Array<{
            name: string;
            description?: string;
            inputSchema: Record<string, unknown>;
        }>;
    }>;
    callTool(input: {
        name: string;
        arguments: Record<string, unknown>;
    }, options?: {
        signal?: AbortSignal;
    }): Promise<unknown>;
}
