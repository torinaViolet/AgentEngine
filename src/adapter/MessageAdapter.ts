import { Message } from "../message";

/**
 * 序列化输出结构
 *
 * messages: 目标平台的 messages 数组
 * systemMessage: 被提取出的 system 消息内容（为Anthropic/Gemini 预留）
 */
export interface SerializedResult {
  messages: unknown[];
  systemMessage?: string;
}

/**
 * 消息适配器接口
 *
 * 负责将统一 Message 模型与具体 API 平台的 JSON 格式相互转换。
 * serialize 为 async —— 因为媒体资源可能需要懒加载（fetch/读文件）。
 */
export interface MessageAdapter {
  /** 统一 Message[] → 平台 JSON */
  serialize(messages: Message[]): Promise<SerializedResult>;

  /** 平台 JSON响应 → 统一 Message */
  deserialize(raw: unknown): Message;
}