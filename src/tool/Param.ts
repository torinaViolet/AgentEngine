import { ValueType } from "./ValueType";

/**
 * 参数定义 — 链式工厂模式
 *
 * 用法:
 *Param.string("city").desc("城市名").required()
 *   Param.string("unit").desc("温度单位").enum(["celsius", "fahrenheit"])
 *   Param.integer("count").desc("数量").required()
 *   Param.array("tags", ValueType.String).desc("标签列表")
 */
export class Param {
  public readonly name: string;
  public readonly type: ValueType;
  private _description: string = "";
  private _isRequired: boolean = false;
  private _enumValues?: unknown[];
  private _itemsType?: ValueType; // 仅 Array 类型使用

  private constructor(name: string, type: ValueType) {
    this.name = name;
    this.type = type;
  }

  //========================
  //  静态工厂
  // ========================

  static string(name: string): Param {
    return new Param(name, ValueType.String);
  }

  static integer(name: string): Param {
    return new Param(name, ValueType.Integer);
  }

  static number(name: string): Param {
    return new Param(name, ValueType.Number);
  }

  static boolean(name: string): Param {
    return new Param(name, ValueType.Boolean);
  }

  static array(name: string, itemsType: ValueType): Param {
    const param = new Param(name, ValueType.Array);
    param._itemsType = itemsType;
    return param;
  }

  // ========================
  //  链式配置
  // ========================

  desc(description: string): this {
    this._description = description;
    return this;
  }

  required(): this {
    this._isRequired = true;
    return this;
  }

  enum(values: unknown[]): this {
    this._enumValues = values;
    return this;
  }

  // ========================
  //  查询
  // ========================

  get isRequired(): boolean {
    return this._isRequired;
  }

  get description(): string {
    return this._description;
  }

  // ========================
  //  序列化为 JSON Schema 片段
  // ========================

  toSchema(): Record<string, unknown> {
    const schema: Record<string, unknown> = {
      type: this.type,
      description: this._description,
    };

    if (this._enumValues !== undefined) {
      schema.enum = this._enumValues;
    }

    if (this.type === ValueType.Array && this._itemsType) {
      schema.items = { type: this._itemsType };
    }

    return schema;
  }
}