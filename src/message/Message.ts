import { Role } from "./Role";
import { Usage } from "./Usage";
import {
  MessagePart,
  TextPart,
  ImagePart,
  AudioPart,
  FilePart,
  ToolCallPart,
  ToolResultPart,
  ThinkingPart,
} from "./MessagePart";

/**
 * 统一消息模型
 *
 * 支持多模态内容（文本/图片/音频/文件/工具调用），
 * 树结构管理（parent/children），标签系统，token统计。
 * 通过链式 API 构建，通过 Adapter 序列化为各平台格式。
 */
export class Message {
  public readonly role: Role;
  public readonly parts: MessagePart[];
  public readonly metadata: Record<string, unknown>;

  // === 模型 & 用量 ===
  public model?: string;
  public usage?: Usage;

  // === 标签系统 ===
  public readonly tags: Set<string> = new Set();

  // === 树结构 ===
  public parent?: Message;
  public readonly children: Message[] = [];

  // === Getter 缓存（懒计算，parts 变更时通过 addX 方法失效；
  //     如直接 push parts，请手动调用 invalidateCache()） ===
  private _textCache?: string;
  private _thinkingCache?: string;
  private _toolCallsCache?: ToolCallPart[];
  private _hasMediaCache?: boolean;
  private _hasThinkingCache?: boolean;

  constructor(
    role: Role,
    parts: MessagePart[] = [],
    metadata: Record<string, unknown> = {}
  ) {
    this.role = role;
    this.parts = parts;
    this.metadata = metadata;
  }

  // ========================
  //  静态工厂方法
  // ========================

  /**
   * 创建 User 消息
   * @param content 字符串、单个Part、或Part数组
   */
  static user(content: string | MessagePart | MessagePart[]): Message {
    return new Message(Role.User, Message.normalizeParts(content));
  }

  /**
   * 创建 Assistant 消息
   */
  static assistant(content: string | MessagePart | MessagePart[]): Message {
    return new Message(Role.Assistant, Message.normalizeParts(content));
  }

  /**
   * 创建 System 消息
   */
  static system(content: string): Message {
    return new Message(Role.System, [{ type: "text", text: content }]);
  }

  /**
   * 创建空System 消息（用作树的永恒根节点）
   */
  static emptySystem(): Message {
    return new Message(Role.System, []);
  }

  /**
   * 创建 Tool Result 消息
   */
  static tool(toolCallId: string, result: string, name?: string): Message {
    return new Message(Role.Tool, [
      { type: "tool_result", toolCallId, result, ...(name ? { name } : {}) },
    ], name ? { toolName: name } : {});
  }

  /**
   * 创建 Assistant 发起的工具调用消息
   */
  static assistantToolCalls(
    toolCalls: { id: string; name: string; arguments: string }[]
  ): Message {
    const parts: ToolCallPart[] = toolCalls.map((tc) => ({
      type: "tool_call" as const,
      toolCallId: tc.id,
      name: tc.name,
      arguments: tc.arguments,
    }));
    return new Message(Role.Assistant, parts);
  }

  // ========================
  //  链式构建方法
  // ========================

  addText(text: string): this {
    this.parts.push({ type: "text", text });
    return this.invalidateCache();
  }

  addImage(url: string, mimeType?: string): this {
    const part: ImagePart = { type: "image", url };
    if (mimeType) part.mimeType = mimeType;
    this.parts.push(part);
    return this.invalidateCache();
  }

  addAudio(url: string, mimeType?: string): this {
    const part: AudioPart = { type: "audio", url };
    if (mimeType) part.mimeType = mimeType;
    this.parts.push(part);
    return this.invalidateCache();
  }

  addFile(
    url: string,
    options?: { mimeType?: string; fileName?: string }
  ): this {
    const part: FilePart = { type: "file", url };
    if (options?.mimeType) part.mimeType = options.mimeType;
    if (options?.fileName) part.fileName = options.fileName;
    this.parts.push(part);
    return this.invalidateCache();
  }

  /** 替换消息的全部内容，并自动失效 getter 缓存。 */
  setParts(content: string | MessagePart | MessagePart[]): this {
    const parts = Message.normalizeParts(content);
    this.parts.splice(0, this.parts.length, ...parts);
    return this.invalidateCache();
  }

  /**
   * 替换消息中的全部文本，同时保留 thinking、媒体和工具调用等非文本 part。
   * 多个 TextPart 会合并为一个；空字符串会移除全部 TextPart。
   */
  setText(text: string): this {
    const firstTextIndex = this.parts.findIndex((part) => part.type === "text");

    if (firstTextIndex === -1) {
      if (text) this.parts.push({ type: "text", text });
      return this.invalidateCache();
    }

    const nextParts: MessagePart[] = [];
    let inserted = false;
    for (const part of this.parts) {
      if (part.type !== "text") {
        nextParts.push(part);
        continue;
      }
      if (!inserted && text) {
        nextParts.push({ type: "text", text });
        inserted = true;
      }
    }

    this.parts.splice(0, this.parts.length, ...nextParts);
    return this.invalidateCache();
  }

  setMeta(key: string, value: unknown): this {
    this.metadata[key] = value;
    return this;
  }

  // ========================
  //  标签系统
  // ========================

  /** 添加标签（链式） */
  tag(...tagNames: string[]): this {
    for (const t of tagNames) {
      this.tags.add(t);
    }
    return this;
  }

  /** 移除标签（链式） */
  untag(...tagNames: string[]): this {
    for (const t of tagNames) {
      this.tags.delete(t);
    }
    return this;
  }

  /** 是否有某标签 */
  hasTag(tagName: string): boolean {
    return this.tags.has(tagName);
  }

  // ========================
  //  树结构操作
  // ========================

  /**
   * 追加子节点，设置 parent 关系，返回 child
   */
  append(child: Message): Message {
    if (child === this) {
      throw new Error("消息不能追加到自身");
    }

    let ancestor: Message | undefined = this;
    while (ancestor) {
      if (ancestor === child) {
        throw new Error("不能将祖先消息追加为子节点");
      }
      ancestor = ancestor.parent;
    }

    if (child.parent === this && this.children.includes(child)) {
      return child;
    }

    if (child.parent) {
      const previousParent = child.parent;
      const previousIndex = previousParent.children.indexOf(child);
      if (previousIndex !== -1) {
        previousParent.children.splice(previousIndex, 1);
      }
    }

    child.parent = this;
    this.children.push(child);
    return child;
  }

  /**
   * 删除自身节点
   *
   * @param mode
   * - "prune": 剪枝 — 删除自身及所有后代
   * - "graft": 嫁接 — 删除自身，子节点继承父节点
   *
   * 根节点不可删除，尝试删除会抛异常
   */
  remove(mode: "prune" | "graft"): void {
    if (this.isRoot) {
      throw new Error("根节点不可删除");
    }

    const parent = this.parent!;
    const index = parent.children.indexOf(this);
    if (index === -1) return;

    if (mode === "prune") {
      // 剪枝：从父节点移除自身（含所有后代）
      parent.children.splice(index, 1);
      this.parent = undefined;
    } else {
      // 嫁接：子节点继承父节点
      const children = [...this.children];
      for (const child of children) {
        child.parent = parent;
      }
      parent.children.splice(index, 1, ...children);
      this.children.length = 0;
      this.parent = undefined;
    }
  }

  /**溯源到根节点 */
  get root(): Message {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    let node: Message = this;
    while (node.parent) {
      node = node.parent;
    }
    return node;
  }

  /** 在树中的深度（根节点为 0） */
  get depth(): number {
    let d = 0;
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    let node: Message = this;
    while (node.parent) {
      d++;
      node = node.parent;
    }
    return d;
  }

  /** 是否根节点（没有 parent） */
  get isRoot(): boolean {
    return !this.parent;
  }

  /** 是否叶子节点 */
  get isLeaf(): boolean {
    return this.children.length === 0;
  }

  /** 最后一个子节点 */
  get lastChild(): Message | undefined {
    return this.children.length > 0
      ? this.children[this.children.length - 1]
      : undefined;
  }

  /**
   * 从根节点到当前节点的完整路径
   *
   * @param includeRoot 是否包含根节点，默认 true。
   *当为 true 时，如果根节点是空 System 消息（parts 为空），
   *则自动跳过，避免向不支持空消息的 API 发送空 System 消息。
   */
  getHistory(includeRoot: boolean = true): Message[] {
    const path: Message[] = [];
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    let node: Message = this;
    while (node) {
      path.unshift(node);
      node = node.parent!;
    }
    if (!includeRoot && path.length > 0 && path[0].isRoot) {
      path.shift();
    }
    //跳过空的根节点（parts 为空的System 消息）
    if (
      includeRoot &&
      path.length > 0 &&
      path[0].isRoot &&
      path[0].role === Role.System &&
      path[0].parts.length === 0
    ) {
      path.shift();
    }
    return path;
  }

  // ========================
  //  便捷 Getter（带懒缓存）
  // ========================

  /** 获取消息的文本内容（拼接所有 TextPart + ToolResultPart） */
  get text(): string {
    if (this._textCache !== undefined) return this._textCache;
    let result = "";
    for (const p of this.parts) {
      if (p.type === "text") result += p.text;
      else if (p.type === "tool_result") result += p.result;
    }
    this._textCache = result;
    return result;
  }

  /** 获取所有 ToolCallPart */
  get toolCalls(): ToolCallPart[] {
    if (this._toolCallsCache !== undefined) return this._toolCallsCache;
    const result: ToolCallPart[] = [];
    for (const p of this.parts) {
      if (p.type === "tool_call") result.push(p);
    }
    this._toolCallsCache = result;
    return result;
  }

  /** 获取思考/推理内容（拼接所有 ThinkingPart） */
  get thinking(): string {
    if (this._thinkingCache !== undefined) return this._thinkingCache;
    let result = "";
    for (const p of this.parts) {
      if (p.type === "thinking") result += p.text;
    }
    this._thinkingCache = result;
    return result;
  }

  /** 是否包含思考内容 */
  get hasThinking(): boolean {
    if (this._hasThinkingCache !== undefined) return this._hasThinkingCache;
    this._hasThinkingCache = this.parts.some((p) => p.type === "thinking");
    return this._hasThinkingCache;
  }

  /** 是否包含媒体内容（图片/音频/文件） */
  get hasMedia(): boolean {
    if (this._hasMediaCache !== undefined) return this._hasMediaCache;
    this._hasMediaCache = this.parts.some(
      (p) => p.type === "image" || p.type === "audio" || p.type === "file"
    );
    return this._hasMediaCache;
  }

  /**
   * 手动失效所有 getter 缓存。
   *
   * 当通过 addText/addImage/... 等内置方法修改时，缓存会自动失效；
   * 但如果直接对 parts 数组进行 push/splice 等操作，请调用此方法。
   */
  invalidateCache(): this {
    this._textCache = undefined;
    this._thinkingCache = undefined;
    this._toolCallsCache = undefined;
    this._hasMediaCache = undefined;
    this._hasThinkingCache = undefined;
    return this;
  }

  // ========================
  //  内部辅助
  // ========================

  private static normalizeParts(
    content: string | MessagePart | MessagePart[]
  ): MessagePart[] {
    if (typeof content === "string") {
      return [{ type: "text", text: content }];
    }
    if (Array.isArray(content)) {
      return content;
    }
    return [content];
  }

  //========================
  //  序列化 / 反序列化
  // ========================

  /**
   * 序列化为 JSON 安全对象（含子树）
   *
   * 递归序列化所有 children，避免 parent 循环引用。
   * 反序列化时通过 fromJSON 自动重建 parent 关系。
   */
  toJSON(): Record<string, unknown> {
    const data: Record<string, unknown> = {
      role: this.role,
      parts: this.parts,
      metadata: this.metadata,
      tags: Array.from(this.tags),
    };

    if (this.model) data.model = this.model;
    if (this.usage) data.usage = this.usage.toJSON();
    if (this.children.length > 0) {
      data.children = this.children.map((c) => c.toJSON());
    }

    return data;
  }

  /**
   * 从 JSON 对象反序列化（含子树）
   *
   * 自动重建 parent/children 树结构关系。
   */
  static fromJSON(data: Record<string, unknown>): Message {
    const role = data.role as Role;
    const parts = (data.parts as MessagePart[]) || [];
    const metadata = (data.metadata as Record<string, unknown>) || {};

    const msg = new Message(role, parts, metadata);

    // 恢复标签
    const tags = data.tags as string[] | undefined;
    if (tags) {
      for (const t of tags) {
        msg.tags.add(t);
      }
    }

    // 恢复 model & usage
    if (data.model) msg.model = data.model as string;
    if (data.usage) msg.usage = Usage.fromJSON(data.usage as Record<string, unknown>);

    // 递归恢复子节点
    const childrenData = data.children as Record<string, unknown>[] | undefined;
    if (childrenData) {
      for (const childData of childrenData) {
        const child = Message.fromJSON(childData);
        msg.append(child);
      }
    }

    return msg;
  }
}
