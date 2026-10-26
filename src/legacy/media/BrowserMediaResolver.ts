import { MediaResolver, ResolvedMedia } from "./MediaResolver";

/**
 * 浏览器安全的默认媒体解析器。
 *
 * 支持 data URI、HTTP(S) 和 blob URL。浏览器无法直接读取本地文件路径；
 * Node.js 调用方需要本地文件能力时，应使用 `@notic/agent-engine/node`。
 */
export class BrowserMediaResolver implements MediaResolver {
  async resolve(url: string): Promise<ResolvedMedia> {
    if (url.startsWith("data:")) {
      return this.resolveDataUri(url);
    }

    if (
      url.startsWith("http://") ||
      url.startsWith("https://") ||
      url.startsWith("blob:")
    ) {
      return this.resolveFetch(url);
    }

    throw new Error(
      "BrowserMediaResolver cannot read local file paths. " +
      "Pass a custom MediaResolver or import DefaultMediaResolver from " +
      "@notic/agent-engine/node."
    );
  }

  private resolveDataUri(uri: string): ResolvedMedia {
    const match = uri.match(/^data:([^;]+);base64,(.+)$/);
    if (!match) {
      throw new Error(`Invalid data URI: ${uri.slice(0, 50)}...`);
    }
    return { mimeType: match[1], base64: match[2] };
  }

  private async resolveFetch(url: string): Promise<ResolvedMedia> {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(
        `Failed to fetch ${url}: ${response.status} ${response.statusText}`
      );
    }

    const base64 = this.toBase64(await response.arrayBuffer());
    const mimeType =
      response.headers.get("content-type")?.split(";")[0].trim() ||
      "application/octet-stream";
    return { base64, mimeType };
  }

  private toBase64(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    const chunkSize = 0x8000;
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
    }
    return btoa(binary);
  }
}
