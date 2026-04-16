import { Message } from "../message/Message";
import { Rule } from "./Rule";

/** 生成唯一ID */
function generateInjectionId(): string {
  return (
    "inj-" +
    Date.now().toString(36) +
    "-" +
    Math.random().toString(36).slice(2, 8)
  );
}

/**
 * 注入实例— Rule + Message +生命周期 的绑定
 *
 * 每个 Injection 代表一次具体的"将某条消息按某条规则注入"的声明。
 * Rule 可复用，但每个 Injection 拥有独立的 life和 enabled 状态。
 *
 * 生命周期:
 *   life = -1  → 永久，每次 build 都注入，不递减
 *   life = N>0 → 剩余 N 次，每次 build 后递减
 *   life = 0   → 已过期，build 时跳过
 */
export class Injection {
  /**唯一标识 */
  public readonly id: string;

  /** 定位规则（引用，可复用） */
  public readonly rule: Rule;

  /** 要注入的消息 */
  public readonly message: Message;

  /** 手动启用/禁用开关 */
  public enabled: boolean = true;

  /** 生命周期剩余次数 */
  private _life: number;

  /** 触发概率（0~1），默认 1 表示必定触发 */
  private _probability: number = 1;

  /** 注册顺序（由PromptBuilder 分配） */
  private _sequence: number = 0;

  constructor(rule: Rule, message: Message, life: number = -1) {
    this.id = generateInjectionId();
    this.rule = rule;
    this.message = message;
    this._life = life;
  }

  // ========================
  //  生命周期
  // ========================

  /** 获取剩余生命值 */
  get life(): number {
    return this._life;
  }

  /** 是否存活（life !==0） */
  get isAlive(): boolean {
    return this._life !== 0;
  }

  /** 综合判断：存活且启用 */
  get isActive(): boolean {
    return this.isAlive && this.enabled;
  }

  // ========================
  //  概率触发
  // ========================

  /** 获取触发概率 */
  get probability(): number {
    return this._probability;
  }

  /** 设置触发概率（0~1），0=永不触发，1=必定触发 */
  set probability(p: number) {
    this._probability = Math.max(0, Math.min(1, p));
  }

  /**
   * 掷骰子判定本次是否触发
   *
   * 概率为 1 时必定返回 true（跳过随机数生成）
   * 概率为 0 时必定返回 false
   */
  rollTrigger(): boolean {
    if (this._probability >=1) return true;
    if (this._probability <= 0) return false;
    return Math.random() < this._probability;
  }

  /**
   * 消耗一次生命
   *
   * life > 0 时递减
   * life === -1（永久）时不变
   * life === 0 时不变（已过期）
   */
  consume(): void {
    if (this._life > 0) {
      this._life--;
    }
  }

  // ========================
  //  排序序号（内部使用）
  // ========================

  /** 获取注册顺序 */
  get sequence(): number {
    return this._sequence;
  }

  /** 设置注册顺序（由 PromptBuilder 调用） */
  set sequence(n: number) {
    this._sequence = n;
  }
}