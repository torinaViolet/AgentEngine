/**
 * 媒体资源解析器接口
 *
 * 负责将 URL 解析为实际的二进制内容（base64），
 * 仅在Adapter 序列化时按需调用（懒加载）。
 */
export interface ResolvedMedia {
  /** base64 编码的内容 */
  base64: string;
  /** MIME 类型，如 image/png, audio/mp3 */
  mimeType: string;
}

export interface MediaResolver {
  /**
   * 将 URL 解析为 base64 内容
   * @param url 资源地址（https:// | data:... | file:///）
   */
  resolve(url: string): Promise<ResolvedMedia>;
}