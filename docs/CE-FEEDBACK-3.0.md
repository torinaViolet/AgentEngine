# CharacterEditor 反馈落实与接入契约

2026-10-08，对应 AgentEngine 3.0.0。依据 CE 的 [需求文档](D:/Code/NodeJs/CharacterEditor/docs/plans/2026-10-08-agentengine-3-feedback.md)。此次修改与合成验证均在 AgentEngine 中完成，CharacterEditor 的代码和原反馈文档未修改。

## 反馈处理结果

| CE 编号 | 已实现的接口与行为 |
| --- | --- |
| 1 运行中的业务状态写入 | Message.revision 记录全部编辑；requestRevision 只记录内容和请求相关元数据。业务 metadata/tags 可在运行中写入，不冲突、不使后续候选失效；真正的内容、协议和结构编辑仍检测冲突。 |
| 2 续写提示词排版 | 临时思考和继续指令先交给 PromptBuilder，带可识别 tags 与 sources；previewContext({kind:"continue",...}) 走同一路径。 |
| 3 续写合并 | 默认最新业务 metadata 浅覆盖、tags 并集；beforeCommit 可读取目标快照，beforeAppend 可修改默认合并草稿。带工具调用的 thinking 只存一份。 |
| 4 会话业务槽 | Session.metadata/setMeta/deleteMeta，独立 JSON 数据，保存且不影响租约。系统消息 metadata 也继续支持。 |
| 5 大量旧会话迁移 | 公开带类型的 SessionData 和结构类型，平坦表直接导入，保留外部节点/消息 ID、根/兄弟顺序与当前路径。 |
| 6 编译器来源标签 | transform 返回 Message[] 或 {messages,sources}；旧变换兼容，新标签可通过后续变换保留。 |
| 7 传输标志 | HttpRequest.stream 必填 boolean，purpose 可区分 chat/image/audio/video/embedding/models/custom。单次请求超时由业务传输层处理。 |
| 8 思考策略 | Generator、Agent 构造和单次运行均可配置 thinking，逐字段覆盖；Agent 默认 auto/tool_call。 |
| 确认：向量 | 新增 EmbeddingProvider/EmbeddingRequest/EmbeddingResult；可继承 Provider 实现 embed，复用传输。当前没有内置厂商向量协议。 |
| 确认：多段思考 | 无工具调用的续写保留独立 thinking 块，CE 可显示为旧思考、分隔、新思考。工具思考单独留在协议载体中，可按执行记录关联显示。 |

完整参数见 [API](./API.md)，媒体和向量契约见 [Provider 扩展](./MULTIMEDIA-3.0.md)。

## 状态与冲突

```ts
// 工具、宏结算和提交通知均可写入业务状态。
session.setMeta("stateDocument", { variables: { count: 1 }, notes: [] });
session.setMeta("started", true);
message.setMeta("stateRoot", "state/next").tag("undoable");

// 自定义编码/编译依赖的键应标为请求相关。
message.setMeta("customRouting", "model-port/1", { affectsRequest: true });
```

Message 的 requestMetadataKeys 将自定义标记随序列化保存。内置保留键 thinkingSignature、geminiThinkingSignature、openaiReasoningItems、toolName、name 默认参与冲突检测。不能通过 affectsRequest:false 取消已有标记。

setText、setParts 等内容编辑仍触发冲突，内容块的 metadata 也是内容。系统文本编辑、选中路径或候选切换同样检测。ListSession 以请求版本判断后续候选是否失效。Session.metadata 不是模型输入；编译器若将业务状态转为提示词，应自行明确状态结算时点，依赖的消息 metadata 可使用上述请求标记。

## 提示词编译与预览

```ts
import {
  PromptBuilder, Message, CONTINUATION_INSTRUCTION_TAG,
} from "@notic/agent-engine";

const promptBuilder = new PromptBuilder().use(messages => {
  // 续写时这里已包含带标签的临时 User。
  const instruction = messages.find(m => m.hasTag(CONTINUATION_INSTRUCTION_TAG));
  const world = Message.system("世界书: 城市规则");
  const index = instruction ? messages.indexOf(instruction) : messages.length;
  return {
    messages: [...messages.slice(0, index), world, ...messages.slice(index)],
    sources: [{ messageId: world.id, source: "世界书: 城市", injected: true }],
  };
});

const continueOptions = { instruction: "继续上一条回复，不重复原内容。", carryThinking: true };
const preview = await agent.previewContext({ kind: "continue", ...continueOptions });
// preview.messages / preview.sources 可供调试面板使用。
await agent.continue(continueOptions);
```

示例的 agent 应使用上面的 promptBuilder。CE 可将编译器的输出直接映射为 {messages,sources}，sources 以 messageId 对应最终输出，sourceMessageId 可关联原历史消息。临时消息的 ID 每次构建不同；预览对齐角色、内容、标签、来源与排版，不能把它的临时 ID 当成下一次请求的持久身份。

预览不消费 injection life、不写 Session，不调用 beforeRequest 或 Provider 编码。应将希望预览的排版放在变换内；变换自己产生的外部副作用不会被引擎撤销。

## 续写保存与显示

```ts
const agent = new Agent({
  provider, model: "your-model", session, promptBuilder,
  hooks: {
    beforeCommit(generated, context) {
      generated.setMeta("modelName", "your-model").tag("generated");
      // context.operation === "append" 时 context.targetMessage 是目标快照。
    },
    beforeAppend(draft, context) {
      // draft 已含默认内容/metadata/tags 合并；保留原消息 ID。
      draft.setMeta("components", renderComponents(draft.text));
      draft.setMeta("stateRoot", context.generatedMessage.metadata.stateRoot
        ?? context.targetMessage.metadata.stateRoot ?? null);
      draft.deleteMeta("obsoleteRenderCache");
    },
    async afterCommit(actual) {
      await messageStore.save(actual.toJSON());
    },
  },
});
```

beforeCommit 先处理生成消息，beforeAppend 再处理目标草稿。两个目标快照与生成快照都隔离于 Session；beforeAppend 失败时不提交草稿。异步钩子等待期间新增的无关业务 metadata/tags 会保留，草稿显式修改的键按钩子处理。已提交的内容不会因为 afterCommit 持久化失败而撤回。

默认合并只更新目标消息，其他分支的显式业务状态保持原值。业务自行计算分支状态继承。带工具调用的续写会另存生成 ID 对应的协议消息，包含该步的 thinking 和 tool_call；目标只接收其正文/媒体，避免两处保存相同思考。签名保留在对应思考块中，原生 reasoning items 按协议合并或保留在工具载体。

## 平坦树直接导入

以下为最小可导入示例。已有 CE 数据可逐表转换，不必调用 select/addMessage 重放。

```ts
import { Message, Role, TreeSession, type TreeSessionData } from "@notic/agent-engine";

const system = new Message(Role.System, "角色提示", {}, { id: "ce/system" });
const user = new Message(Role.User, "你好", {}, { id: "ce/user/1" });
const left = new Message(Role.Assistant, "候选一", {}, { id: "ce/reply/1" });
const right = new Message(Role.Assistant, "候选二", {}, { id: "ce/reply/2" });
const data: TreeSessionData = {
  format: "agent-engine-session", version: 3, type: "tree", id: "ce/session/1",
  metadata: { started: true }, systemMessageId: system.id,
  messages: [system, user, left, right].map(m => m.toJSON()),
  trace: { turns: [], runs: [], steps: [], tools: [], contributions: [] },
  structure: {
    nodes: [
      { id: "n/right", messageId: right.id, parentId: "n/user", children: [] },
      { id: "n/user", messageId: user.id, parentId: null, children: ["n/left", "n/right"] },
      { id: "n/left", messageId: left.id, parentId: "n/user", children: [] },
    ],
    roots: ["n/user"], cursor: "n/right",
  },
};
const session = TreeSession.fromJSON(data);
// history(): system → user → 候选二；候选顺序仍是 left、right。
```

roots 指定根节点顺序，children 指定兄弟顺序，nodes 表顺序不影响两者。Message ID 和节点 ID 可以是非空的业务字符串，只要求在各自表内唯一；系统消息不能同时成为普通树节点。fromJSON 校验父子引用、重复节点、循环、可达性、选中节点等。

历史没有真实 Turn/Run/Step 时像示例一样保留空 trace，不根据文本伪造工具执行或用量；若 CE 有可信的交互记录，可显式迁移到 trace。导入不会恢复运行控制器或待审批操作。旧数据迁移步骤见 [迁移说明](./MIGRATION-3.0.md)。

## 传输与思考配置

transport 可直接用 request.stream / request.purpose 决定联网策略，不必解析平台 body 或 URL。执行预算 execution.timeoutMs 仍涵盖整次模型、工具和审批等待；CE 的单次非流式模型超时应在自己的 transport 中实现，并继续传递 signal。

```ts
const agent = new Agent({
  provider, model: "your-model", session,
  thinking: { mode: "native", scope: "tool_call" },
});
await agent.run({ thinking: { mode: "message" } });
await agent.continue({ thinking: { mode: "none" }, carryThinking: false });
```

覆写逐字段合并，不改变下一次调用的默认配置。carryThinking 控制续写临时的文本思考载体，thinking 控制原消息 thinking 块的协议回传。

## 验证与剩余接入工作

`test/v3/ce-feedback.test.ts` 新增 16 项测试，覆盖三种 Session 的运行期状态写入、真实编辑冲突、候选有效性、续写排版/预览/来源、钩子成功与失败、取消部分输出、异步业务写入、工具思考去重、平坦导入及顺序、存储兼容、流标志、思考配置和向量扩展。

2026-10-08 的 npm test：241 项测试，240 通过，1 项真实 API 测试跳过；75 项 3.0 测试全部通过。TypeScript、浏览器构建与无 Buffer 的运行、包导出检查通过。测试使用合成数据与 fake transport，没有真实平台调用。

CE 后续在自己的项目中适配 Provider 端口、提示词编译器、平坦 Session codec、续写、事件投影与审批。此文是对接依据，不代表 CE 已完成迁移、数据库存储验证或实际供应商联调。
