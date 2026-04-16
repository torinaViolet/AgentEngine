/**
 * Token用量统计
 */
export class Usage {
  public promptTokens: number;
  public completionTokens: number;
  public totalTokens: number;

  constructor(
    promptTokens: number = 0,
    completionTokens: number = 0,
    totalTokens: number = 0
  ) {
    this.promptTokens = promptTokens;
    this.completionTokens = completionTokens;
    this.totalTokens = totalTokens;
  }

  /**
   * 累加另一个 Usage，返回新的 Usage
   */
  add(other: Usage): Usage {
    return new Usage(
      this.promptTokens + other.promptTokens,
      this.completionTokens + other.completionTokens,
      this.totalTokens + other.totalTokens
    );
  }

  /**
   * 从OpenAI API 原始响应解析
   */
  static fromRaw(raw: any): Usage {
    if (!raw) return Usage.zero();
    return new Usage(
      raw.prompt_tokens ?? 0,
      raw.completion_tokens ?? 0,
      raw.total_tokens ?? 0
    );
  }

  /**
   * 零值
   */
  static zero(): Usage {
    return new Usage(0, 0, 0);
  }

  toString(): string {
    return `Usage(prompt=${this.promptTokens}, completion=${this.completionTokens}, total=${this.totalTokens})`;
  }
}