import * as fs from "fs/promises";
import * as path from "path";
import { MediaResolver, ResolvedMedia } from "./MediaResolver";

/**
 * 默认媒体解析器
 *
 * 支持三种 URL 格式：
 * - https:// / http:// → fetch 下载
 * - data:mime;base64,... → 直接拆解
 * - file:///或本地路径  → 读取本地文件
 */
export class DefaultMediaResolver implements MediaResolver {
  async resolve(url: string): Promise<ResolvedMedia> {
    if (url.startsWith("data:")) {
      return this.resolveDataUri(url);
    }

    if (url.startsWith("http://") || url.startsWith("https://")) {
      return this.resolveHttp(url);
    }

    // file:/// 或相对/绝对路径视为本地文件
    const filePath = url.startsWith("file:///")
      ? url.slice("file:///".length)
      : url;
    return this.resolveLocalFile(filePath);
  }

  private resolveDataUri(uri: string): ResolvedMedia {
    // 格式: data:<mimeType>;base64,<data>
    const match = uri.match(/^data:([^;]+);base64,(.+)$/);
    if (!match) {
      throw new Error(`Invalid data URI: ${uri.slice(0, 50)}...`);
    }
    return { mimeType: match[1], base64: match[2] };
  }

  private async resolveHttp(url: string): Promise<ResolvedMedia> {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
    }
    const buffer = await response.arrayBuffer();
    const base64 = Buffer.from(buffer).toString("base64");
    const mimeType =
      response.headers.get("content-type")?.split(";")[0].trim() ||
      "application/octet-stream";
    return { base64, mimeType };
  }

  private async resolveLocalFile(filePath: string): Promise<ResolvedMedia> {
    const absolutePath = path.resolve(filePath);
    const buffer = await fs.readFile(absolutePath);
    const base64 = buffer.toString("base64");
    const mimeType = this.guessMimeType(absolutePath);
    return { base64, mimeType };
  }

  private guessMimeType(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase();
    const mimeMap: Record<string, string> = {
      // 图片
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".gif": "image/gif",
      ".webp": "image/webp",
      ".svg": "image/svg+xml",
      ".bmp": "image/bmp",
      // 音频
      ".mp3": "audio/mpeg",
      ".wav": "audio/wav",
      ".ogg": "audio/ogg",
      ".flac": "audio/flac",
      ".m4a": "audio/mp4",
      // 文档
      ".pdf": "application/pdf",
      ".txt": "text/plain",
      ".json": "application/json",
      ".csv": "text/csv",
    };
    return mimeMap[ext] || "application/octet-stream";
  }
}