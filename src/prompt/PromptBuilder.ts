import { Message } from "../message/Message";
import { MessagePart } from "../message/MessagePart";
import { Role } from "../message/Role";
import { Rule } from "./Rule";
import { Injection } from "./Injection";

/** 注入配置选项 */
export interface InjectOptions {
  /** 生命周期，默认 -1（永久） */
  life?: number;
  /** 触发概率（0~1），默认 1（必定触发） */
  probability?: number;
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
   * @param options 注入配置（life / probability）或直接传 life数字
   * @returns 创建的 Injection 实例（可用于后续管理）
   */
  inject(rule: Rule, message: Message, options?: InjectOptions | number): Injection {
    const opts = this.normalizeOptions(options);
    const injection = new Injection(rule, message, opts.life ?? -1);
    if (opts.probability !== undefined) {
      injection.probability = opts.probability;
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
    return this.inject(rule, Message.system(
      typeof content === "string" ? content : ""
    ), options);
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
  clear(): this {
    this._injections = [];
    this._sequenceCounter = 0;
    return this;
  }

  // ========================
  //  核心：构建
  // ========================

  /**
   * 输入原始历史，输出注入后的最终上下文
   *
   * 流程：
   * 1. 浅拷贝 history 数组
   * 2.筛选所有 isActive 的 Injection
   * 3. 每个 Injection 的 Rule 在数组中 resolve出插入索引
   * 4. 收集所有 InsertOp，按索引降序排列（从后往前插入避免偏移）
   * 5. 执行插入
   * 6. 消耗 life
   * 7. 返回新数组
   *
   * @param history 原始消息数组（不会被修改）
   * @returns 注入后的新消息数组
   */
  build(history: Message[]): Message[] {
    const result = [...history];

    // 筛选存活且启用的注入，并掷骰子判定概率触发
    const activeInjections = this._injections.filter(
      (inj) => inj.isActive && inj.rollTrigger()
    );
    if (activeInjections.length === 0) return result;

    // 收集所有插入操作
    const ops: InsertOp[] = [];

    for (const injection of activeInjections) {
      const indices = injection.rule.resolve(result);

      for (const index of indices) {
        ops.push({
          index,
          message: injection.message,
          order: injection.rule.orderValue,
          sequence: injection.sequence,
        });
      }
    }

    if (ops.length === 0) return result;

    // 排序策略：
    // 1. 按插入索引降序（从后往前插入，避免索引偏移）
    // 2. 同索引时，按 order 降序 + sequence 降序
    //    因为同位置 splice 时后处理的会插到前面，
    //    所以 order 大的先处理（排前面），最终 order 小的在上面
    ops.sort((a, b) => {
      if (a.index !== b.index) return b.index - a.index; // 降序
      if (a.order !== b.order) return b.order - a.order; // 降序
      return b.sequence - a.sequence; // 降序
    });

    // 从后往前插入
    for (const op of ops) {
      result.splice(op.index, 0, op.message);
    }

    // 消耗生命
    for (const injection of activeInjections) {
      injection.consume();
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
}