/**
 * 通用 ID 生成器
 *
 * 生成格式为 `[prefix-]<timestamp>-<random>` 的唯一标识符。
 *
 * @param prefix 可选前缀，如 "inj"、"run"、"approval"
 * @returns 唯一 ID 字符串
 */
export function generateId(prefix?: string): string {
  const id =
    Date.now().toString(36) +
    "-" +
    Math.random().toString(36).slice(2, 10);
  return prefix ? `${prefix}-${id}` : id;
}