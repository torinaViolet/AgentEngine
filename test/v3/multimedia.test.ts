import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  Provider, OpenAIProvider, GeminiProvider, Generator, Message, TreeSession, ListSession, AgentSession, restoreSession,
  supportsCapability, fetchTransport, decodeSSE, readResponseBytes, ProviderRequestError,
  type ImageProvider, type AudioProvider, type VideoProvider, type ChatProvider,
  type ImageGenerationRequest, type ImageGenerationResult, type AudioGenerationRequest, type AudioGenerationResult,
  type VideoGenerationRequest, type VideoTask, type MediaCallOptions, type MediaArtifact,
  type HttpRequest, type ModelRequest, type SerializedMessages,
} from "../../src";

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
const image: MediaArtifact<"image"> = { kind: "image", mimeType: "image/png", source: { type: "url", url: "https://artifacts.test/image.png" } };

// These are synthetic gateway protocols, not vendor endpoint implementations.
class ImageOnly extends Provider implements ImageProvider {
  generateImages(request: ImageGenerationRequest, options: MediaCallOptions = {}): Promise<ImageGenerationResult> {
    return this.requestJSON("render/image", { body: { model: request.model, prompt: request.prompt, ...request.parameters }, signal: options.signal });
  }
}
class MixedProvider extends OpenAIProvider implements ImageProvider, AudioProvider, VideoProvider {
  generateImages(request: ImageGenerationRequest, options: MediaCallOptions = {}): Promise<ImageGenerationResult> {
    return this.requestJSON("render/image", { body: { model: request.model, prompt: request.prompt, ...request.parameters }, signal: options.signal });
  }
  async generateAudio(request: AudioGenerationRequest, options: MediaCallOptions = {}): Promise<AudioGenerationResult> {
    const response = await this.request("render/audio", { body: { model: request.model, text: request.prompt, ...request.parameters }, signal: options.signal });
    return { artifacts: [{ kind: "audio", mimeType: "audio/mpeg", source: { type: "bytes", bytes: await this.readBytes(response, options.signal) } }] };
  }
  createVideo(request: VideoGenerationRequest, options: MediaCallOptions = {}): Promise<VideoTask> {
    return this.requestJSON("render/video/tasks", { body: { model: request.model, prompt: request.prompt, ...request.parameters }, signal: options.signal });
  }
  getVideoTask(taskId: string, options: MediaCallOptions = {}): Promise<VideoTask> {
    return this.requestJSON(`render/video/tasks/${encodeURIComponent(taskId)}`, { method: "GET", signal: options.signal });
  }
  cancelVideoTask(taskId: string, options: MediaCallOptions = {}): Promise<VideoTask> {
    return this.requestJSON(`render/video/tasks/${encodeURIComponent(taskId)}`, { method: "DELETE", signal: options.signal });
  }
}

describe("3.0 inheritable providers and independent media capabilities", () => {
  it("allows an image-only subclass without a fake chat method and narrows capabilities", async () => {
    const provider = new ImageOnly({ baseURL: "https://gateway.test/v1", transport: async () => json({ artifacts: [image] }) });
    assert(provider instanceof Provider); assert.equal(supportsCapability(provider, "chat"), false);
    assert.equal(supportsCapability(provider, "image"), true); assert.equal(supportsCapability(provider, "audio"), false);
    assert.equal(supportsCapability({ createVideo() {} }, "video"), false);
    const unknown: unknown = provider;
    if (supportsCapability(unknown, "image")) assert.equal((await unknown.generateImages({ model: "image", prompt: "landscape" })).artifacts[0].kind, "image");
    if (false) {
      // @ts-expect-error Media-only providers cannot drive a chat Generator.
      new Generator({ provider, model: "chat" });
    }
  });
  it("reuses an inherited chat provider's credentials/transport without mixing chat and image parameters", async () => {
    const requests: HttpRequest[] = []; let keys = 0;
    const provider = new MixedProvider({ apiKey: async () => { keys++; return "secret"; }, baseURL: "https://gateway.test/v1/", headers: { "X-Business": "tenant" }, transport: async request => {
      requests.push(request);
      return request.url.endsWith("render/image") ? json({ artifacts: [image] }) : json({ choices: [{ message: { role: "assistant", content: "chat" }, finish_reason: "stop" }] });
    } });
    const result = await new Generator({ provider, model: "chat", generation: { temperature: 0.4 } }).generate({ messages: [Message.user("hello")], stream: false });
    const images = await provider.generateImages({ model: "image", prompt: "landscape", parameters: { quality: "high" } });
    assert.equal(result.message.text, "chat"); assert.equal(images.artifacts.length, 1); assert.equal(keys, 2);
    assert(requests.every(request => request.headers.authorization === "Bearer secret" && request.headers["x-business"] === "tenant"));
    const imageBody = requests[1].body as Record<string, unknown>; assert.equal(imageBody.temperature, undefined); assert.equal(imageBody.quality, "high");
    assert.equal(supportsCapability(provider, "chat"), true); assert.equal(supportsCapability(provider, "video"), true);
  });
  it("supports provider-specific auth overrides for inherited media methods", async () => {
    let wire: HttpRequest | undefined;
    class ImagesOnGemini extends GeminiProvider implements ImageProvider {
      generateImages(request: ImageGenerationRequest): Promise<ImageGenerationResult> { return this.requestJSON("render/image", { body: { prompt: request.prompt } }); }
    }
    await new ImagesOnGemini({ apiKey: "key", baseURL: "https://gateway.test", transport: async request => { wire = request; return json({ artifacts: [image] }); } }).generateImages({ model: "image", prompt: "hello" });
    assert.equal(wire!.headers["x-goog-api-key"], "key"); assert.equal(wire!.headers.authorization, undefined);
  });
  it("overrides headers case-insensitively without duplicate authorization values", async () => {
    let wire: HttpRequest | undefined;
    await new ImageOnly({ apiKey: "default", baseURL: "https://gateway.test", headers: { Authorization: "Custom token" }, transport: async request => { wire = request; return json({ artifacts: [image] }); } }).generateImages({ model: "image", prompt: "hello" });
    assert.equal(wire!.headers.authorization, "Custom token");
  });
  it("delivers image previews separately from completed artifacts and releases the SSE reader", async () => {
    let cancelled = false;
    class StreamingImages extends Provider implements ImageProvider {
      async generateImages(request: ImageGenerationRequest, options: MediaCallOptions = {}): Promise<ImageGenerationResult> {
        const response = await this.request("render/image", { body: { prompt: request.prompt }, signal: options.signal });
        const artifacts: MediaArtifact<"image">[] = [];
        for await (const raw of this.readEvents(response, options.signal, { maxEventBytes: 1024 })) {
          const event = raw as { type: string; artifact: MediaArtifact<"image"> };
          if (event.type === "preview") await options.onEvent?.({ type: "mediaPreview", artifact: event.artifact });
          if (event.type === "completed") artifacts.push(event.artifact);
        }
        assert(artifacts.length, "Preview is not a completed output"); return { artifacts };
      }
    }
    const provider = new StreamingImages({ baseURL: "https://gateway.test", transport: async () => new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: "preview", artifact: image })}\n\ndata: ${JSON.stringify({ type: "completed", artifact: image })}\n\ndata: [DONE]\n\n`));
    }, cancel() { cancelled = true; } })) });
    let previews = 0;
    const result = await provider.generateImages({ model: "image", prompt: "hello" }, { onEvent: event => { if (event.type === "mediaPreview") previews++; } });
    assert.equal(previews, 1); assert.equal(result.artifacts.length, 1); assert.equal(cancelled, true);
  });
  it("returns binary audio without forcing it into Message JSON", async () => {
    const provider = new MixedProvider({ transport: async () => new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "audio/mpeg" } }) });
    const result = await provider.generateAudio({ model: "speech", prompt: "text to speak" });
    const source = result.artifacts[0].source; assert.equal(source.type, "bytes"); if (source.type === "bytes") assert.deepEqual([...source.bytes], [1, 2, 3]);
  });
  it("supports custom multipart upload using the inherited attachment resolver", async () => {
    let wire: HttpRequest | undefined; let resolved: string | undefined;
    class VoiceProvider extends Provider implements AudioProvider {
      async generateAudio(request: AudioGenerationRequest, options: MediaCallOptions = {}): Promise<AudioGenerationResult> {
        const media = await this.resolveMedia(request.inputs![0].url, options.signal);
        const bytes = Uint8Array.from(atob(media.base64), char => char.charCodeAt(0));
        const form = new FormData(); form.set("model", request.model); form.set("file", new Blob([bytes], { type: media.mimeType }), "sample.wav");
        const response = await this.request("voice", { body: form, signal: options.signal });
        return { artifacts: [{ kind: "audio", mimeType: "audio/wav", source: { type: "bytes", bytes: await this.readBytes(response, options.signal) } }] };
      }
    }
    const provider = new VoiceProvider({ baseURL: "https://gateway.test", headers: { "Content-Type": "application/json" }, mediaResolver: { async resolve(url) { resolved = url; return { base64: btoa("sample"), mimeType: "audio/wav" }; } }, transport: async request => { wire = request; return new Response(new Uint8Array([7])); } });
    await provider.generateAudio({ model: "voice", prompt: "hello", inputs: [{ type: "audio", url: "appfile://voice" }] });
    assert.equal(resolved, "appfile://voice"); assert(wire!.body instanceof FormData); assert.equal(wire!.headers["content-type"], undefined);
    assert.equal((wire!.body as FormData).get("model"), "voice");
  });
  it("resumes video by querying a saved task ID and does not submit or remotely cancel on local abort", async () => {
    const requests: HttpRequest[] = []; let queries = 0; const controller = new AbortController();
    const provider = new MixedProvider({ baseURL: "https://gateway.test", transport: async request => {
      requests.push(request);
      if (request.method === "POST") return json({ id: "task-1", status: "queued" });
      if (request.method === "DELETE") return json({ id: "task-1", status: "cancelled" });
      if (++queries === 1) { controller.abort(new DOMException("stop local waiting", "AbortError")); return new Promise<Response>(() => {}); }
      return json({ id: "task-1", status: "completed", artifacts: [{ kind: "video", mimeType: "video/mp4", source: { type: "url", url: "https://artifacts.test/video.mp4" } }] });
    } });
    const task = await provider.createVideo({ model: "video", prompt: "landscape" }); const saved = JSON.parse(JSON.stringify(task)) as VideoTask;
    await assert.rejects(provider.getVideoTask(saved.id, { signal: controller.signal }), error => error instanceof DOMException && error.name === "AbortError");
    const result = await provider.getVideoTask(saved.id); assert.equal(result.status, "completed");
    assert.deepEqual(requests.map(request => request.method), ["POST", "GET", "GET"]); assert.equal(requests[1].body, undefined);
    await provider.cancelVideoTask(saved.id); assert.equal(requests.at(-1)!.method, "DELETE");
  });
  it("does not submit cancelled paid operations and shares structured HTTP errors", async () => {
    let submissions = 0; const controller = new AbortController(); controller.abort(new DOMException("cancel", "AbortError"));
    const provider = new ImageOnly({ baseURL: "https://gateway.test", transport: async () => { submissions++; return json({ artifacts: [image] }); } });
    await assert.rejects(provider.generateImages({ model: "image", prompt: "hello" }, { signal: controller.signal })); assert.equal(submissions, 0);
    const failed = new ImageOnly({ baseURL: "https://gateway.test", transport: async () => json({ error: { message: "denied" } }, 403) });
    await assert.rejects(failed.generateImages({ model: "image", prompt: "hello" }), error => error instanceof ProviderRequestError && error.status === 403);
  });
  it("enforces binary and SSE limits and cleans a blocked binary read on cancellation", async () => {
    let cancelled = false; const oversized = new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(5)); }, cancel() { cancelled = true; } }));
    await assert.rejects(readResponseBytes(oversized, undefined, 4), /maxBytes/); assert(cancelled); assert.equal(oversized.body!.locked, false);
    const signal = new AbortController(); const blocked = new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1])); } }));
    const pending = readResponseBytes(blocked, signal.signal); signal.abort(new DOMException("stop", "AbortError")); await assert.rejects(pending); assert.equal(blocked.body!.locked, false);
    const events = new Response(`data: ${JSON.stringify({ text: "你好" })}\n\n`);
    await assert.rejects(async () => { for await (const _ of decodeSSE(events, undefined, { maxEventBytes: 8 })) {} }, /maxEventBytes/); assert.equal(events.body!.locked, false);
  });
  it("sends JSON, multipart, binary and GET bodies through default fetch without double encoding", async context => {
    const requests: RequestInit[] = [];
    context.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => { requests.push(init); return new Response(); });
    const form = new FormData(); form.set("name", "value"); const bytes = new Uint8Array([1, 2]);
    await fetchTransport({ url: "https://gateway.test", method: "POST", stream: false, headers: {}, body: { hello: "world" } });
    await fetchTransport({ url: "https://gateway.test", method: "POST", stream: false, headers: { "Content-Type": "application/json" }, body: form });
    await fetchTransport({ url: "https://gateway.test", method: "POST", stream: false, headers: { "content-type": "audio/wav" }, body: bytes });
    await fetchTransport({ url: "https://gateway.test", method: "GET", stream: false, headers: {} });
    assert.equal(requests[0].body, '{"hello":"world"}'); assert.equal(new Headers(requests[0].headers).get("content-type"), "application/json");
    assert.equal(requests[1].body, form); assert.equal(new Headers(requests[1].headers).get("content-type"), null);
    assert.equal(requests[2].body, bytes); assert.equal(requests[3].body, undefined);
  });
  it("round-trips video parts in every session and refuses unsupported chat codecs before sending", async () => {
    for (const session of [TreeSession.create(), ListSession.create(), AgentSession.create()]) {
      const message = session.addUser("watch this").addVideo("appfile://clip.mp4", "video/mp4"); assert(message.hasMedia);
      const restored = restoreSession(JSON.parse(JSON.stringify(session.toJSON()))); assert.deepEqual(restored.query.messages({ partType: "video" })[0].parts, message.parts);
    }
    let requests = 0; const provider = new OpenAIProvider({ transport: async () => { requests++; return json({}); } });
    await assert.rejects(provider.buildRequest({ model: "chat", messages: [Message.user("").addVideo("appfile://clip")] }), /override serializeMessages/); assert.equal(requests, 0);
  });
  it("allows inherited chat serialization hooks and structural custom chat providers to handle video", async () => {
    class VideoAware extends OpenAIProvider {
      protected async serializeMessages(request: ModelRequest): Promise<SerializedMessages> {
        return { messages: request.messages.map(message => ({ role: message.role, content: message.parts.map(part => part.type === "video" ? { type: "custom_video", url: part.url } : part) })) };
      }
    }
    const message = Message.user("watch").addVideo("appfile://clip"); const provider = new VideoAware();
    const request = await provider.buildRequest({ model: "chat", messages: [message] }, false);
    assert(JSON.stringify(request.body.messages).includes("custom_video"));
    const custom: ChatProvider = { async generate(request) { assert.equal(request.messages[0].parts.at(-1)!.type, "video"); return { message: Message.assistant("generated").addVideo("appfile://output") }; } };
    const response = await new Generator({ provider: custom, model: "chat" }).generate({ messages: [message] }); assert.equal(response.message.parts.at(-1)!.type, "video");
  });
});
