# 2.x → 3.0 迁移

3.0 是破坏性升级，根入口切换到新的独立模块。当前版本为 3.0.0。保存数据升级与业务调用升级分别处理。

## 旧业务过渡

原实现保留在 src/legacy，可先修改导入：

```ts
import { Agent, Session, StreamEventType } from "@notic/agent-engine/legacy";
import { OpenAIAdapter } from "@notic/agent-engine/legacy/adapter";
```

旧模型客户端仍由业务传入 SDK/兼容客户端。厂商 SDK 已从框架 runtime/peer 依赖移除，legacy 应用自行安装其使用的 SDK。旧测试覆盖兼容入口，原 demo 使用 legacy。新旧 Message/Session 不混用。

## 接口变化

| 2.x | 3.0 |
| --- | --- |
| Agent({client,model,session}) | Agent({provider,model,session}) 或传 generator |
| 聊天 Provider 类型 | ChatProvider 结构化契约；Provider 是可继承的通用 HTTP 基类 |
| Session.create(prompt) | TreeSession.create(prompt) |
| AgentSession 接口 | SessionLike 契约；AgentSession 是按交互轮组织的具体类 |
| Message.parent/children/add/branch | TreeSession.nodes/nodeFor/select/addMessage/remove |
| agent.run(userInput) | agent.chat(userInput)，通过 result.message 取回复 |
| agent.generate() | 已有上下文自主运行：agent.run；一次请求：generator.generate |
| agent.runRaw | 独立 Generator，业务自己处理结果 |
| RequestConfig/requestOptions | generation、execution、tools、PromptBuilder 四个归属 |
| maxTurns 表示模型调用限制 | execution.maxSteps，默认 10 |
| Agent 内工具审批 | 独立 ToolExecutor，Agent 提供代理审批方法 |
| Param/ValueType | Tool.define/new Tool，参数用 JSON Schema |
| StreamEventType.TEXT_DELTA | textDelta 等字符串事件，含 messageId/stepId |
| Message.usage | Step.usage 和 AgentResult.usage |
| 同步 PromptBuilder/Rule | 异步 build/preview/use，规则作为业务 transform |

```ts
import { Agent, TreeSession, OpenAIProvider, PromptBuilder } from "@notic/agent-engine";
const session = TreeSession.create("系统提示");
const agent = new Agent({
  provider: new OpenAIProvider({ baseURL: "https://your-proxy/v1", apiKey: "key" }),
  model: "your-model", session, promptBuilder: new PromptBuilder(),
  generation: { temperature: 0.5, maxOutputTokens: 2048 },
  execution: { maxSteps: 10 },
  hooks: {
    beforeCommit(message) { message.setText(normalizeForStorage(message.text)); },
    async afterCommit(message) { await store.save(message.toJSON()); },
  },
});
session.addUser("已准备好的输入");
const result = await agent.run();
```

网络代理迁到 transport，附件地址解析迁到 mediaResolver；平台参数可用 providerOptions，与统一参数冲突会报错。运行错误用 AgentRunError.result 读取保留进度。数据存储、角色宏、世界书和界面展示继续由业务控制。

媒体生成 adapter 可继承 Provider 并实现 ImageProvider/AudioProvider/VideoProvider，向量请求可实现 EmbeddingProvider；也可扩展已有厂商 Provider，详见 [媒体扩展](./MULTIMEDIA-3.0.md)。transport 的 body 现为可选 JSON/BodyInit，检查聊天 wire body 时使用 ChatHttpRequest 或 isJsonBody 做类型收窄。自建 HttpRequest 描述必须提供 stream:boolean；基类请求可指定 purpose，业务可以据此配置单次请求超时。

## 保存数据

3.0 存储为 version=3 的平坦消息表、结构表和执行记录表。restoreSession 只接受该格式，旧递归 Message 树不能直接传入。先保留旧数据，再显式迁移。

推荐把旧树一次映射为 TreeSessionData：消息表读取 role/parts/metadata/tags，节点表保留 id/messageId/parentId/children，structure.roots 保留根顺序，cursor 保留当前节点，再调用 TreeSession.fromJSON 或 restoreSession 校验导入。消息与节点 ID 独立，只需各自表内唯一的非空字符串，支持原业务 ID。children 顺序保留候选翻页顺序，nodes 表无需按父子顺序排列。公开类型与可运行的最小数据示例见 [CE 接入契约](./CE-FEEDBACK-3.0.md)。

旧空 root 改为独立系统消息，用 systemMessageId 引用，不当作普通树节点或真实用户输入。旧根上的会话变量、笔记文档可迁至 SessionData.metadata；属于系统消息本身的 metadata 可保留。修改 systemPrompt 文本不会清除系统消息 metadata。也可以逐条 addMessage 接入新树，但会生成新节点 ID，已有外部节点引用和大量历史更适合直接映射。

MessageData 新增可选 requestRevision/requestMetadataKeys。早期 3.0 快照未写前者时以 revision 初始化；未写后者仍默认标记内置协议键。metadata/tags 的业务编辑不再造成运行冲突，内容与协议编辑仍会；自定义转换依赖的 metadata 键用 setMeta(key,value,{affectsRequest:true}) 标记。Session metadata 缺省为 {}，旧 3.0 树未写 roots 时按节点表中的根顺序导入。

旧记录缺少真实 Run/Step/工具执行时保留未知，不伪造调用和用量。UI 消息 ID、工具调用 ID、模型步骤 ID 分开映射。导入后可 run 已有上下文，不恢复旧进程审批/执行现场。

## CharacterEditor 接入

此次未修改 CharacterEditor。建议依次更新 ui/src/lib/agent.ts 的导出、providerRuntime 的传输/附件桥接、conversation Session codec、agentRuntime 的生成和审批，再替换 continuation 与事件投影。

区分 messageGenerated（模型输出）与 messageCommitted（转换后保存内容）；宏副作用在提交成功后结算，预览用 builder.preview 或 agent.previewContext。续写预览使用 {kind:"continue",...}，临时指令与思考先进入变换，旧业务不用再手动写入/删除 Session 指令。变换支持返回 {messages,sources} 接上 CE 编译器标签，原 Message[] 形式仍兼容。

续写 beforeCommit 处理生成消息，可读 context.targetMessage 快照；beforeAppend 编辑默认合并目标草稿，适合组件渲染、状态根与缓存清理。默认最新业务元数据覆盖、标签并集；多段思考保留独立，带工具调用的思考只保存在工具调用载体。运行中的普通业务状态写入不冲突，实际内容/协议/结构编辑冲突时保留 unapplied，由 UI 决定重新生成或应用。

详见 [3.0 API](./API.md) 和 [业务分析](./CHARACTEREDITOR-3.0-NOTES.md)。真实模型与 CharacterEditor 集成仍需在业务环境验证。
