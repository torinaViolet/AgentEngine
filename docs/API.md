# AgentEngine 3.0 API

本文对应当前运行时代码。根入口及 /agent、/message、/session、/prompt、/provider、/generator、/tool 子入口提供新 API。历史方案保留在设计记录；迁移见 [MIGRATION-3.0.md](./MIGRATION-3.0.md)。

## Message：独立可编辑内容

```ts
import { Message, Role } from "@notic/agent-engine";
const message = Message.assistant("第一段");
message.appendText("第二段").appendThinking("思考");
message.addImage("https://example.com/image.png");
message.setText("修改正文"); // 保留思考、媒体、工具等其他类型内容块
message.tag("draft").setMeta("displayName", "助手");
const unsubscribe = message.onChange(({ revision }) => console.log(revision));
```

构造入口：`new Message(role, content?, metadata?, identity?)`、user、assistant、system、`tool(toolCallId, result, name?)`。content 为字符串或内容块数组，支持 text、thinking、image、audio、video、file、tool_call、tool_result。

| 分类 | 接口 |
| --- | --- |
| 读取 | id、role、revision、requestRevision、requestMetadataKeys、parts、text、thinking、toolCalls、isEmpty、hasMedia、metadata、tags |
| 编辑 | setText、appendText、setThinking、appendThinking、setParts、addPart、replacePart(partId,part)、removePart(partId)、update |
| 附件 | addImage(url,mimeType?)、addAudio(url,mimeType?)、addVideo(url,mimeType?)、addFile(url,{mimeType?,fileName?}) |
| 元数据 | setMeta、deleteMeta、tag、untag、hasTag |
| 身份与存储 | snapshot、clone、toJSON、Message.fromJSON |

公开视图在运行时冻结，必须用编辑方法更新。编辑递增 revision，内容块有独立 ID。snapshot 保留身份与版本并隔离内容，clone 创建新身份。内容和元数据须为 JSON 数据，不能包含函数、Map 或循环对象。Message 没有父子节点或 Session 所有权。

requestRevision 专门记录影响请求的编辑：内容块，以及协议元数据。业务 metadata 和 tags 的编辑只递增 revision，允许在提示词结算、工具执行和提交通知期间写入，不使运行租约或 ListSession 的后续行失效。内置协议键为 thinkingSignature、geminiThinkingSignature、openaiReasoningItems、toolName、name，不能把它们当成普通业务状态槽。

自定义 Provider 或提示词转换依赖某个 metadata 键时，可用 `message.setMeta("routing", value, { affectsRequest: true })` 将它标记为请求相关。标记保存在 requestMetadataKeys 中；以后修改或删除这个键都会参与冲突检测，deleteMeta 也支持 affectsRequest。内容块内的 metadata 属于内容编辑，仍影响 requestRevision。`update({parts?,metadata?,tags?,requestMetadataKeys?})` 验证后一起更新，保留消息身份；不提供的字段保持原值。旧 3.0 快照缺少 requestRevision 时以 revision 初始化。

## Session：组织、查询与执行记录

```ts
import { TreeSession, ListSession, AgentSession, restoreSession } from "@notic/agent-engine";
const tree = TreeSession.create("系统提示");
const list = ListSession.create({ candidateUnit: "sequence" });
const rounds = AgentSession.create({ systemPrompt: "系统提示" });
tree.addUser("问题");
const actual = tree.query.messages({ role: Role.User })[0];
actual.setText("修改问题");
tree.editMessage(actual.id, message => message.tag("edited"));
const restored = restoreSession(JSON.parse(JSON.stringify(tree.toJSON())));
```

共用接口：history 返回当前选中历史中的实际 Message（包含独立系统消息）；getMessage、addMessage、addUser、editMessage、systemPrompt、title、metadata、setMeta、deleteMeta、currentTurnId、isGenerating、query、trace、toJSON。手动添加 User 会创建真实交互记录，不推断手动 Assistant 的模型用量。

Session.metadata 是独立的 JSON 业务数据槽，视图冻结，用 setMeta/deleteMeta 编辑，随 toJSON 保存；写入不影响运行租约。会话变量文档、开始脚本标记等可以放在这里。系统消息 metadata 同样受支持，修改 systemPrompt 文本会保留它；实际修改系统提示文本仍会引发运行冲突。

beginGeneration / assertGenerationUnchanged / appendGenerated / appendContinuation / endGeneration 是编排器维护契约。自定义会话实现 SessionLike，或继承 BaseSession；SessionQuery 可接受提供 history / allMessages / trace 的对象。

### TreeSession

nodes 返回节点视图，节点 ID 与 Message ID 分开；rootNodeIds 返回有序根节点 ID。cursorNodeId 指向当前节点，nodeFor(messageId) 查找结构位置，select(nodeId|null) 选择路径；addMessage 在当前位置创建子节点。remove(nodeId,"prune"|"graft") 删除子树或将子节点接到父节点，嫁接保留原位置。系统提示不占空根节点。

重生成时选择回复的父节点，再 agent.run，原分支保留。序列化采用平坦节点表，验证覆盖 3000 层深树。

### 公开存储结构

SessionData 是按 type 区分的 TreeSessionData / ListSessionData / AgentSessionData 联合类型，structure 不再是不透明字段。业务可以直接映射已有的平坦数据并调用 restoreSession，不必逐条重放。

- TreeStructure：`{nodes: TreeNode[], roots?: string[], cursor: string|null}`；每个节点为 `{id,messageId,parentId,children}`。roots 和 children 的数组顺序决定根/兄弟顺序，节点表可以乱序。新导出始终写 roots；较早的 3.0 数据未写 roots 时按节点表中的根节点顺序导入。
- ListStructure：`{candidateUnit:"sequence"|"turn",rows:ListRow[]}`；行是 `{id,selectedCandidateId,candidates}`，候选是 `{id,messageIds,turnId?,context}`。context 是引擎生成的历史有效性标记；导入现有 3.0 行时应保留它。
- AgentStructure 同 ListStructure，但 candidateUnit 固定为 turn。

节点和消息 ID 要求非空字符串、在各自表中唯一，无 UUID、特定字符集、全局唯一或额外长度限制。Message ID、节点 ID 与工具调用 ID 是不同身份。导入会校验引用、选择、父子关系、顺序和可达性。映射示例见 [CE 接入说明](./CE-FEEDBACK-3.0.md)。

### ListSession 与 AgentSession

ListSession 默认 sequence：一个 Agent 运行产生的 Assistant → Tool → Assistant 序列放入同一候选，User 通常占前一行。turn 模式将用户输入与交互内全部步骤放入同一候选。AgentSession 固定使用 turn，并提供 turns 查询。

rows 返回只读行/候选视图。操作包含 select(rowId,candidateId)、addCandidate(rowId,messages)、removeCandidate(rowId,candidateId)、removeRow(rowId)、regenerate(rowId)、cancelRegeneration、truncateAfter(rowId|null)、acceptHistory 和 staleRowIds。

3.0.2 起，历史有效性扫描与 acceptHistory 使用一次前缀遍历，保留原有 3.0 context 指纹值；已有列表/助手会话不需要迁移。编辑或选择后的失效判断仍按实际消息 requestRevision 计算。

```ts
list.regenerate(rowId);
await listAgent.run();
```

重生成较早行只使用之前的上下文，turn 模式还保留本轮输入；后续行保留但不进入本次请求。编辑或切换历史会使后续候选失效，生成前须截断、重生成或显式 acceptHistory。删除候选不会删除已发生的执行事实。

### 查询与记录

query.messages 支持 id、role、tags、content（字符串/正则）、partType、metadata、turnId、runId、stepId、toolCallId、predicate、offset、limit、scope。默认 scope=active；all 包含其他分支和候选。

query.turns({scope?})、runs({turnId?,scope?})、steps({runId?,scope?})、toolExecutions({runId?,status?,scope?}) 查询记录。三类 Session 都保存：

- Turn：一次用户交互及输入消息。
- Run：一次 chat/run/continue/resume，含状态、停止原因、恢复来源。
- Step：一次模型请求，含顺序、状态、输出、finishReason 和用量。
- ToolExecution：调用 ID、参数、审批/执行状态与结果消息。
- Contribution：步骤对消息的 create/append/replace 贡献；续写允许多个 Step 关联同一 Message。

trace.records 返回冻结副本；trace.usage(runId?) 按步骤累计用量。存储格式为 format=agent-engine-session、version=3，保留所有消息、结构、选择和执行记录，不包含控制器、等待中的审批或工具函数。

## Provider 与配置

Provider 是可继承基类；聊天契约为 ChatProvider，Agent/Generator 接受结构化实现。ImageProvider、AudioProvider、VideoProvider、EmbeddingProvider 为独立能力契约，可由业务继承 Provider 或现有厂商 Provider 实现。完整接口、任务语义与示例见 [多媒体与继承](./MULTIMEDIA-3.0.md)。EmbeddingProvider 当前只提供契约，没有内置厂商向量协议。

```ts
import { OpenAIProvider, OpenAIResponsesProvider, AnthropicProvider, GeminiProvider } from "@notic/agent-engine";
const provider = new OpenAIProvider({ apiKey: "key", baseURL: "https://your-proxy/v1" });
const wire = await provider.buildRequest({
  model: "your-model", messages: [Message.user("问题")],
  generation: { maxOutputTokens: 2048, temperature: 0.4 },
}, false);
```

HTTP Provider 接受 apiKey（字符串/异步函数）、baseURL、headers、transport、mediaResolver，以及 OpenAI Chat 专用的 streamCompletion。buildRequest(request,stream?,signal?) 只转换，不发送；generate(request,{stream,signal?},emit?) 返回统一 ModelResponse，普通业务使用 Generator 取得配置校验与稳定身份。

generation 字段：temperature、topP、topK、maxOutputTokens、stop、frequencyPenalty、presencePenalty、seed、responseFormat、providerOptions。responseFormat 为 text、json_object 或 `{type:"json_schema",name?,schema}`。

| 实现 | 不支持的统一参数 |
| --- | --- |
| OpenAIProvider / OpenAICompatibleProvider | topK |
| OpenAIResponsesProvider | topK、stop、seed、frequencyPenalty、presencePenalty |
| AnthropicProvider | frequencyPenalty、presencePenalty、seed、responseFormat |
| GeminiProvider | 以上字段均有转换，具体模型能力由服务端确认 |

不支持或统一/原生冲突的参数会报错；具体模型可能进一步限制取值。Anthropic 未指定输出上限时使用 4096。providerOptions 是平台扩展，不配置运行超时、审批或上下文；不能覆盖 model/messages/input/contents/tools/stream/system。框架不会自动重试模型请求。

transport 接收 `{url,method,headers,body?,signal,stream,purpose?}` 并返回标准 Response，支持 GET/POST/PUT/PATCH/DELETE 和 JSON、multipart、二进制 body。stream 始终为显式 boolean，内置聊天请求的 purpose 为 chat；子类可设置 image/audio/video/embedding/models/custom，未指定时基类采用 custom。这些字段是传输描述，不写入请求 body。3.0.1 起可用 Agent / Generator 的 requestTimeoutMs 限制单次完整模型请求，超时通过 signal 取消 transport，与 execution.timeoutMs 的整次运行预算分别处理。

业务可桥接代理/Tauri；流式 Response 的 body 需提供 Web ReadableStream。mediaResolver.resolve(url) 返回 `{base64,mimeType}`，可处理业务附件地址。浏览器默认 BrowserMediaResolver，本地文件解析器从 /node 导入 DefaultMediaResolver。

thinking 可配置 mode=none/native/message/auto、scope=none/last/tool_call/all、include(message,index,messages)、messagePrefix。Agent 默认在工具循环回传 thinking；续写初始请求另有临时思考载体。转换保留工具元数据、thinking 签名与 Responses reasoning items。

thinking 的字段覆盖顺序是 Generator 构造配置 → Agent 构造配置 → 单次运行配置，Agent 底层默认值为 `{mode:"auto",scope:"tool_call"}`。Generator 单独使用时支持构造和 generate 两层配置。`carryThinking:false` 控制续写的临时文本思考载体，`thinking:{mode:"none"}` 控制已有 thinking 内容块的协议回传；如要同时关闭，两个选项一起设置。

## Generator：一次请求

```ts
import { Generator } from "@notic/agent-engine";
const generator = new Generator({ provider, model: "your-model", generation: { temperature: 0.3 } });
const config = generator.effectiveConfig({ maxOutputTokens: 1024 });
const response = await generator.generate({
  messages: session.history(), tools: toolkit.definitions,
  generation: { maxOutputTokens: 1024 }, stream: true, signal: controller.signal,
});
```

返回 message、usage?、model?、finishReason?。输入使用隔离快照，不写 Session、不执行工具、不重复请求。构造配置与单次覆盖浅合并；providerOptions 整体覆盖；effectiveConfig 返回副本。

事件：messageStarted、textDelta、thinkingDelta、toolCallDelta、messageGenerated，含 messageId/stepId/runId?，最终 ID 与流式一致。on(type|"*",handler) 返回退订函数；generate 也接受 onEvent 和 identity。Generator 事件处理器异常使调用失败。

ProviderRequestError 含 HTTP status；流失败用 GenerationError(cause,partial?) 保留部分响应。自定义聊天实现 ChatProvider.generate，应把 signal 传到真实操作；Generator 会限制独立实现的等待并忽略迟到事件。HttpProvider 子类覆盖 generate 时需遵守原有取消契约，以保留原生部分状态。取消无法终止忽略 signal 的底层副作用，传输和工具需合作取消。

内置 HttpProvider 要求本协议的完成信号。3.0.3 起，OpenAIProvider（OpenAICompatibleProvider 的别名）默认使用 `streamCompletion: "compatible"`：接受非空 finish_reason，也接受有效助手响应之后的显式 `data: [DONE]`。有效响应包括正文、思考、工具调用增量或 assistant 角色起始块；只有 `[DONE]`、usage 或空 delta 不算有效响应。缺失的 finishReason 保持 undefined，Step 记录同样保留未知，不推断为 stop；已有 length、tool_calls、content_filter 等原因不会被 `[DONE]` 覆盖。仅凭结束标记无法还原中转站省略的截断原因。

需要沿用 3.0.2 的严格检查时，在 Provider 构造配置中设置 `streamCompletion: "strict"`，只接受 finish_reason：

```ts
const provider = new OpenAIProvider({
  apiKey: "key", baseURL: "https://your-proxy/v1",
  streamCompletion: "strict",
});
```

streamCompletion 不进入请求 body，也不影响非流式请求。其他协议始终要求各自的原生完成信号：Responses 的 response.completed/response.incomplete、Anthropic 的 message_stop、Gemini candidate 的 finishReason；不能用 `[DONE]` 替代。通过 `[DONE]` 回退完成的 OpenAI 响应，会先检查所有工具调用都有非空 ID/名称及完整的 JSON 对象参数，不把空参数补成 `{}`；实际执行仍经过 ToolExecutor 的 schema 校验、启用检查和审批。

没有任何可接受完成信号就关闭 HTTP body，仍抛 GenerationError，其 cause 为 IncompleteStreamError（code=INCOMPLETE_STREAM），partial 保留已收到内容，不执行残缺工具调用。流内错误信封会抛出 ProviderStreamError，保留 detail、message 及可用的 code/type/status；流式情况下它作为 GenerationError.cause 返回。非流式 HTTP 200 错误信封同样识别。错误、取消和超时不会因缓冲区已有 `[DONE]` 而转成成功。自定义 ChatProvider 的完成判断仍由实现者负责。

## ToolExecutor：独立审批与执行

```ts
import { Tool, ToolKit, ToolExecutor } from "@notic/agent-engine";
const toolkit = new ToolKit().add(Tool.define<{ path: string }>({
  name: "read_file", description: "读取文件", requiresApproval: true,
  parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
  execute: async ({ path }, context) => {
    context.throwIfAborted();
    return fileService.read(path, context.signal);
  },
}));
const executor = new ToolExecutor({ toolkit, approval: "manual", approvalTimeoutMs: 60_000 });
executor.on("approvalRequired", event => {
  if (event.type === "approvalRequired") showApproval(event.request);
});
const outcome = await executor.execute(toolCall, { signal: controller.signal });
// UI 调用 executor.approve(request.approvalId) 或 reject(id,reason?)。
```

JSON Schema 支持 draft-07 和显式声明 draft-2020-12；参数校验后才审批。Tool.validate、definition、execute 可单独使用；直接 Tool.execute 不经过审批，完整入口为 Executor.execute。

ToolKit 提供 add/get/has/size/enable/disable/isEnabled/definitions。禁用工具既不对模型可见，也不能执行；通过审批后再次检查启用状态。addMCP 接受 listTools/callTool 结构化客户端，无需框架依赖 MCP SDK，业务负责连接/关闭。

3.0.2 起，最后一次异步通知返回之后、真正调用工具函数之前，还会复查 signal、启用状态和注册对象。Executor.execute 的第二参数可提供同步 `assertCanExecute?: () => void`，在开始处理及最终启动点校验业务所有权；Agent 用它检查 Session 租约。此检查不能异步，防止检查后再出现等待窗口；已开始的工具仍需合作取消。

Executor 配置 approval=auto/manual/policy、approvalTimeoutMs、errorPolicy=return/throw。policy 可异步返回 allow/deny/ask 或 `{action,reason?}`，显式 policy 决定授权；默认模式遵守 requiresApproval。deny、拒绝和审批超时返回 rejected；工具异常默认返回失败结果，throw 模式抛 ToolExecutionError。取消始终抛出并记录 interrupted。

返回 `{message,record}`。pendingApprovals 返回副本，approve/reject 返回是否找到审批；事件为 approvalRequired 和 toolUpdated。execute 的 onRecord 保存进度，context 提供 signal、runId、stepId、toolExecutionId、toolCallId。

## Agent：自主运行与提交

```ts
const agent = new Agent({
  provider, model: "your-model", session, promptBuilder, toolkit,
  tools: { approval: "manual", approvalTimeoutMs: 60_000 },
  requestTimeoutMs: 60_000,
  execution: { maxSteps: 10, timeoutMs: 120_000, toolConcurrency: "sequential", toolErrorPolicy: "return" },
});
const result = await agent.chat("完成任务");
```

模型来源为 provider+model 或 generator，二者互斥；Session 为传入实例或 mode+sessionOptions，二者互斥。可传 toolExecutor，同时传 toolkit 时必须指向同一注册表。自动实例可通过 agent.session/promptBuilder/generator/toolExecutor 获取。

| 接口 | 行为 |
| --- | --- |
| chat(input,options?) | 添加 User，开始交互，自动执行模型/工具循环 |
| run(options?) | 从已准备历史执行，不添加用户消息 |
| continue(options?) | 扩展最后选中 Assistant，支持 targetMessageId/instruction/carryThinking |
| resume(options?) | 接续本实例上一失败/中断运行，新 Run 关联同一 Turn 和 resumedFrom |
| abort(reason?) | 取消当前运行 |
| previewContext(options?) | 无消耗预览 run、continue 或 resume 请求上下文 |

options 支持 signal、stream、generation、execution、thinking、requestTimeoutMs。execution.maxSteps 默认 10，3.0.1 起 0 表示不限轮数；负数、非整数和非有限值无效。execution.timeoutMs 覆盖整次运行的模型、工具和审批等待，0 或不设置表示不限时。工具默认 sequential，也可 parallel，与 toolErrorPolicy 独立。return 将异常回传模型；pause/throw 保存失败工具结果后结束，应用决定是否 resume。审批拒绝是工具结果。

`execution.lengthPolicy`（3.0.2）可为 `"error"`（默认，沿用原行为）或 `"complete"`。complete 允许没有工具调用的 length 回复正常结束，结果 status=completed、stopReason=length，afterCommit/afterRun 与 lastRunState 一致；续写同样适用。包含工具调用的截断回复始终失败，不执行工具。单次执行配置可覆盖 Agent 默认值，例如 `await agent.continue({execution:{lengthPolicy:"complete"}})`。CE 希望保持 2.x 截断行为时，应显式设置这个选项。

requestTimeoutMs 是单次完整模型请求（包括整段流式响应）的毫秒上限，不是流式空闲超时，也不包含提示词准备、工具或审批等待。每个模型步骤重新计时。优先级为单次 chat/run/continue/resume 选项 > Agent 配置 > Generator 配置；Generator.generate 也可直接覆盖默认值。0 明确关闭继承的请求超时，未配置则不限时。负数及非有限值无效。达到请求或总运行超时后，AgentResult.status 为 interrupted、stopReason 为 timeout；保留可提交的片段，编辑冲突时保留到 unapplied。调用方 signal 的取消仍然有效。

AgentResult 包含 runId/turnId?/status/stopReason/message?/usage/error?/unapplied?/unappliedToolResults?。失败、取消、超时、maxSteps、输出长度限制抛 AgentRunError，其 result 保存进度；lastRunState 保存最近结果。一个 Agent 或一个 Session 同时只允许一个活动 Agent 执行，重叠 chat 在添加输入前被拒绝。

续写用临时 Assistant 文本回传旧思考，再加临时 User 指令；两者先进入 PromptBuilder 再进行注入与转换，不写入 Session。它们有 TEMPORARY_PROMPT_TAG 和对应 CONTINUATION_THINKING_TAG / CONTINUATION_INSTRUCTION_TAG，来源标签为 agent.continue.thinking / agent.continue.instruction。`previewContext({kind:"continue",targetMessageId?,instruction?,carryThinking?})` 使用同一构建路径；预览不消费 injection life，转换函数的外部副作用仍由业务管理。预览不执行 beforeRequest、平台编码或网络请求。

新增文本、思考和媒体追加到目标，身份保持；默认业务 metadata 浅合并，生成值优先，tags 取并集。带工具调用时，工具相关思考只留在独立的工具调用消息上，不重复并入目标；签名和 reasoning items 按协议保留。多段 thinking 保持独立块，显示分隔由业务处理。初始续写生成失败不合并不完整输出，取消则保留部分输出；已完成步骤不会因后续失败撤回。

修改请求历史的内容、协议 metadata 或会话结构/选择会触发 SessionConflictError；业务 metadata/tags 写入不触发。发生冲突时保留用户修改，并在 result.unapplied 返回未应用输出；若工具已执行但提交冲突，unappliedToolResults 保留实际工具结果，trace 保留执行事实。普通生成失败/取消保留部分内容；残缺工具调用补失败结果。已发生的副作用无法撤回。resume 不重放已保存工具结果，但模型可能再次请求相同操作，敏感业务应实现幂等控制。

导入 Session 恢复数据，不恢复进程运行、等待审批或 exactly-once 工具现场。新 Agent 不能 resume 另一实例运行，可显式 run 已导入上下文。

### 生命周期与业务保存

hooks.beforeRequest(context,identity) 修改请求副本；beforeCommit(message,commitContext) 修改或返回替代生成 Message；afterCommit(actualMessage,commitContext) 在内存提交后执行；afterRun(result) 在运行结算后执行。hook 可异步，内存提交与业务数据库保存分别处理。

3.0.2 的正常提交 commitContext 带 `signal`，beforeAppend 也继承它；afterCommit 应将它传入可取消的持久化操作。为保证运行中止后仍能保存已有片段，partial 恢复提交不传已取消的 signal。afterCommit 操作的是实际消息，框架会等它返回或抛错后才释放 Session 租约；总超时/用户停止会取消 signal，但不会强行终止忽略 signal 的 hook 或允许另一 Agent 与之重叠。hook 返回后会再次检查取消和会话冲突，超时不再错误结算为 completed。业务应给外部保存设置自己的有界等待，且不得在 hook 返回后继续异步修改实际消息。afterRun 已在运行结算之后执行，不属于运行预算。

续写时 beforeCommit 的 context 带 operation=append、targetMessageId 和隔离的 targetMessage 快照。然后 `beforeAppend(draft,context)` 收到默认合并后的目标草稿，context.targetMessage / generatedMessage 都是隔离快照；可以编辑草稿或返回保留目标 ID/role 的替代 Message。草稿在钩子成功、身份/协议与租约检查通过后才提交，失败不写入目标。异步等待期间其他业务 metadata/tags 的无关修改会保留；同一个键由钩子显式覆盖或删除时按钩子决定。续写取消后保留部分输出也走这个合并点。

afterCommit 失败保留已提交内容，停止后续执行；afterRun 失败用 AgentRunError 携带原结果，运行状态仍表示实际执行事实。Agent 通知事件包含 Generator、Executor 事件，以及 runStarted/messageCommitted/runFinished。messageCommitted.message 为提交快照。普通通知异常交给 onHandlerError，不用于转换；显示、保存、发送的内容可以不同。

## PromptBuilder：独立临时上下文

```ts
const builder = new PromptBuilder();
builder.injectSystem("本次临时规则", { life: 1, source: "business-rule", position: "beforeLastUser" });
builder.use(async messages => {
  const last = messages.at(-1);
  if (last?.role === Role.User) last.appendText("\n附加请求内容");
  return messages;
});
const preview = await builder.preview(session.history());
const context = await builder.buildContext(session.history());
```

接口：inject/injectSystem/remove/clear/use/slice/build/buildContext/preview。position=start/end/beforeLastUser 或插入索引函数；life=-1 永久、0 禁用、正整数为成功构建次数。预览和失败转换不消费；Agent 每个模型步骤构建一次，构建成功即消费，即使随后网络失败。共享 builder 的并发消费由业务协调。

全部使用 detached Message 快照，临时内容不进 Session。build 返回 Message[]，buildContext/preview 返回 `{messages,sources}`；sources 含 messageId、sourceMessageId/sourceRevision、injected 和业务 source 标签。新身份视为派生/注入内容；业务宏结算通过提交 hooks 管理。

use 的变换可以返回原来的 Message[]，也可返回 `{messages,sources?:PromptSourceInput[]}`。例如：

```ts
builder.use(messages => {
  const rule = Message.system("世界书规则");
  return {
    messages: [rule, ...messages],
    sources: [{ messageId: rule.id, injected: true, source: "世界书: 城市" }],
  };
});
```

来源是部分声明，不必为每条消息重复填写；后续返回普通数组的变换只要保留 messageId 就保留标签。sourceMessageId 可关联原历史，sourceRevision 未指定时从原输入推导。buildContext/preview 也接受 `{sources}` 输入标签。声明必须指向本次输出中的消息，重复或无效引用会拒绝构建，并且不消费 life。
