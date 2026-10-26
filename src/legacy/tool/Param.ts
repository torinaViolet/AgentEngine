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
  private _itemsType?: ValueType; // Array 类型：简单 items
  private _itemsParams?: Param[]; // Array 类型：对象 items
  private _properties?: Param[]; // Object 类型：属性列表

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

  /**
   * 创建数组类型参数
   *
   * @param name 参数名
   * @param items 数组元素类型：ValueType 表示简单类型，Param[] 表示对象数组
   *
   * 用法:
   *   Param.array("tags", ValueType.String)  // string[]
   *   Param.array("items", [                 // { name: string, count: number }[]
   *     Param.string("name").desc("名称").required(),
   *     Param.number("count").desc("数量"),
   *   ])
   */
  static array(name: string, items: ValueType | Param[]): Param {
    const param = new Param(name, ValueType.Array);
    if (Array.isArray(items)) {
      param._itemsParams = items;
    } else {
      param._itemsType = items;
    }
    return param;
  }

  /**
   * 创建对象类型参数
   *
   * @param name 参数名
   * @param properties 对象属性定义
   *
   * 用法:
   *   Param.object("address", [
   *     Param.string("city").desc("城市").required(),
   *     Param.string("street").desc("街道"),
   *     Param.object("geo", [
   *       Param.number("lat").desc("纬度").required(),
   *       Param.number("lng").desc("经度").required(),
   *     ]),
   *   ])
   */
  static object(name: string, properties: Param[]): Param {
    const param = new Param(name, ValueType.Object);
    param._properties = properties;
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

    // Array 类型：items 可以是简单类型或嵌套对象
    if (this.type === ValueType.Array) {
      if (this._itemsParams) {
        schema.items = Param.buildObjectSchema(this._itemsParams);
      } else if (this._itemsType) {
        schema.items = { type: this._itemsType };
      }
    }

    // Object 类型：递归构建 properties
    if (this.type === ValueType.Object && this._properties) {
      const objectSchema = Param.buildObjectSchema(this._properties);
      schema.properties = objectSchema.properties;
      if ((objectSchema.required as string[]).length > 0) {
        schema.required = objectSchema.required;
      }
    }

    return schema;
  }

  /**
   * 从 Param[] 构建 JSON Schema 的 object 结构
   * @internal
   */
  private static buildObjectSchema(params: Param[]): Record<string, unknown> {
    const properties: Record<string, unknown> = {};
    const required: string[] = [];

    for (const param of params) {
      properties[param.name] = param.toSchema();
      if (param.isRequired) {
        required.push(param.name);
      }
    }

    return {
      type: "object",
      properties,
      required,
    };
  }
}