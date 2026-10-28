import { abortable, assert } from "../core/data";
import { isJsonBody } from "./Provider";
import type { Transport } from "./Provider";
export const fetchTransport: Transport = request => {
    const headers = new Headers(request.headers);
    const json = isJsonBody(request.body);
    if (json && !headers.has("content-type")) headers.set("content-type", "application/json");
    if (typeof FormData !== "undefined" && request.body instanceof FormData) headers.delete("content-type");
    const body = json ? JSON.stringify(request.body) : request.body as BodyInit | undefined;
    const init: RequestInit & { duplex?: "half" } = { method: request.method, headers, body, signal: request.signal };
    if (typeof ReadableStream !== "undefined" && body instanceof ReadableStream) init.duplex = "half";
    return fetch(request.url, init);
};
export interface SSEOptions {
    maxEventBytes?: number;
    /** Reports an explicit data: [DONE] marker, never a bare EOF; the marker is not yielded as JSON. */
    onDone?: () => void;
}
/** Byte framing and cancellation belong to transport, protocol content belongs to the codec. */
export async function* decodeSSE(response: Response, signal?: AbortSignal, options: SSEOptions = {}): AsyncIterable<unknown> {
    const maxBytes = options.maxEventBytes ?? 16 * 1024 * 1024;
    assert(Number.isSafeInteger(maxBytes) && maxBytes > 0, "maxEventBytes must be a positive integer");
    const reader = response.body?.getReader();
    assert(reader, "Response has no readable body");
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let buffer = "";
    let bufferedBytes = 0;
    let emitted = false;
    let ended = false;
    function* drain(final: boolean): Generator<unknown> {
        if (final && /^\s*[\[{]/.test(buffer) && !emitted) {
            assert(encoder.encode(buffer).byteLength <= maxBytes, "SSE event exceeds maxEventBytes");
            const event = JSON.parse(buffer);
            buffer = "";
            bufferedBytes = 0;
            yield event;
            return;
        }
        if (final) {
            buffer += "\n\n";
            bufferedBytes += 2;
        }
        for (let match = /\r?\n\r?\n/.exec(buffer); match; match = /\r?\n\r?\n/.exec(buffer)) {
            signal?.throwIfAborted();
            const block = buffer.slice(0, match.index);
            const blockBytes = encoder.encode(block).byteLength;
            assert(blockBytes <= maxBytes, "SSE event exceeds maxEventBytes");
            bufferedBytes -= blockBytes + match[0].length;
            buffer = buffer.slice(match.index + match[0].length);
            const lines = block.split(/\r?\n/);
            const data = lines.filter(line => line.startsWith("data:")).map(line => line.slice(5).replace(/^ /, "")).join("\n");
            if (data === "[DONE]") {
                ended = true;
                buffer = "";
                bufferedBytes = 0;
                options.onDone?.();
                return;
            }
            if (data) {
                const event = JSON.parse(data);
                emitted = true;
                yield event;
            }
        }
        assert(bufferedBytes <= maxBytes, "SSE event exceeds maxEventBytes");
    }
    try {
        while (!ended) {
            const chunk = await abortable(reader.read(), signal);
            if (chunk.done)
                break;
            const text = decoder.decode(chunk.value, { stream: true });
            buffer += text;
            bufferedBytes += encoder.encode(text).byteLength;
            for (const event of drain(false))
                yield event;
        }
        if (!ended) {
            const text = decoder.decode(); buffer += text; bufferedBytes += encoder.encode(text).byteLength;
            for (const event of drain(true))
                yield event;
        }
        signal?.throwIfAborted();
    }
    finally {
        await reader.cancel().catch(() => {
        });
        reader.releaseLock();
    }
}
/** Binary outputs never enter Message JSON. Applications decide how to store their bytes. */
export async function readResponseBytes(response: Response, signal?: AbortSignal, maxBytes = 64 * 1024 * 1024): Promise<Uint8Array> {
    assert(Number.isSafeInteger(maxBytes) && maxBytes > 0, "maxBytes must be a positive integer");
    signal?.throwIfAborted();
    const reader = response.body?.getReader(); assert(reader, "Response has no readable body");
    const chunks: Uint8Array[] = []; let size = 0;
    try {
        assert(Number(response.headers.get("content-length") ?? 0) <= maxBytes, "Media response exceeds maxBytes");
        while (true) {
            const chunk = await abortable(reader.read(), signal);
            if (chunk.done) break;
            size += chunk.value.byteLength; assert(size <= maxBytes, "Media response exceeds maxBytes"); chunks.push(chunk.value);
        }
        const bytes = new Uint8Array(size); let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        return bytes;
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
