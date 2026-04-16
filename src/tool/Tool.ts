import { Param } from "./Param";
import { Hook } from "./Hook";
import { Context } from "./Context";
import { ToolCall } from "./ToolCall";

/** 工具执行函数签名 */
export type ToolFunction = (args: Record<string, unknown>) => unknown | Promise<unknown>;

/**钩子处理函数签名 */
export type HookHandler = (ctx: Context) => void | Context;

/** OpenAI tools 格式的 schema */
export interface ToolSchema {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters:{
      type: "object";
      properties: Record<string, unknown>;
      required: string[];
    };
  };
}

/**
 * 工具定义 — Builder 模式
 *
 * build() 前: 构建阶段，链式配置
 * build() 后: 冻结状态，只能create() 调用实例
 *
 * 用法:
 *   const weather = Tool.create(getWeatherFn)
 *     .name("get_weather")
 *     .description("获取天气")
 *     .params(
 *       Param.string("city").desc("城市名").required(),
 *       Param.string("unit").desc("单位").enum(["celsius", "fahrenheit"]),
 *     )
 *     .on(Hook.ON_ERROR, (ctx) => { ctx.result = "暂不可用"; })
 *     .build();
 */
export class Tool {
  private _func: ToolFunction;
  private _name: string;
  private _description: string = "";
  private _params: Param[] = [];
  private _hooks: Map<Hook, HookHandler[]> = new Map();
  private _built: boolean = false;
  private _schema?: ToolSchema;

  private constructor(func: ToolFunction, name?: string) {
    this._func = func;
    this._name = name || func.name || "unnamed";

    // 初始化所有 Hook的handler 列表
    for (const hook of Object.values(Hook)) {
      this._hooks.set(hook as Hook, []);
    }
  }

  // ========================
  //  静态工厂
  // ========================

  /**
   * 创建工具 Builder
   * @param fn 工具执行函数，签名 (args: Record<string, unknown>) => unknown
   */
  static create(fn: ToolFunction): Tool {
    return new Tool(fn);
  }

  /**
   * 从已有的schema + 执行函数直接创建（用于 MCP 等外部工具）
   *跳过 Builder 阶段，直接进入 built 状态
   */
  static fromRaw(
    name: string,
    description: string,
    schema: ToolSchema,
    fn: ToolFunction
  ): Tool {
    const tool = new Tool(fn, name);
    tool._description = description;
    tool._schema = schema;
    tool._built = true;
    return tool;
  }

  // ========================
  //  链式配置（build前）
  // ========================

  name(n: string): this {
    this.guardNotBuilt();
    this._name = n;
    return this;
  }

  description(desc: string): this {
    this.guardNotBuilt();
    this._description = desc;
    return this;
  }

  /**
   * 批量添加参数
   */
  params(...params: Param[]): this {
    this.guardNotBuilt();
    this._params.push(...params);
    return this;
  }

  /**
   * 注册钩子，同一Hook 可注册多个handler，按注册顺序执行
   */
  on(hook: Hook, handler: HookHandler): this {
    this.guardNotBuilt();
    this._hooks.get(hook)!.push(handler);
    return this;
  }

  /**
   * 冻结配置，生成 JSON Schema
   */
  build(): this {
    this.guardNotBuilt();

    // 组装 properties和 required
    const properties: Record<string, unknown> = {};
    const required: string[] = [];

    for (const param of this._params) {
      properties[param.name] = param.toSchema();
      if (param.isRequired) {
        required.push(param.name);
      }
    }

    this._schema = {
      type: "function",
      function: {
        name: this._name,
        description: this._description,
        parameters: {
          type: "object",
          properties,
          required,
        },
      },
    };

    this._built = true;
    return this;
  }

  // ========================
  //  运行时（build 后）
  // ========================

  /** 获取 OpenAI tools 格式的 JSON Schema */
  get schema(): ToolSchema {
    this.guardBuilt();
    return this._schema!;
  }

  /** 工具名*/
  get toolName(): string {
    return this._name;
  }

  /** 执行函数 */
  get func(): ToolFunction {
    return this._func;
  }

  /**
   * 从模版创建一次具体的函数调用
   *
   * @param toolCallId LLM 返回的 tool_call id
   * @param args 调用参数
   */
  create(toolCallId: string, args: Record<string, unknown>): ToolCall {
    this.guardBuilt();

    const ctx = new Context(toolCallId, this._name, { ...args });

    // ---- ON_CREATE ----
    this.fire(Hook.ON_CREATE, ctx);

    // ---- ON_VALIDATE ----
    this.fire(Hook.ON_VALIDATE, ctx);

    //内置校验：必填参数
    const requiredParams = this._params.filter((p) => p.isRequired);
    const missing = requiredParams
      .filter((p) => !(p.name in ctx.arguments))
      .map((p) => p.name);

    if (missing.length > 0) {
      throw new Error(`缺少必填参数: ${missing.join(", ")}`);
    }

    return new ToolCall(this, toolCallId, this._name, ctx.arguments);
  }

  /**
   * 触发钩子链
   */
  fire(hook: Hook, ctx: Context): Context {
    const handlers = this._hooks.get(hook) || [];
    for (const handler of handlers) {
      const result = handler(ctx);
      if (result instanceof Context) {
        ctx = result;
      }
    }
    return ctx;
  }

  // ========================
  //  防护
  // ========================

  private guardBuilt(): void {
    if (!this._built) {
      throw new Error("工具尚未构建，请先调用 build()");
    }
  }

  private guardNotBuilt(): void {
    if (this._built) {
      throw new Error("工具已构建，无法修改");
    }
  }
}