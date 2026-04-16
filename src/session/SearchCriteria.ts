import { Role } from "../message/Role";

/**
 * 匹配模式
 */
export enum MatchMode {
  /** 全部符合（AND） */
  AND = "and",
  /** 部分符合（OR） */
  OR = "or",
  /** 不符合（NOT，反选） */
  NOT = "not",
}

/**
 * 优先级策略（多匹配结果时的选择）
 */
export enum Priority {
  /** 最接近底部（最新） */
  NEWEST = "newest",
  /** 最接近顶部（最久） */
  OLDEST = "oldest",
  /** 最多关键词命中 */
  BEST_MATCH = "best",
}

/**
 * 搜索条件
 */
export interface SearchCriteria {
  /** 内容关键词/正则 */
  content?: (string | RegExp)[];
  /** 标签关键词/正则 */
  tags?: (string | RegExp)[];
  /** 按角色过滤（数组，只匹配其中的角色） */
  roles?: Role[];
  /** 匹配模式，默认 AND */
  mode?: MatchMode;
  /** 优先级策略，默认 NEWEST */
  priority?: Priority;
}