# Provider 继承与多媒体能力

2026-10-08：补齐首次重构遗漏的媒体生成扩展契约。此文对应实际公开接口；CharacterEditor 未修改。

## 业务依据与边界

CharacterEditor 的 `ui/src/features/media/adapters.ts` 包含图片生成（含渐进预览）、MiniMax 语音合成（JSON/音频分片）和 Seedance 视频创建/查询。`jobs.ts` 保存任务 ID、下载和保存产物、恢复已有任务；`tools/mediaTools.ts` 将这些能力提供给 Agent 工具。媒体参数由 `features/models/mediaParameters.ts` 单独管理。

这些能力与聊天附件输入分别设计：Message 可以承载图片、音频、视频和文件；Provider 的媒体生成返回产物或任务。聊天 generation 参数不自动传给媒体接口。业务数据库、appfile 注册、保存重试、模型目录、展示和预览 URL 生命周期仍属于业务。

## 基类与能力接口

`Provider` 是可继承的抽象基类，提供公共 HTTP/附件基础设施；基类没有聊天或媒体占位方法。子类只实现支持的操作。也可以继承已有 OpenAIProvider、OpenAIResponsesProvider、AnthropicProvider、GeminiProvider，再增加媒体接口，复用其鉴权与聊天功能。

| 能力 | 接口 | 方法 |
| --- | --- | --- |
| 聊天 | ChatProvider | generate(request,options,emit?) |
| 图片生成 | ImageProvider | generateImages(request,options?) |
| 音频生成/语音合成 | AudioProvider | generateAudio(request,options?) |
| 视频生成 | VideoProvider | createVideo(request,options?)、getVideoTask(taskId,options?)，可选 cancelVideoTask |
| 向量 | EmbeddingProvider | embed(request,options?) |

Agent 与 Generator 只要求结构化的 ChatProvider，不要求继承；仅支持媒体或向量的 Provider 无需伪造聊天方法。`supportsCapability(provider, "chat" | "image" | "audio" | "video" | "embedding")` 检查操作并收窄 TypeScript 类型。它表示实现了操作；具体模型是否支持仍由业务模型目录决定。

内置三家 Provider 当前实现的是聊天协议。此次新增的是媒体能力契约、继承基础设施与合成验证，未新增 OpenAI Images、MiniMax 或 Seedance 的生产协议实现。业务可将已有 adapter 接到这些接口，之后也能将通用协议实现贡献到框架。

## 一个扩展例子

下面使用业务网关的归一化响应作示例，`/media/images` 是示例路由，不是厂商 API。

```ts
import {
  OpenAIProvider, supportsCapability,
  type ImageProvider, type ImageGenerationRequest,
  type ImageGenerationResult, type MediaCallOptions,
} from "@notic/agent-engine";

class BusinessProvider extends OpenAIProvider implements ImageProvider {
  async generateImages(
    input: ImageGenerationRequest,
    options: MediaCallOptions = {},
  ): Promise<ImageGenerationResult> {
    const result = await this.requestJSON<ImageGenerationResult>("media/images", {
      body: { model: input.model, prompt: input.prompt, ...input.parameters },
      signal: options.signal,
      stream: false, purpose: "image",
    });
    if (!Array.isArray(result.artifacts)) throw new Error("Invalid image response");
    return result;
  }
}

const provider = new BusinessProvider({ baseURL: "https://your-gateway/v1", apiKey: "key" });
if (supportsCapability(provider, "image")) {
  const result = await provider.generateImages({
    model: "your-image-model", prompt: "湖边的房屋",
    parameters: { quality: "high" },
  });
  await artifactStore.save(result.artifacts);
}
// 同一实例仍可传给 Agent / Generator，使用继承的聊天接口。
```

原生 API 子类自行转换和校验输入/输出；requestJSON 的泛型不做运行时 schema 校验。ImageProvider/AudioProvider/VideoProvider 支持参数泛型，例如 `ImageProvider<{ quality?: "high" | "low" }>`；也可在工具入口用 JSON Schema 约束模型可传参数。

纯媒体提供者直接 `extends Provider implements AudioProvider` 即可。媒体基类提供的 protected 接口：

| 接口 | 用途 |
| --- | --- |
| options、baseURL | 子类配置与基础地址 |
| resolveApiKey(signal?)、authHeaders(signal?) | 获取异步凭据；覆盖特定服务的鉴权 |
| buildHttpRequest(path,init)、send(request) | 构建请求、使用公共传输和 HTTP 错误处理 |
| request(path,init)、requestJSON<T>(path,init) | 相对 baseURL 发送请求，返回 Response 或 JSON |
| readEvents(response,signal?,{maxEventBytes?}) | SSE 解帧，协议事件由子类处理 |
| readBytes(response,signal?,maxBytes?) | 可取消、有大小限制的二进制读取 |
| resolveMedia(url,signal?) | 复用附件解析器，处理业务地址 |

init 支持 method、body、headers、signal、stream、purpose。transport 支持 GET/POST/PUT/PATCH/DELETE，body 可以是 JSON、FormData、二进制或其他标准 BodyInit。基类总是输出明确的 stream:boolean（默认 false）；purpose 默认 custom，可设 chat/image/audio/video/embedding/models/custom。子类负责声明真实流式行为，例如使用 SSE 的图片请求设置 stream:true、purpose:image。业务传输层据此决定单次请求超时；Agent.execution.timeoutMs 仍是整次运行预算。

默认传输保留原始二进制/FormData，不重复 JSON 编码；multipart 的 Content-Type 由 fetch 生成边界。相对请求复用凭据；产物下载使用独立业务传输，避免把供应商鉴权带到产物域名。

SSE 默认单事件上限 16 MiB，可按图片分片需要明确设置 maxEventBytes；二进制默认 64 MiB，可显式设置 maxBytes。取消及失败会释放读取器，已取消的请求不会由基类提交给 transport。停止本地等待不表示远端任务已撤销。

## 请求、产物与事件

ImageGenerationRequest、AudioGenerationRequest、VideoGenerationRequest 共用 model、prompt、inputs?、parameters?。语音合成的 prompt 是朗读文本；inputs 是图片/音频/视频/文件引用。参数归属媒体接口，不混入 GenerationConfig。

图片/音频返回 `{ artifacts, model?, usage?, metadata? }`，每项包含 kind、mimeType、source、metadata?。source 显式区分：

```ts
{ type: "url", url: "https://..." }
{ type: "bytes", bytes: new Uint8Array(...) }
{ type: "base64", base64: "..." }
```

二进制产物保留在响应中，业务保存后可将 URL 放入 Message；不会强迫把字节放进会话 JSON。usage 为媒体指标字典，不强制套用聊天 token 统计。流式 options 支持 signal、stream、onEvent；事件为 mediaPreview、mediaChunk、mediaProgress。预览与最终产物区分，子类须在完整产物到达后才完成 Promise。

## 视频任务与恢复

```ts
const task = await videoProvider.createVideo({ model: "video", prompt: "湖边日落" });
await taskStore.save(task); // 优先持久化 id 与供应商选择
const current = await videoProvider.getVideoTask(task.id, { signal });
// 重启/超时后继续 getVideoTask(existingId)，不再次调用 createVideo。
```

VideoTask 包含 id、status、model?、artifacts?、error?、metadata?。归一状态为 queued/running/completed/failed/cancelled。createVideo 创建一次任务；getVideoTask 查询一次，不隐含重新提交或自动轮询。业务按自己的时限/间隔等待，保存原始任务 ID 与供应商信息。

本地 signal 仅控制本地请求/等待。cancelVideoTask 是可选的显式远端取消接口，未实现时不会伪装成远端取消成功。提交发生后但未收到任务 ID 的网络失败不能确认服务端是否接受，业务不能默认自动重提。

## 视频消息与聊天转换

Message.addVideo(url,mimeType?) 和 VideoPart 已实现；三种 Session 都能查询、编辑、保存和恢复视频内容。内置聊天 codec 尚未编码视频输入，会明确报错，避免丢弃。

HttpProvider 的 `protected serializeMessages(request,signal?)` 是公开扩展点，返回 SerializedMessages（messages 与可选 systemMessage）。子类可通过它将视频映射到自己的协议，继续复用 buildRequest 和原有响应解析；全新聊天协议则实现 ChatProvider.generate。输入能力与视频生成能力独立。

## 向量扩展

EmbeddingRequest 为 `{model,input:string|readonly string[],dimensions?,providerOptions?}`，EmbeddingResult 为 `{embeddings:{index,vector:number[]}[],model?,usage?:{inputTokens,totalTokens}}`。embed 的 options 支持 signal；当前仅提供能力契约，没有内置 OpenAI /embeddings 编码实现。业务转换供应商输出、验证向量后返回统一结果，可像媒体一样继承 Provider 复用 requestJSON。

```ts
import {
  Provider, type EmbeddingProvider, type EmbeddingRequest, type EmbeddingResult,
} from "@notic/agent-engine";

// 示例网关已返回统一结构；供应商原生响应应在子类中显式转换和校验。
class BusinessEmbeddingProvider extends Provider implements EmbeddingProvider {
  async embed(input: EmbeddingRequest, options: { signal?: AbortSignal } = {}): Promise<EmbeddingResult> {
    const result = await this.requestJSON<EmbeddingResult>("embedding", {
      body: { model: input.model, input: input.input, dimensions: input.dimensions },
      signal: options.signal, stream: false, purpose: "embedding",
    });
    if (!Array.isArray(result.embeddings)) throw new Error("Invalid embedding response");
    return result;
  }
}
```

向量调用不创建 Message、不写 Session、不经过 Agent 模型循环。检索索引、缓存和持久化由业务维护。继承与 capability 验证见 `test/v3/ce-feedback.test.ts`。

## 通过工具接入 Agent

Agent 不自动选择媒体模型或调用媒体方法。业务注册 Tool，在 execute 中调用对应 capability，传递 context.signal，保存产物并返回可序列化文件引用。独立 ToolExecutor 负责执行前审批；VideoTask ID 和未完成状态可作为工具结果返回，再通过任务查询工具继续。

合成验证见 `test/v3/multimedia.test.ts`，覆盖纯媒体和混合继承、鉴权、渐进图片、音频字节、multipart、视频恢复/取消、传输错误、读取限制与视频消息转换。浏览器运行验证也覆盖基类继承和二进制读取。没有调用真实媒体服务。
