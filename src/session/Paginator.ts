import { Message } from "../message/Message";

/**
 * 分页器 — 在一组兄弟节点（分支）之间导航
 *
 * 分页器对应一个父节点的 children 列表（仅 children.length > 1 时有意义）。
 * 切换页面时自动沿"最左原则"将 Session 的 cursor 下沉到目标分支的最深处叶子。
 *
 * 用法:
 *   const pags = session.paginators;
 *   pags[0].next();// B1→ B2, cursor自动到B2最深处
 *   pags[0].goTo(2);      // 跳转到第3页
 */
export class Paginator {
  /** 这组兄弟节点的父节点 */
  public readonly parent: Message;

  /** cursor 更新回调（由 Session 注入） */
  private _onSwitch: (target: Message) => void;

  /** 当前选中的页码索引 */
  private _currentIndex: number;

  constructor(
    parent: Message,
    currentIndex: number,
    onSwitch: (target: Message) => void
  ) {
    this.parent = parent;
    this._currentIndex = currentIndex;
    this._onSwitch = onSwitch;
  }

  // ========================
  //  查询
  // ========================

  /** 所有页（即 parent.children，实时引用） */
  get pages(): Message[] {
    return this.parent.children;
  }

  /** 总页数 */
  get total(): number {
    return this.parent.children.length;
  }

  /** 当前页码（0-based） */
  get currentIndex(): number {
    return this._currentIndex;
  }

  /** 当前选中的页节点 */
  get current(): Message {
    return this.parent.children[this._currentIndex];
  }

  /** 是否有下一页 */
  get hasNext(): boolean {
    return this._currentIndex < this.total - 1;
  }

  /** 是否有上一页 */
  get hasPrev(): boolean {
    return this._currentIndex > 0;
  }

  // ========================
  //  导航
  // ========================

  /** 下一页 */
  next(): this {
    if (!this.hasNext) {
      throw new Error(
        `已是最后一页 (${this._currentIndex + 1}/${this.total})`
      );
    }
    return this.goTo(this._currentIndex + 1);
  }

  /** 上一页 */
  prev(): this {
    if (!this.hasPrev) {
      throw new Error(
        `已是第一页 (${this._currentIndex + 1}/${this.total})`
      );
    }
    return this.goTo(this._currentIndex - 1);
  }

  /** 跳转到第一页 */
  first(): this {
    return this.goTo(0);
  }

  /** 跳转到最后一页 */
  last(): this {
    return this.goTo(this.total - 1);
  }

  /**
   * 跳转到指定页码（0-based）
   *
   * 切换后沿"最左原则"将 cursor 下沉到目标分支的最深叶子节点。
   */
  goTo(index: number): this {
    if (index < 0 || index >= this.total) {
      throw new Error(
        `页码越界: index=${index}, 范围=[0, ${this.total - 1}]`
      );
    }

    this._currentIndex = index;
    const target = this.parent.children[index];

    // 最左原则：沿第一个子节点一路下沉到叶子
    const leaf = Paginator.leftmostLeaf(target);
    this._onSwitch(leaf);

    return this;
  }

  // ========================
  //  静态工具
  // ========================

  /**
   * 最左原则：从指定节点出发，不断取 children[0] 直到叶子
   */
  static leftmostLeaf(node: Message): Message {
    let current = node;
    while (current.children.length > 0) {
      current = current.children[0];
    }
    return current;
  }
}