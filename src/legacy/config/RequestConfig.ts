/**
 * 请求参数配置器 — 链式构建 LLM 请求参数
 *
 * 以链式 API 方便地设置温度、采样参数、Token 限制等，
 * 最终通过 build() 输出为 Record 传给 Agent / API。
 *
 * 特性：
 * - 链式调用，简洁易读
 * - 参数自动校验（范围钳制）
 * - 支持自定义参数（覆盖非标准 API 字段）
 * - 可克隆、可合并
 * - 支持快照预览/ 预设模式
 *
 * 用法:
 *   const config = RequestConfig.create()
 *     .temperature(0.8)
 *     .topP(0.9)
 *     .maxTokens(2048)
 *     .stop("\n", "END")
 *     .seed(42);
 *
 *   const agent = new Agent({ client, model, session, config });
 */
export class RequestConfig {
  private _params: Map<string, unknown> = new Map();

  private constructor() {}

  //========================
  //  静态工厂
  // ========================

  /** 创建空配置 */
  static create(): RequestConfig {
    return new RequestConfig();
  }

  // ---- 预设模式 ----

  /** 精确模式：低温度、低随机性 */
  static precise(): RequestConfig {
    return new RequestConfig()
      .temperature(0.1)
      .topP(0.9)
      .frequencyPenalty(0)
      .presencePenalty(0);
  }

  /** 平衡模式：适中参数 */
  static balanced(): RequestConfig {
    return new RequestConfig()
      .temperature(0.7)
      .topP(0.95)
      .frequencyPenalty(0)
      .presencePenalty(0);
  }

  /** 创意模式：高温度、高随机性 */
  static creative(): RequestConfig {
    return new RequestConfig()
      .temperature(1.2)
      .topP(0.95)
      .frequencyPenalty(0.3)
      .presencePenalty(0.3);
  }

  // ========================
  //  采样参数
  // ========================

  /**
   * 设置温度（控制随机性）
   * @param t 温度值，范围 [0, 2]，越高越随机
   */
  temperature(t: number): this {
    this._params.set("temperature", clamp(t, 0, 2));
    return this;
  }

  /**
   * 设置 Top-P（核采样）
   * @param p 概率阈值，范围 [0, 1]
   */
  topP(p: number): this {
    this._params.set("top_p", clamp(p, 0, 1));
    return this;
  }

  /**
   * 设置 Top-K（取概率最高的 K 个 token）
   * @param k 正整数
   */
  topK(k: number): this {
    this._params.set("top_k", Math.max(1, Math.floor(k)));
    return this;
  }

  // ========================
  //  Token 限制
  // ========================

  /**
   * 设置最大生成 Token 数
   * @param n 正整数
   */
  maxTokens(n: number): this {
    this._params.set("max_tokens", Math.max(1, Math.floor(n)));
    return this;
  }

  // ========================
  //  惩罚参数
  // ========================

  /**
   * 设置频率惩罚（降低已出现 token 的概率）
   * @param p 范围 [-2, 2]
   */
  frequencyPenalty(p: number): this {
    this._params.set("frequency_penalty", clamp(p, -2, 2));
    return this;
  }

  /**
   * 设置存在惩罚（降低已出现 token 的概率，不考虑频次）
   * @param p 范围 [-2, 2]
   */
  presencePenalty(p: number): this {
    this._params.set("presence_penalty", clamp(p, -2, 2));
    return this;
  }

  // ========================
  //  停止序列
  // ========================

  /**
   * 设置停止序列（最多 4 个）
   * 生成遇到这些字符串时停止
   */
  stop(...sequences: string[]): this {
    if (sequences.length === 0) {
      this._params.delete("stop");
    } else {
      this._params.set("stop", sequences.slice(0, 4));
    }
    return this;
  }

  // ========================
  //  种子
  // ========================

  /**
   * 设置随机种子（使输出尽量可复现）
   * @param s 整数
   */
  seed(s: number): this {
    this._params.set("seed", Math.floor(s));
    return this;
  }

  // ========================
  //  响应格式
  // ========================

  /**
   * 设置响应格式
   *
   * @param format 格式类型
   * @param schema 当format 为 json_schema 时，传入 JSON Schema定义
   */
  responseFormat(
    format: "text" | "json_object" | "json_schema",
    schema?: { name: string; schema: Record<string, unknown> }
  ): this {
    if (format === "text") {
      this._params.delete("response_format");
    } else if (format === "json_object") {
      this._params.set("response_format", { type: "json_object" });
    } else if (format === "json_schema" && schema) {
      this._params.set("response_format", {
        type: "json_schema",
        json_schema: schema,
      });
    }
    return this;
  }

  // ========================
  //  自定义参数
  // ========================

  /**
   * 设置任意自定义参数（用于非标准 API 字段）
   */
  set(key: string, value: unknown): this {
    this._params.set(key, value);
    return this;
  }

  /**
   * 移除某个参数
   */
  unset(key: string): this {
    this._params.delete(key);
    return this;
  }

  // ========================
  //  输出
  // ========================

  /**
   * 构建为普通对象，用于传给 API
   */
  build(): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, value] of this._params) {
      result[key] = value;
    }
    return result;
  }

  /**
   * 与另一个 Config 合并，other 的参数优先
   *返回新的 RequestConfig，不修改原对象
   */
  merge(other: RequestConfig): RequestConfig {
    const merged = this.clone();
    for (const [key, value] of other._params) {
      merged._params.set(key, value);
    }
    return merged;
  }

  /**
   * 克隆当前配置
   */
  clone(): RequestConfig {
    const cloned = new RequestConfig();
    for (const [key, value] of this._params) {
      cloned._params.set(key, value);
    }
    return cloned;
  }

  // ========================
  //  查询
  // ========================

  /** 获取某个参数的值 */
  get(key: string): unknown {
    return this._params.get(key);
  }

  /** 是否设置了某个参数 */
  has(key: string): boolean {
    return this._params.has(key);
  }

  /** 已设置的参数数量 */
  get size(): number {
    return this._params.size;
  }

  /** 所有已设置的参数键*/
  get keys(): string[] {
    return Array.from(this._params.keys());
  }

  /**
   * 预览当前配置（调试用）
   */
  toString(): string {
    const entries = Array.from(this._params.entries())
      .map(([k, v]) => `  ${k}: ${JSON.stringify(v)}`)
      .join("\n");
    return `RequestConfig {\n${entries}\n}`;
  }
}

// ========================
//  辅助函数
// ========================

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}