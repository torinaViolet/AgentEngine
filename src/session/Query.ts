import { Message } from "../message/Message";
import { Role } from "../message/Role";
import { SearchCriteria, MatchMode } from "./SearchCriteria";
import { matchesCriteria, traverseTree } from "./matchUtils";

/**
 * 查询系统
 *
 * 支持在当前分支或全树中按内容、标签、角色、正则、自定义规则进行多维度查询。
 */
export class Query {
  private _root: Message;
  private _getCursor: () => Message;

  constructor(root: Message, getCursor: () => Message) {
    this._root = root;
    this._getCursor = getCursor;
  }

  //========================
  //  按范围查询
  // ========================

  /**
   * 在当前分支中查找（root→cursor路径）
   */
  branch(criteria: SearchCriteria): Message[] {
    const path = this._getCursor().getHistory(true);
    return path.filter((msg) => matchesCriteria(msg, criteria));
  }

  /**
   * 在全树中查找
   */
  tree(criteria: SearchCriteria): Message[] {
    const allNodes = traverseTree(this._root);
    return allNodes.filter((msg) => matchesCriteria(msg, criteria));
  }

  // ========================
  //  便捷方法
  // ========================

  /**
   * 按内容查找
   */
  findByContent(
    keywords: (string | RegExp)[],
    options?:{
      scope?: "branch" | "tree";
      mode?: MatchMode;
      roles?: Role[];
    }
  ): Message[] {
    const criteria: SearchCriteria = {
      content: keywords,
      mode: options?.mode,
      roles: options?.roles,
    };
    return options?.scope === "tree"
      ? this.tree(criteria)
      : this.branch(criteria);
  }

  /**
   * 按标签查找
   */
  findByTags(
    tags: (string | RegExp)[],
    options?: {
      scope?: "branch" | "tree";
      mode?: MatchMode;
      roles?: Role[];
    }
  ): Message[] {
    const criteria: SearchCriteria = {
      tags,
      mode: options?.mode,
      roles: options?.roles,
    };
    return options?.scope === "tree"
      ? this.tree(criteria)
      : this.branch(criteria);
  }

  /**
   * 按角色查找
   */
  findByRole(
    role: Role,
    scope: "branch" | "tree" = "branch"
  ): Message[] {
    const criteria: SearchCriteria = { roles: [role] };
    return scope === "tree"
      ? this.tree(criteria)
      : this.branch(criteria);
  }

  /**
   * 自定义规则查找
   */
  findBy(
    predicate: (message: Message) => boolean,
    scope: "branch" | "tree" = "branch"
  ): Message[] {
    const source =
      scope === "tree"
        ? traverseTree(this._root)
        : this._getCursor().getHistory(true);
    return source.filter(predicate);
  }

  /**
   * 查找第一个匹配
   */
  findFirst(
    criteria: SearchCriteria,
    scope: "branch" | "tree" = "branch"
  ): Message | undefined {
    const results =
      scope === "tree" ? this.tree(criteria) : this.branch(criteria);
    return results.length > 0 ? results[0] : undefined;
  }

  /**
   * 查找最后一个匹配
   */
  findLast(
    criteria: SearchCriteria,
    scope: "branch" | "tree" = "branch"
  ): Message | undefined {
    const results =
      scope === "tree" ? this.tree(criteria) : this.branch(criteria);
    return results.length > 0 ? results[results.length - 1] : undefined;
  }
}