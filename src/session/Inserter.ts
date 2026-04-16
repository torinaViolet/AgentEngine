import { Message } from "../message/Message";
import { MessagePart } from "../message/MessagePart";
import { Role } from "../message/Role";
import { SearchCriteria,MatchMode, Priority } from "./SearchCriteria";
import { matchesCriteria, selectByPriority } from "./matchUtils";

/** 插入命令 */
interface InsertCommand {
  position: "before" | "after";
  /** 插入时光标指向的消息 */
  anchor: Message;
  /** 要插入的消息 */
  message: Message;
}

/**
 * 游标式插入器
 *
 * 通过移动光标定位插入点，支持光标前/后插入。
 * 所有插入操作先进入命令队列，调用 execute() 才会真正执行。
 * 执行后插入器报废，需要从Session 重新获取。
 *
 * 注意：插入器只能操作当前分支（root→cursor路径）。
 */
export class Inserter {
  private _branch: Message[];// 当前分支路径
  private _cursor: number;// 光标在分支中的索引
  private _commands: InsertCommand[] = [];
  private _expired: boolean = false;

  constructor(branch: Message[]) {
    if (branch.length === 0) {
      throw new Error("分支不能为空");
    }
    this._branch = [...branch];
    // 默认光标在最底部（最后一条消息）
    this._cursor = this._branch.length - 1;
  }

  // ========================
  //  光标移动
  // ========================

  /** 移动到顶部 */
  top(): this {
    this.guardExpired();
    this._cursor = 0;
    return this;
  }

  /** 移动到底部 */
  bottom(): this {
    this.guardExpired();
    this._cursor = this._branch.length - 1;
    return this;
  }

  /**
   * 偏移移动
   * @param offset 正数向下（向后），负数向上（向前）
   */
  move(offset: number): this {
    this.guardExpired();
    const next = this._cursor + offset;
    if (next < 0 || next >= this._branch.length) {
      throw new Error(
        `光标移动越界：当前=${this._cursor}, 偏移=${offset}, 范围=[0, ${this._branch.length - 1}]`
      );
    }
    this._cursor = next;
    return this;
  }

  /**
   * 直接锁定到某条消息（必须在当前分支上）
   */
  moveTo(message: Message): this {
    this.guardExpired();
    const index = this._branch.indexOf(message);
    if (index === -1) {
      throw new Error("目标消息不在当前分支上");
    }
    this._cursor = index;
    return this;
  }

  /**
   * 通过内容查找并移动光标
   */
  moveByContent(
    keywords: (string | RegExp)[],
    options?: {
      mode?: MatchMode;
      priority?: Priority;
      roles?: Role[];
    }
  ): this {
    this.guardExpired();
    const criteria: SearchCriteria = {
      content: keywords,
      mode: options?.mode,
      priority: options?.priority,
      roles: options?.roles,
    };
    const matches = this._branch.filter((msg) =>
      matchesCriteria(msg, criteria)
    );
    const target = selectByPriority(matches, criteria);
    if (!target) {
      throw new Error(`未找到匹配内容的消息: ${keywords}`);
    }
    this._cursor = this._branch.indexOf(target);
    return this;
  }

  /**
   * 通过标签查找并移动光标
   */
  moveByTags(
    tags: (string | RegExp)[],
    options?: {
      mode?: MatchMode;
      priority?: Priority;
      roles?: Role[];
    }
  ): this {
    this.guardExpired();
    const criteria: SearchCriteria = {
      tags,
      mode: options?.mode,
      priority: options?.priority,
      roles: options?.roles,
    };
    const matches = this._branch.filter((msg) =>
      matchesCriteria(msg, criteria)
    );
    const target = selectByPriority(matches, criteria);
    if (!target) {
      throw new Error(`未找到匹配标签的消息: ${tags}`);
    }
    this._cursor = this._branch.indexOf(target);
    return this;
  }

  // ========================
  //  插入操作（命令队列）
  // ========================

  /** 在光标后插入消息 */
  insertAfter(message: Message): this {
    this.guardExpired();
    this._commands.push({
      position: "after",
      anchor: this._branch[this._cursor],
      message,
    });
    return this;
  }

  /** 在光标前插入消息 */
  insertBefore(message: Message): this {
    this.guardExpired();
    this._commands.push({
      position: "before",
      anchor: this._branch[this._cursor],
      message,
    });
    return this;
  }

  // ---- 便捷插入方法 ----

  insertUserAfter(content: string | MessagePart | MessagePart[]): this {
    return this.insertAfter(Message.user(content));
  }

  insertUserBefore(content: string | MessagePart | MessagePart[]): this {
    return this.insertBefore(Message.user(content));
  }

  insertAssistantAfter(
    content: string | MessagePart | MessagePart[]
  ): this {
    return this.insertAfter(Message.assistant(content));
  }

  insertAssistantBefore(
    content: string | MessagePart | MessagePart[]
  ): this {
    return this.insertBefore(Message.assistant(content));
  }

  insertToolAfter(toolCallId: string, result: string): this {
    return this.insertAfter(Message.tool(toolCallId, result));
  }

  insertToolBefore(toolCallId: string, result: string): this {
    return this.insertBefore(Message.tool(toolCallId, result));
  }

  // ========================
  //  执行（事务提交）
  // ========================

  /**
   * 执行所有排队的插入操作，之后插入器报废。
   * 返回最后一个插入的消息（方便作为新cursor）。
   */
  execute(): Message | undefined {
    this.guardExpired();

    let lastInserted: Message | undefined;

    for (const cmd of this._commands) {
      if (cmd.position === "after") {
        // anchor 成为 message 的父节点（分支插入）
        cmd.anchor.append(cmd.message);
      } else {
        // before:在 anchor 和 anchor.parent 之间插入（嫁接式）
        const parent = cmd.anchor.parent;
        if (!parent) {
          throw new Error("不能在根节点之前插入");
        }

        const index = parent.children.indexOf(cmd.anchor);
        // 从parent断开 anchor
        parent.children.splice(index, 1);
        // parent → message
        cmd.message.parent = parent;
        parent.children.splice(index, 0, cmd.message);
        // message → anchor
        cmd.message.append(cmd.anchor);
      }

      lastInserted = cmd.message;
    }

    this._expired = true;
    this._commands = [];
    return lastInserted;
  }

  // ========================
  //  状态查询
  // ========================

  /** 光标当前指向的消息 */
  get current(): Message {
    return this._branch[this._cursor];
  }

  /** 光标在分支中的位置索引 */
  get position(): number {
    return this._cursor;
  }

  /** 当前分支长度 */
  get length(): number {
    return this._branch.length;
  }

  /** 是否已执行（报废） */
  get isExpired(): boolean {
    return this._expired;
  }

  /** 排队中的命令数量 */
  get pendingCount(): number {
    return this._commands.length;
  }

  // ========================
  //  防护
  // ========================

  private guardExpired(): void {
    if (this._expired) {
      throw new Error("插入器已执行过，请从Session重新获取");
    }
  }
}