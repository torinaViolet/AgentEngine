/**
 * 工具生命周期钩子
 *
 * 生命周期:
 * ON_CREATE → ON_VALIDATE → BEFORE_EXECUTE → execute → AFTER_EXECUTE → ON_SERIALIZE
 *↓
 *ON_ERROR
 */
export enum Hook {
  /** 调用实例创建后*/
  ON_CREATE = "on_create",
  /** 参数校验时 */
  ON_VALIDATE = "on_validate",
  /** 执行前（可取消） */
  BEFORE_EXECUTE = "before_execute",
  /** 执行后（可改写结果） */
  AFTER_EXECUTE = "after_execute",
  /** 出错时（可降级） */
  ON_ERROR = "on_error",
  /** 序列化结果前*/
  ON_SERIALIZE = "on_serialize",
}