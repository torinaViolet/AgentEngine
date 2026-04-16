import { Message } from "../message/Message";
import { Role } from "../message/Role";
import { MatchMode, SearchCriteria } from "../session/SearchCriteria";
import { matchesCriteria } from "../session/matchUtils";

/**
 * 锚点定位规格
 */
type AnchorSpec = | { type: "position"; value: "top" | "bottom" }
  | { type: "index"; value: number }
  | { type: "role"; role: Role; criteria?: Omit<SearchCriteria, "roles"> }
  | { type: "content"; keywords: (string | RegExp)[]; options?: { mode?: MatchMode; roles?: Role[] } }
  | { type: "tags"; tags: (string | RegExp)[]; options?: { mode?: MatchMode; roles?: Role[] } }
  | { type: "predicate"; fn: (msg: Message, index: number) => boolean };

/** 选择策略 */
type SelectMode = "first" | "last" | "all";

/** 插入方向 */
type Direction = "before" | "after";

/**
 * 声明式插入规则
 *
 * 描述"在哪里插入"，build 时才真正执行定位。
 * 规则无状态、可复用 — 同一条 Rule 可以绑定多条不同的 Message。
 *
 * 用法:
 *   Rule.top().after()                // 第一条消息之后
 *   Rule.byRole(Role.User).last().before()      // 最后一条 User 之前
 *   Rule.byTags(["ctx"]).all().after()           // 每条带ctx 标签的消息之后
 *   Rule.index(-1).before().order(5)             // 倒数第1条之前，排序权重5
 */
export class Rule {
  private _anchor: AnchorSpec;
  private _select: SelectMode = "last";
  private _direction: Direction = "after";
  private _offset: number = 0;
  private _order: number = 0;
  private _scanDepth?: number;
  private _scanDirection: "forward" | "reverse" = "reverse";

  private constructor(anchor: AnchorSpec) {
    this._anchor = anchor;
  }

  //========================
  //  静态工厂
  // ========================

  /** 定位到第一条消息 */
  static top(): Rule {
    return new Rule({ type: "position", value: "top" });
  }

  /** 定位到最后一条消息 */
  static bottom(): Rule {
    return new Rule({ type: "position", value: "bottom" });
  }

  /** 定位到第n 条（支持负索引，-1 为倒数第一） */
  static index(n: number): Rule {
    return new Rule({ type: "index", value: n });
  }

  /** 按角色定位 */
  static byRole(role: Role, options?: { mode?: MatchMode }): Rule {
    return new Rule({
      type: "role",
      role,
      criteria: options ? { mode: options.mode } : undefined,
    });
  }

  /** 按内容关键词/正则定位 */
  static byContent(
    keywords: (string | RegExp)[],
    options?: { mode?: MatchMode; roles?: Role[] }
  ): Rule {
    return new Rule({ type: "content", keywords, options });
  }

  /** 按标签定位 */
  static byTags(
    tags: (string | RegExp)[],
    options?: { mode?: MatchMode; roles?: Role[] }
  ): Rule {
    return new Rule({ type: "tags", tags, options });
  }

  /** 自定义谓词定位 */
  static by(fn: (msg: Message, index: number) => boolean): Rule {
    return new Rule({ type: "predicate", fn });
  }

  // ========================
  //  选择策略
  // ========================

  /** 取第一个匹配 */
  first(): this {
    this._select = "first";
    return this;
  }

  /** 取最后一个匹配（默认） */
  last(): this {
    this._select = "last";
    return this;
  }

  /** 所有匹配点都插入 */
  all(): this {
    this._select = "all";
    return this;
  }

  // ========================
  //  偏移
  // ========================

  /** 在定位结果上偏移 n 个位置（正数向后，负数向前） */
  offset(n: number): this {
    this._offset = n;
    return this;
  }

  // ========================
  //  插入方向
  // ========================

  /** 在锚点之前插入 */
  before(): this {
    this._direction = "before";
    return this;
  }

  /** 在锚点之后插入（默认） */
  after(): this {
    this._direction = "after";
    return this;
  }

  // ========================
  //  排序优先级
  // ========================

  /** 同位置多条注入时的排序，数字越小越靠前，默认 0 */
  order(n: number): this {
    this._order = n;
    return this;
  }

  // ========================
  //  扫描范围
  // ========================

  /**
   * 设置扫描深度（只扫描 N 条消息来匹配关键词/标签/谓词）
   *
   * 仅影响搜索型定位（byContent/byTags/byRole/by），
   * 不影响位置型定位（top/bottom/index）。
   * 默认不限制（扫描全部历史）。
   *
   * @param n 扫描条数
   */
  scanDepth(n: number): this {
    this._scanDepth = n;
    return this;
  }

  /** 正向扫描 — 从顶部开始扫描 scanDepth 条 */
  scanForward(): this {
    this._scanDirection = "forward";
    return this;
  }

  /** 反向扫描 — 从底部开始扫描 scanDepth 条（默认） */
  scanReverse(): this {
    this._scanDirection = "reverse";
    return this;
  }

  // ========================
  //  查询（供PromptBuilder 使用）
  // ========================

  /** 获取排序权重 */
  get orderValue(): number {
    return this._order;
  }

  // ========================
  //  解析（核心）
  // ========================

  /**
   * 在给定的messages 数组中解析出所有插入索引
   *
   * 返回的索引可直接用于 splice(index, 0, msg) 插入。
   * 找不到匹配时返回空数组（静默跳过）。
   *
   * @param messages 原始消息数组
   * @returns 插入位置索引数组（已去重、升序）
   */
  resolve(messages: Message[]): number[] {
    if (messages.length === 0) return [];

    // 第一步：找出所有匹配的锚点索引
    const anchorIndices = this.findAnchors(messages);
    if (anchorIndices.length === 0) return [];

    // 第二步：应用选择策略
    const selected = this.applySelect(anchorIndices);

    // 第三步：应用偏移 + 方向，转换为插入索引
    const insertIndices: number[] = [];
    for (const anchorIdx of selected) {
      const offsetIdx = anchorIdx + this._offset;

      // 边界检查（偏移后超出范围则跳过）
      if (offsetIdx < 0 || offsetIdx >= messages.length) continue;

      const insertIdx =
        this._direction === "after" ? offsetIdx + 1 : offsetIdx;

      // 限制在[0, messages.length] 范围内
      const clamped = Math.max(0, Math.min(messages.length, insertIdx));
      insertIndices.push(clamped);
    }

    // 去重 + 升序
    return [...new Set(insertIndices)].sort((a, b) => a - b);
  }

  // ========================
  //  内部：锚点查找
  // ========================

  private findAnchors(messages: Message[]): number[] {
    const anchor = this._anchor;

    switch (anchor.type) {
      // 位置型定位 — 不受扫描范围影响
      case "position":
        if (anchor.value === "top") return [0];
        return [messages.length - 1];

      case "index": {
        const idx =
          anchor.value < 0
            ? messages.length + anchor.value
            : anchor.value;
        if (idx < 0 || idx >= messages.length) return [];
        return [idx];
      }

      // 搜索型定位 — 受扫描范围影响
      case "role": {
        const criteria: SearchCriteria = {
          roles: [anchor.role],
          ...anchor.criteria,
        };
        const [start, end] = this.getScanRange(messages.length);
        return this.matchInRange(messages, start, end, (msg) =>
          matchesCriteria(msg, criteria)
        );
      }

      case "content": {
        const criteria: SearchCriteria = {
          content: anchor.keywords,
          mode: anchor.options?.mode,
          roles: anchor.options?.roles,
        };
        const [start, end] = this.getScanRange(messages.length);
        return this.matchInRange(messages, start, end, (msg) =>
          matchesCriteria(msg, criteria)
        );
      }

      case "tags": {
        const criteria: SearchCriteria = {
          tags: anchor.tags,
          mode: anchor.options?.mode,
          roles: anchor.options?.roles,
        };
        const [start, end] = this.getScanRange(messages.length);
        return this.matchInRange(messages, start, end, (msg) =>
          matchesCriteria(msg, criteria)
        );
      }

      case "predicate": {
        const [start, end] = this.getScanRange(messages.length);
        return this.matchInRange(messages, start, end, (msg, i) =>
          anchor.fn(msg, i)
        );
      }
    }
  }

  // ========================
  //  内部：扫描范围
  // ========================

  /**
   * 计算扫描范围 [start, end)
   */
  private getScanRange(totalLength: number): [number, number] {
    if (this._scanDepth === undefined) {
      return [0, totalLength];
    }
    if (this._scanDirection === "forward") {
      return [0, Math.min(this._scanDepth, totalLength)];
    } else {
      return [Math.max(0, totalLength - this._scanDepth), totalLength];
    }
  }

  /**
   * 在指定范围内匹配，返回绝对索引
   */
  private matchInRange(
    messages: Message[],
    start: number,
    end: number,
    predicate: (msg: Message, index: number) => boolean
  ): number[] {
    const results: number[] = [];
    for (let i = start; i < end; i++) {
      if (predicate(messages[i], i)) {
        results.push(i);
      }
    }
    return results;
  }

  // ========================
  //  内部：选择策略
  // ========================

  private applySelect(indices: number[]): number[] {
    switch (this._select) {
      case "first":
        return [indices[0]];
      case "last":
        return [indices[indices.length - 1]];
      case "all":
        return indices;
    }
  }
}