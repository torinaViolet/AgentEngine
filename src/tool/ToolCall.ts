import { Context } from "./Context";
import { Hook } from "./Hook";
import { Message } from "../message";

import type { Tool } from "./Tool";

/**
 * 一次具体的函数调用实例
 *
 * 由Tool 模版的 create() 方法产生，
 * 走完整生命周期: BEFORE_EXECUTE → execute → AFTER_EXECUTE
 */
export class ToolCall {
  public readonly id: string;
  public readonly name: string;
  public readonly arguments: Record<string, unknown>;

  private _template: Tool;
  private _signal?: AbortSignal;
  private _result?: unknown;
  private _executed: boolean = false;
  private _error?: Error;
  private _ctx?: Context;

  constructor(
    template: Tool,
    id: string,
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal
  ) {
    this._template = template;
    this._signal = signal;
    this.id = id;
    this.name = name;
    this.arguments = args;
  }

  // ========================
  //  执行（完整生命周期）
  // ========================

  async execute(): Promise<unknown> {
    const ctx = this.getOrCreateContext();
    ctx.throwIfAborted();

    //---- BEFORE_EXECUTE ----
    this._template.fire(Hook.BEFORE_EXECUTE, ctx);
    ctx.throwIfAborted();
    if (ctx.cancelled) {
      throw new Error(`执行被取消: ${ctx.cancelReason}`);
    }

    // ---- execute ----
    try {
      this._result = await this._template.func(ctx.arguments, ctx);
      ctx.throwIfAborted();
      ctx.result = this._result;
      this._executed = true;

      // ---- AFTER_EXECUTE ----
      this._template.fire(Hook.AFTER_EXECUTE, ctx);
      this._result = ctx.result;
    } catch (e) {
      const error = e instanceof Error ? e : new Error(String(e));
      this._error = error;
      ctx.error = error;

      // ---- ON_ERROR ----
      this._template.fire(Hook.ON_ERROR, ctx);

      if (ctx.result !== undefined) {
        //钩子提供了降级结果
        this._result = ctx.result;
        this._executed = true;
      } else {
        throw error;
      }
    }

    return this._result;
  }

  // ========================
  //  序列化为 Message
  // ========================

  /**
   * 将执行结果序列化为 Message.tool()，回传给 LLM
   */
  toMessage(): Message {
    const ctx = this.getOrCreateContext();
    ctx.result = this._result;

    // ---- ON_SERIALIZE ----
    this._template.fire(Hook.ON_SERIALIZE, ctx);

    const content =
      typeof ctx.result === "string"
        ? ctx.result
        : JSON.stringify(ctx.result ?? null);

    return Message.tool(this.id, content);
  }

  // ========================
  //  状态 Getter
  // ========================

  get result(): unknown {
    if (!this._executed) {
      throw new Error("尚未执行，请先调用 execute()");
    }
    return this._result;
  }

  get isExecuted(): boolean {
    return this._executed;
  }

  get error(): Error | undefined {
    return this._error;
  }

  // ========================
  //  内部辅助
  // ========================

  /**
   * 获取或创建 Context
   *
   * 首次调用创建新的 Context 并缓存，后续调用复用同一实例，
   * 确保 BEFORE_EXECUTE → execute → AFTER_EXECUTE → ON_SERIALIZE
   * 整个生命周期共享同一个 Context。
   */
  private getOrCreateContext(): Context {
    if (!this._ctx) {
      this._ctx = new Context(this.id, this.name, { ...this.arguments }, this._signal);
    }
    return this._ctx;
  }
}