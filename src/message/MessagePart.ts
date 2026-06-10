/**
 * 消息内容的原子单元— Discriminated Union
 */

export interface TextPart {
  type: "text";
  text: string;
}

export interface ImagePart {
  type: "image";
  /** 图片URL（https:// | data:... | file:///） */
  url: string; mimeType?: string;
}

export interface AudioPart {
  type: "audio";
  /** 音频URL */
  url: string;
  mimeType?: string;
}

export interface FilePart {
  type: "file";
  /** 文件URL */
  url: string;
  mimeType?: string; fileName?: string;
}

export interface ToolCallPart {
  type: "tool_call";
  toolCallId: string;
  name: string;
  /** JSON string of arguments */
  arguments: string;
  /** Provider-specific data that must survive a tool round trip. */
  metadata?: Record<string, unknown>;
}

export interface ToolResultPart {
  type: "tool_result";
  toolCallId: string;
  name?: string;
  /** JSON string of result */
  result: string;
}

export interface ThinkingPart {
  type: "thinking";
  /** 模型的推理/思考过程文本 */
  text: string;
}

export type MessagePart =
  | TextPart
  | ImagePart
  | AudioPart
  | FilePart
  | ToolCallPart
  | ToolResultPart
  | ThinkingPart;
