/**
 * 生命周期上下文
 *
 * 在钩子之间传递，贯穿整个工具调用生命周期。
 * 钩子可以修改 arguments / result / cancelled 等字段来影响执行流程。
 */
export class Context {
  /** tool_call_id */
  public id: string;

  /** 工具名 */
  public name: string;

  /** 调用参数（钩子可修改） */
  public arguments: Record<string, unknown>;

  /** 执行结果（钩子可改写） */
  public result?: unknown;

  /** 执行异常 */
  public error?: Error;

  /** 是否取消执行 */
  public cancelled: boolean = false;

  /** 取消原因 */
  public cancelReason: string = "";

  /** 中断信号：用于工具内部响应 Agent abort / timeout */
  public signal?: AbortSignal;

  constructor(
    id: string,
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal
  ) {
    this.id = id;
    this.name = name;
    this.arguments = args;
    this.signal = signal;
  }

  /** 如果已中断则抛出中断原因 */
  throwIfAborted(): void {
    if (!this.signal?.aborted) return;
    const reason = (this.signal as AbortSignal & { reason?: unknown }).reason;
    if (reason instanceof Error) throw reason;
    throw new Error(reason !== undefined ? String(reason) : "Tool execution aborted");
  }

  /** 取消执行的便捷方法 */
  cancel(reason: string): this {
    this.cancelled = true;
    this.cancelReason = reason;
    return this;
  }
}