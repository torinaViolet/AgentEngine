import { Message } from "../message/Message";
import { MessagePart } from "../message/MessagePart";
import { Role } from "../message/Role";
import { Rule } from "./Rule";
import { Injection } from "./Injection";

/**
 * 数组操作函数
 *
 * 接收当前消息数组，返回处理后的新数组。
 *PromptBuilder 在 build 时按注册顺序依次执行。
 */
export type Operation = (messages: Message[]) => Message[];

/** 注入配置选项 */
export interface InjectOptions {
  /** 生命周期，默认 -1（永久） */
  life?: number;
  /** 触发概率（0~1），默认 1（必定触发） */
  probability?: number;
  /**
   * Injection 执行优先级，默认 0。
   *
   * 数值越小越早执行；相同 priority 时按注册顺序执行。
   * 注意：它控制的是注入的执行/定位顺序，不是同一插入点的展示顺序。
   * 同一位置的展示顺序仍由 Rule.order() 控制。
   */
  priority?: number;
}

/** PromptBuilder 注入构建策略 */
export type BuildStrategy = "batch" | "immediate";

/** 构建配置选项 */
export interface BuildOptions {
  /**
   * 注入策略：
   * - batch：批量插入，所有 Injection 都基于原始 history 定位（默认，兼容旧行为）
   * - immediate：即时插入，后续 Injection 可以看到前序 Injection 已插入的消息
   */
  strategy?: BuildStrategy;
}

/**
 * 待插入操作（内部使用）
 * 在 build 过程中收集所有插入操作，最后统一执行
 */
interface InsertOp {
  /** 插入位置索引 */
  index: number;
  /** 要插入的消息 */
  message: Message;
  /** Rule 的排序权重 */
  order: number;
  /** 注册顺序（同order时的稳定排序依据） */
  sequence: number;
}

/**
 * 提示词构建器
 *
 * 管理一组 Injection（注入声明），在 build 时将它们按规则插入到
 * 历史消息数组中，产出最终的上下文列表。
 *
 * 核心特性：
 * - 不修改原始history 数组和 Message 对象
 * - 声明式：Rule描述定位，build 时才执行
 * - 生命周期：每次 build 自动消耗 life
 * - 可复用：同一 Rule 可绑定多条不同 Message
 *
 * 用法:
 *   const builder = new PromptBuilder();
 *   builder.injectSystem(Rule.top().after(), "当前时间：2025年");
 *   builder.injectSystem(Rule.byRole(Role.User).last().before(), "请用英文",3);
 *
 *   const context = builder.build(session.history());
 *   // context包含注入后的完整上下文，可直接传给Adapter
 */
export class PromptBuilder {
  private _injections: Injection[] = [];
  private _sequenceCounter: number = 0;

  // ========================
  //  注册注入
  // ========================

  /**
   * 注入一条消息
   *
   * @param rule 定位规则
   * @param message 要注入的 Message
   * @param options 注入配置（life / probability / priority）或直接传 life数字
   * @returns 创建的 Injection 实例（可用于后续管理）
   */
  inject(rule: Rule, message: Message, options?: InjectOptions | number): Injection {
    const opts = this.normalizeOptions(options);
    const injection = new Injection(rule, message, opts.life ?? -1);
    if (opts.probability !== undefined) {
      injection.probability = opts.probability;
    }
    if (opts.priority !== undefined) {
      injection.priority = opts.priority;
    }
    injection.sequence = this._sequenceCounter++;
    this._injections.push(injection);
    return injection;
  }

  // ---- 便捷方法：自动创建指定角色的 Message ----

  /**
   * 注入一条 System 消息
   */
  injectSystem(
    rule: Rule,
    content: string | MessagePart | MessagePart[],
    options?: InjectOptions | number
  ): Injection {
    return this.inject(rule, this.createSystemMessage(content), options);
  }

  /**
   * 注入一条 User 消息
   */
  injectUser(
    rule: Rule,
    content: string | MessagePart | MessagePart[],
    options?: InjectOptions | number
  ): Injection {
    return this.inject(rule, Message.user(content), options);
  }

  /**
   * 注入一条 Assistant 消息
   */
  injectAssistant(
    rule: Rule,
    content: string | MessagePart | MessagePart[],
    options?: InjectOptions | number
  ): Injection {
    return this.inject(rule, Message.assistant(content), options);
  }

  /**
   * 批量注入：同一规则，多条消息，各自独立生命周期
   */
  injectAll(
    rule: Rule,
    messages: Message[],
    options?: InjectOptions | number
  ): Injection[] {
    return messages.map((msg) => this.inject(rule, msg, options));
  }

  // ========================
  //  管理
  // ========================

  /** 移除某个注入 */
  remove(injection: Injection): this {
    const index = this._injections.indexOf(injection);
    if (index !== -1) {
      this._injections.splice(index, 1);
    }
    return this;
  }

  /** 按ID 移除 */
  removeById(id: string): this {
    const index = this._injections.findIndex((inj) => inj.id === id);
    if (index !== -1) {
      this._injections.splice(index, 1);
    }
    return this;
  }

  /** 移除某规则关联的所有注入 */
  removeByRule(rule: Rule): this {
    this._injections = this._injections.filter((inj) => inj.rule !== rule);
    return this;
  }

  /** 启用某个注入 */
  enable(injection: Injection): this {
    injection.enabled = true;
    return this;
  }

  /** 禁用某个注入（不消耗 life） */
  disable(injection: Injection): this {
    injection.enabled = false;
    return this;
  }

  /** 清理所有 life === 0 的过期注入 */
  prune(): this {
    this._injections = this._injections.filter((inj) => inj.isAlive);
    return this;
  }

  /** 清空所有注入 */
  clearInjections(): this {
    this._injections = [];
    this._sequenceCounter = 0;
    return this;
  }

  /** 清空所有注入（别名） */
  clear(): this {
    return this.clearInjections();
  }

  // ========================
  //  数组操作
  // ========================

  /** 操作管线 */
  private _operations: { op: Operation; label?: string }[] = [];

  /**
   * 注册一个数组操作
   *
   * 操作在 build 时按注册顺序执行（在注入之后）。
   * 每个操作接收当前 Message[]，返回新的 Message[]。
   *
   * @param op 操作函数
   * @param label 可选标签，用于后续查找/移除
   * @returns this（链式）
   *
   * 用法:
   *   builder.use(msgs => msgs.filter(m => !m.hasTag("debug")));
   *   builder.use(msgs => msgs.slice(-20), "keep_recent");
   */
  use(op: Operation, label?: string): this {
    this._operations.push({ op, label });
    return this;
  }

  /**
   * 在指定位置插入消息
   *
   * @param index 插入位置（支持负索引，-1 表示末尾之前）
   * @param message 要插入的消息
   * @param label 可选标签
   *
   * 用法:
   *   builder.insertAt(1, Message.system("提示"));  // 第二条之前插入
   *   builder.insertAt(-1, Message.user("补充"));   // 倒数第一条之前
   */
  insertAt(
    index: number,
    message: Message | Message[],
    label?: string
  ): this {
    const msgs = Array.isArray(message) ? message : [message];
    return this.use((arr) => {
      const result = [...arr];
      const resolvedIndex = index < 0 ? Math.max(0, result.length + index + 1) : Math.min(index, result.length);
      result.splice(resolvedIndex, 0, ...msgs);
      return result;
    }, label);
  }

  /**
   * 移除指定位置的消息
   *
   * @param index 位置（支持负索引）
   * @param count 移除数量，默认 1
   * @param label 可选标签
   */
  removeAt(index: number, count: number = 1, label?: string): this {
    return this.use((arr) => {
      const result = [...arr];
      const resolvedIndex = index < 0 ? result.length + index : index;
      if (resolvedIndex >= 0 && resolvedIndex < result.length) {
        result.splice(resolvedIndex, count);
      }
      return result;
    }, label);
  }

  /**
   * 按条件移除消息
   *
   * @param predicate 条件函数，返回 true 的消息将被移除
   * @param label 可选标签
   *
   * 用法:
   *   builder.removeWhere(m => m.hasTag("debug"));
   *   builder.removeWhere((m, i) => i > 20);
   */
  removeWhere(
    predicate: (msg: Message, index: number) => boolean,
    label?: string
  ): this {
    return this.use((arr) => arr.filter((msg, i) => !predicate(msg, i)), label);
  }

  /**
   * 按条件替换消息
   *
   * @param predicate 条件函数
   * @param replacer 替换函数，返回新消息（返回 null 则移除该消息）
   * @param label 可选标签
   *
   * 用法:
   *   builder.replaceWhere(
   *     m => m.role === Role.System,
   *     m => Message.system(m.text + "\n附加指令")
   *   );
   */
  replaceWhere(
    predicate: (msg: Message, index: number) => boolean,
    replacer: (msg: Message, index: number) => Message | null,
    label?: string
  ): this {
    return this.use((arr) => {
      const result: Message[] = [];
      for (let i = 0; i < arr.length; i++) {
        if (predicate(arr[i], i)) {
          const replacement = replacer(arr[i], i);
          if (replacement !== null) result.push(replacement);
        } else {
          result.push(arr[i]);
        }
      }
      return result;
    }, label);
  }

  /**
   * 保留满足条件的消息（过滤）
   *
   * @param predicate 条件函数，返回 true 的消息保留
   * @param label 可选标签
   *
   * 用法:
   *   builder.filter(m => m.role !== Role.System || m.text.length > 0);
   */
  filter(
    predicate: (msg: Message, index: number) => boolean,
    label?: string
  ): this {
    return this.use((arr) => arr.filter(predicate), label);
  }

  /**
   * 截取消息数组的子集
   *
   * @param start 起始位置（支持负索引）
   * @param end 结束位置（可选，支持负索引）
   * @param label 可选标签
   *
   * 用法:
   *   builder.slice(-10);// 只保留最近 10 条
   *   builder.slice(0, 5);      // 只保留前 5 条
   */
  slice(start: number, end?: number, label?: string): this {
    return this.use((arr) => arr.slice(start, end), label);
  }

  /**
   * 映射变换消息
   *
   * @param fn 映射函数
   * @param label 可选标签
   */
  map(
    fn: (msg: Message, index: number) => Message,
    label?: string
  ): this {
    return this.use((arr) => arr.map(fn), label);
  }

  /**
   * 自由变换 — 最灵活的操作
   *
   * @param fn 变换函数，接收完整数组返回新数组
   * @param label 可选标签
   *
   * 用法:
   *   builder.transform(msgs => {
   *     // 自定义上下文窗口管理
   *     const system = msgs.filter(m => m.role === Role.System);
   *     const recent = msgs.filter(m => m.role !== Role.System).slice(-10);
   *return [...system, ...recent];
   *   }, "window");
   */
  transform(fn: Operation, label?: string): this {
    return this.use(fn, label);
  }

  /**
   * 按标签移除操作
   */
  removeOperation(label: string): this {
    this._operations = this._operations.filter((o) => o.label !== label);
    return this;
  }

  /**
   * 清空所有操作
   */
  clearOperations(): this {
    this._operations = [];
    return this;
  }

  /** 所有操作（只读视图） */
  get operations(): readonly { op: Operation; label?: string }[] {
    return this._operations;
  }

  // ========================
  //  核心：构建
  // ========================

  /**
   * 输入原始历史，输出注入后的最终上下文
   *
   * 流程（默认 batch 策略）：
   * 1. 浅拷贝 history 数组
   * 2. 筛选所有 isActive 且通过概率判定的 Injection
   * 3. 每个 Injection 的 Rule 都在同一份原始数组上 resolve 出插入索引
   * 4. 收集所有 InsertOp，按索引降序排列（从后往前插入避免偏移）
   * 5. 执行插入
   * 6. 消耗 life
   * 7. 执行数组操作管线
   * 8. 返回新数组
   *
   * immediate 策略会按 Injection.priority 从小到大逐条执行 Injection；
   * 相同 priority 时按注册顺序执行。
   * 前一条 Injection 插入的消息，会进入后一条 Injection 的 Rule 定位范围。
   * 同一个 Injection 内部只 resolve 一次，不会递归匹配自己刚插入的消息。
   *
   * @param history 原始消息数组（不会被修改）
   * @param options 构建选项，strategy 默认为 "batch"
   * @returns 注入 + 操作后的新消息数组
   */
  build(history: Message[], options?: BuildOptions): Message[] {
    const strategy = options?.strategy ?? "batch";
    return strategy === "immediate"
      ? this.buildImmediateInternal(history)
      : this.buildBatch(history);
  }

  /**
   * 即时构建：后续 Injection 可以看到前序 Injection 的插入结果。
   *
   * 等价于：build(history, { strategy: "immediate" })
   */
  buildImmediate(history: Message[]): Message[] {
    return this.buildImmediateInternal(history);
  }

  /**
   * 批量构建：所有 Injection 都基于原始 history 定位。
   *
   * 等价于：build(history, { strategy: "batch" })，也是默认行为。
   */
  buildBatch(history: Message[]): Message[] {
    let result = [...history];

    // ---- 阶段 1：执行声明式注入（批量定位，统一插入） ----
    const activeInjections = this.getTriggeredInjections();

    if (activeInjections.length > 0) {
      const ops: InsertOp[] = [];

      for (const injection of activeInjections) {
        ops.push(...this.createInsertOps(injection, result));
      }

      this.applyInsertOps(result, ops);

      // 消耗生命：保持旧语义，只要本次通过概率判定，即使没有匹配到位置也消耗
      for (const injection of activeInjections) {
        injection.consume();
      }
    }

    return this.applyOperations(result);
  }

  private buildImmediateInternal(history: Message[]): Message[] {
    let result = [...history];

    // ---- 阶段 1：执行声明式注入（逐条定位，立即插入） ----
    const activeInjections = this.getTriggeredInjections();

    for (const injection of activeInjections) {
      const ops = this.createInsertOps(injection, result);
      this.applyInsertOps(result, ops);

      // 保持与 batch 一致：只要本次通过概率判定，即使没有匹配到位置也消耗
      injection.consume();
    }

    return this.applyOperations(result);
  }

  private getTriggeredInjections(): Injection[] {
    return [...this._injections]
      .filter((inj) => inj.isActive)
      .sort((a, b) => {
        if (a.priority !== b.priority) return a.priority - b.priority;
        return a.sequence - b.sequence;
      })
      .filter((inj) => inj.rollTrigger());
  }

  private createInsertOps(injection: Injection, messages: Message[]): InsertOp[] {
    const indices = injection.rule.resolve(messages);
    return indices.map((index) => ({
      index,
      message: injection.message,
      order: injection.rule.orderValue,
      sequence: injection.sequence,
    }));
  }

  private applyInsertOps(result: Message[], ops: InsertOp[]): void {
    if (ops.length === 0) return;

    // O(n + k log k)：升序排序后单次扫描构建新数组
    // 排序规则：
    // 1. 按插入索引升序
    // 2. 同索引时按 order 升序、sequence 升序 —— 在该位置先 push 的排在前面
    ops.sort((a, b) => {
      if (a.index !== b.index) return a.index - b.index;
      if (a.order !== b.order) return a.order - b.order;
      return a.sequence - b.sequence;
    });

    const merged: Message[] = new Array(result.length + ops.length);
    let writeIdx = 0;
    let opIdx = 0;

    for (let i = 0; i <= result.length; i++) {
      // 先把所有 index === i 的 ops 按序写入
      while (opIdx < ops.length && ops[opIdx].index === i) {
        merged[writeIdx++] = ops[opIdx].message;
        opIdx++;
      }
      if (i < result.length) {
        merged[writeIdx++] = result[i];
      }
    }

    // 兜底：若有 op.index 越界（>result.length），追加到末尾
    while (opIdx < ops.length) {
      merged[writeIdx++] = ops[opIdx].message;
      opIdx++;
    }

    // 原地替换，避免外部引用失效
    result.length = 0;
    for (let i = 0; i < writeIdx; i++) result.push(merged[i]);
  }

  private applyOperations(messages: Message[]): Message[] {
    let result = messages;

    // ---- 阶段 2：执行数组操作管线 ----
    for (const { op } of this._operations) {
      result = op(result);
    }

    return result;
  }

  // ========================
  //  查询
  // ========================

  /** 所有注入（只读视图） */
  get injections(): readonly Injection[] {
    return this._injections;
  }

  /** 存活注入数*/
  get aliveCount(): number {
    return this._injections.filter((inj) => inj.isAlive).length;
  }

  /** 过期注入数 */
  get expiredCount(): number {
    return this._injections.filter((inj) => !inj.isAlive).length;
  }

  /** 当前活跃注入数（存活且启用） */
  get activeCount(): number {
    return this._injections.filter((inj) => inj.isActive).length;
  }

  /** 按规则查找注入 */
  findByRule(rule: Rule): Injection[] {
    return this._injections.filter((inj) => inj.rule === rule);
  }

  /** 按 ID 查找注入 */
  findById(id: string): Injection | undefined {
    return this._injections.find((inj) => inj.id === id);
  }

  // ========================
  //  内部辅助
  // ========================

  private normalizeOptions(options?: InjectOptions | number): InjectOptions {
    if (options === undefined) return {};
    if (typeof options === "number") return { life: options };
    return options;
  }

  private createSystemMessage(content: string | MessagePart | MessagePart[]): Message {
    if (typeof content === "string") {
      return Message.system(content);
    }
    return new Message(
      Role.System,
      Array.isArray(content) ? content : [content]
    );
  }
}