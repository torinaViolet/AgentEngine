import { Message } from "../message/Message";
import { Role } from "../message/Role";
import { SearchCriteria,MatchMode, Priority } from "./SearchCriteria";

/**
 * 检测一个字符串是否匹配某个 pattern（string 或 RegExp）
 */
function matchesPattern(value: string, pattern: string | RegExp): boolean {
  if (typeof pattern === "string") {
    return value.includes(pattern);
  }
  return pattern.test(value);
}

/**
 * 计算一条消息在content 维度匹配了多少个 pattern
 */
function countContentMatches(
  msg: Message,
  patterns: (string | RegExp)[]
): number {
  const text = msg.text;
  return patterns.filter((p) => matchesPattern(text, p)).length;
}

/**
 * 计算一条消息在 tags 维度匹配了多少个 pattern
 */
function countTagMatches(
  msg: Message,
  patterns: (string | RegExp)[]
): number {
  const tagArray = Array.from(msg.tags);
  return patterns.filter((p) =>
    tagArray.some((t) => matchesPattern(t, p))
  ).length;
}

/**
 * 判断消息是否符合 SearchCriteria
 */
export function matchesCriteria(
  msg: Message,
  criteria: SearchCriteria
): boolean {
  const mode = criteria.mode ?? MatchMode.AND;

  // 角色过滤
  if (criteria.roles && criteria.roles.length > 0) {
    if (!criteria.roles.includes(msg.role)) {
      return mode === MatchMode.NOT; // NOT模式下，不在roles中的反而匹配
    }
  }

  const conditions: boolean[] = [];

  // 内容匹配
  if (criteria.content && criteria.content.length > 0) {
    const contentHits = countContentMatches(msg, criteria.content);
    if (mode === MatchMode.AND) {
      conditions.push(contentHits === criteria.content.length);
    } else if (mode === MatchMode.OR) {
      conditions.push(contentHits > 0);
    } else {
      // NOT
      conditions.push(contentHits === 0);
    }
  }

  // 标签匹配
  if (criteria.tags && criteria.tags.length > 0) {
    const tagHits = countTagMatches(msg, criteria.tags);
    if (mode === MatchMode.AND) {
      conditions.push(tagHits === criteria.tags.length);
    } else if (mode === MatchMode.OR) {
      conditions.push(tagHits > 0);
    } else {
      // NOT
      conditions.push(tagHits === 0);
    }
  }

  // 无条件时（只有roles 过滤）
  if (conditions.length === 0) {
    return mode !== MatchMode.NOT;
  }

  if (mode === MatchMode.AND || mode === MatchMode.NOT) {
    return conditions.every((c) => c);
  }
  // OR
  return conditions.some((c) => c);
}

/**
 * 计算消息的总匹配分数（用于 BEST_MATCH 排序）
 */
export function matchScore(msg: Message, criteria: SearchCriteria): number {
  let score = 0;
  if (criteria.content) {
    score += countContentMatches(msg, criteria.content);
  }
  if (criteria.tags) {
    score += countTagMatches(msg, criteria.tags);
  }
  return score;
}

/**
 * 从匹配列表中按Priority 选出一条消息
 *
 * @param matches 已匹配的消息列表（保持原始顺序）
 * @param criteria 搜索条件（取priority）
 */
export function selectByPriority(
  matches: Message[],
  criteria: SearchCriteria
): Message | undefined {
  if (matches.length === 0) return undefined;

  const priority = criteria.priority ?? Priority.NEWEST;

  switch (priority) {
    case Priority.OLDEST:
      return matches[0];
    case Priority.NEWEST:
      return matches[matches.length - 1];
    case Priority.BEST_MATCH:
      let best = matches[0];
      let bestScore = matchScore(best, criteria);
      for (let i = 1; i < matches.length; i++) {
        const s = matchScore(matches[i], criteria);
        if (s > bestScore) {
          best = matches[i];
          bestScore = s;
        }
      }
      return best;
  }
}

/**
 * 全树遍历（深度优先前序）
 */
export function traverseTree(root: Message): Message[] {
  const result: Message[]= [];
  const stack: Message[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    result.push(node);
    //逆序入栈保证子节点按顺序遍历
    for (let i = node.children.length - 1; i >= 0; i--) {
      stack.push(node.children[i]);
    }
  }
  return result;
}