import { Message } from "../message/Message";
import { MessagePart } from "../message/MessagePart";
import { Role } from "../message/Role";
import { Usage } from "../message/Usage";
import { Inserter } from "./Inserter";
import { Query } from "./Query";
import { Paginator } from "./Paginator";
import { traverseTree } from "./matchUtils";

/** 生成唯一ID */
function generateId(): string {
  return (
    Date.now().toString(36) +
    "-" +
    Math.random().toString(36).slice(2, 10)
  );
}

/**
 * 对话会话管理器
 *
 * 基于树结构管理消息，以System 消息为永恒根节点。
 * 支持分支对话、回退、插入器、查询器、Token统计。
 *
 * 用法:
 *const session = Session.create("你是AI助手");
 *   session.addUser("你好");
 *   const history = session.history();  // → [System, User("你好")]
 *   session.addAssistant(reply);
 *   session.rewind(someMsg);// 回退
 *   session.addUser("换个话题");// 自动分支
 */
export class Session {
  public readonly id: string;
  public title?: string;
  public readonly createdAt: Date;

  /** 永恒根节点（System消息） */
  public readonly root: Message;

  /** 当前指针（指向最新消息） */
  private _cursor: Message;

  private constructor(root: Message, id?: string) {
    this.id = id || generateId();
    this.createdAt = new Date();
    this.root = root;
    this._cursor = root;
  }

  // ========================
  //  创建
  // ========================

  /**
   * 创建新会话
   * @param systemPrompt 系统提示词（可选，为空则创建空System根节点）
   */
  static create(systemPrompt?: string): Session {
    const root = systemPrompt
      ? Message.system(systemPrompt)
      : Message.emptySystem();
    return new Session(root);
  }

  // ========================
  //  光标
  // ========================

  /** 获取当前光标指向的消息 */
  get cursor(): Message {
    return this._cursor;
  }

  // ========================
  //  对话便捷操作
  // ========================

  /**
   * 在cursor后追加 User消息，移动cursor
   */
  addUser(content: string | MessagePart | MessagePart[]): Message {
    const msg = Message.user(content);
    this._cursor.append(msg);
    this._cursor = msg;
    return msg;
  }

  /**
   * 在cursor后追加任意已构建的 Message，移动cursor
   *
   * 与 addUser/addAssistant 不同，此方法直接使用传入的 Message 对象，
   * 保留其所有 parts（多模态）、tags、metadata 等信息。
   *
   * @param message 已构建的 Message（任意角色）
   */
  addMessage(message: Message): Message {
    this._cursor.append(message);
    this._cursor = message;
    return message;
  }

  /**
   * 在cursor后追加 Assistant 消息，移动cursor
   * @param message 已构建的 Assistant 消息（可能带usage/model）
   */
  addAssistant(message: Message): Message {
    this._cursor.append(message);
    this._cursor = message;
    return message;
  }

  /**
   * 追加 Tool 结果消息（可能多条），cursor 停在最后一条
   */
  addTool(messages: Message[]): void {
    for (const msg of messages) {
      this._cursor.append(msg);
      this._cursor = msg;
    }
  }

  // ========================
  //  历史
  // ========================

  /**
   * 获取从root到cursor的完整对话路径
   * @param includeRoot 是否包含根节点（System消息），默认 true
   */
  history(includeRoot: boolean = true): Message[] {
    return this._cursor.getHistory(includeRoot);
  }

  /** 同history(true)，语义别名 */
  get messages(): Message[] {
    return this.history(true);
  }

  // ========================
  //  分支 & 回退
  // ========================

  /**
   * 将cursor回退到某条消息
   * （下次 addUser 会从这里分叉，自动产生新分支）
   */
  rewind(toMessage: Message): void {
    // 验证目标消息属于本树
    if (toMessage.root !== this.root) {
      throw new Error("目标消息不属于本会话");
    }
    this._cursor = toMessage;
  }

  /**
   * 获取所有叶子节点（所有分支的末端）
   */
  get allLeaves(): Message[] {
    const leaves: Message[] = [];
    const all = traverseTree(this.root);
    for (const node of all) {
      if (node.isLeaf) {
        leaves.push(node);
      }
    }
    return leaves;
  }

  /**
   * 获取所有分支路径
   */
  get branches(): Message[][] {
    return this.allLeaves.map((leaf) => leaf.getHistory(true));
  }

  // ========================
  //  子系统
  // ========================

  /**
   * 获取新的插入器（基于当前分支）
   */
  get inserter(): Inserter {
    const branch = this._cursor.getHistory(true);
    return new Inserter(branch);
  }

  /**
   * 获取查询器
   */
  get query(): Query {
    return new Query(this.root, () => this._cursor);
  }

  // ========================
  //  分页器
  // ========================

  /**
   * 获取当前路径上所有的分页器
   *
   * 沿 root→cursor 路径，找出所有 children.length > 1 的节点，
   * 为每个生成 Paginator。
   */
  get paginators(): Paginator[] {
    const path = this._cursor.getHistory(true);
    const result: Paginator[] = [];

    for (let i = 0; i < path.length; i++) {
      const node = path[i];
      if (node.children.length > 1) {
        // 当前路径经过的是哪个child？
        const nextInPath = path[i + 1];
        const currentIndex = nextInPath
          ? node.children.indexOf(nextInPath)
          : 0;

        result.push(
          new Paginator(node, currentIndex, (target) => {
            this._cursor = target;
          })
        );
      }
    }

    return result;
  }

  /**
   * 获取指定父节点的分页器
   *
   * @param parent 父节点（其 children 构成分页）
   * @returns Paginator 或 null（children <= 1 时无分页器）
   */
  paginator(parent: Message): Paginator | null {
    if (parent.children.length <= 1) {
      return null;
    }

    // 判断当前路径经过哪个child
    const path = this._cursor.getHistory(true);
    const parentIndex = path.indexOf(parent);
    let currentIndex = 0;

    if (parentIndex !== -1 && parentIndex + 1 < path.length) {
      const nextInPath = path[parentIndex + 1];
      const childIndex = parent.children.indexOf(nextInPath);
      if (childIndex !== -1) {
        currentIndex = childIndex;
      }
    }

    return new Paginator(parent, currentIndex, (target) => {
      this._cursor = target;
    });
  }

  // ========================
  //  系统提示词
  // ========================

  /** 获取系统提示词 */
  get systemPrompt(): string {
    return this.root.text;
  }

  /**
   * 修改系统提示词
   * （替换根节点的parts）
   */
  set systemPrompt(prompt: string) {
    this.root.parts.length = 0;
    if (prompt) {
      this.root.parts.push({ type: "text", text: prompt });
    }
  }

  // ========================
  //  清理
  // ========================

  /**
   * 清空对话：删除root所有子节点，root内容清空，cursor回到root
   */
  clear(): void {
    this.root.children.length = 0;
    this.root.parts.length = 0;
    this._cursor = this.root;
  }

  // ========================
  //  Token统计
  // ========================

  /**
   * 累计所有 Assistant 消息的 Usage
   * （遍历全树）
   */
  get totalUsage(): Usage {
    const all = traverseTree(this.root);
    let total = Usage.zero();
    for (const node of all) {
      if (node.usage) {
        total = total.add(node.usage);
      }
    }
    return total;
  }

  // ========================
  //  序列化 / 反序列化
  // ========================

  /**
   * 序列化为 JSON 安全对象
   *
   * 将整棵消息树序列化，同时记录 cursor 的路径以便恢复。
   * cursor 路径用 children 索引数组表示，如 [0, 2, 0] 表示
   * root → children[0] → children[2] → children[0]。
   */
  toJSON(): Record<string, unknown> {
    return {
      id: this.id,
      title: this.title,
      createdAt: this.createdAt.toISOString(),
      root: this.root.toJSON(),
      cursorPath: this.getCursorPath(),
    };
  }

  /**
   * 从 JSON 对象反序列化
   *
   * 重建完整的消息树和 cursor 位置。
   */
  static fromJSON(data: Record<string, unknown>): Session {
    const rootData = data.root as Record<string, unknown>;
    if (!rootData){
      throw new Error("序列化数据缺少 root 字段");
    }

    const root = Message.fromJSON(rootData);
    const session = new Session(root, data.id as string | undefined);

    if (data.title) session.title = data.title as string;
    if (data.createdAt) {
      (session as any).createdAt = new Date(data.createdAt as string);
    }

    // 恢复 cursor 位置
    const cursorPath = data.cursorPath as number[] | undefined;
    if (cursorPath && cursorPath.length > 0) {
      let node = root;
      for (const childIndex of cursorPath) {
        if (childIndex >= 0 && childIndex < node.children.length) {
          node = node.children[childIndex];
        } else {
          break; // 路径无效，停在最后有效位置
        }
      }
      session._cursor = node;
    }

    return session;
  }

  /**
   * 计算从root 到 cursor 的路径（children 索引数组）
   */
  private getCursorPath(): number[] {
    const path: number[] = [];
    let node = this._cursor;

    // 从cursor 回溯到 root，收集每一步的 child index
    while (node.parent) {
      const parent = node.parent;
      const index = parent.children.indexOf(node);
      path.unshift(index);
      node = parent;
    }

    return path;
  }
}