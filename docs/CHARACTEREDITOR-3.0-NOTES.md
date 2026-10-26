# CharacterEditor 使用分析与 AgentEngine 3.0 设计输入

记录日期：2026-10-08。

业务项目：`D:\Code\NodeJs\CharacterEditor`。`ui/package.json` 当前声明 `@notic/agent-engine@2.2.0`。

本文通过静态阅读当前工作区的相关代码、架构文档和部分验证脚本整理使用方式。未运行业务、调用真实模型或执行验证脚本，未修改 CharacterEditor。下面的设计建议是新的讨论输入，不代表已经确认的 3.0 规范。

相关设计记录：[AgentEngine 3.0 设计讨论](./DESIGN-3.0.md)。后续已在 AgentEngine 实现新运行时，接入映射见 [迁移说明](./MIGRATION-3.0.md)；业务项目未在本次修改或运行。

2026-10-08 后续确认：Message 负责自身内容编辑，Session 提供详细查询和委托编辑的便捷入口；三种会话均保留轮次与工具执行信息；保存和显示可以不同。具体方案见 [消息、会话与运行记录契约草案](./DATA-MODEL-3.0.md)。下文的业务事实保持不变，其他建议仍待收敛。

2026-10-08 CE 后续反馈已落实：运行期间业务状态写入、续写构建/预览和合并钩子、会话 metadata、平坦导入结构、变换来源标签、传输标志、思考策略与向量契约。当前接口和接入示例见 [反馈落实](./CE-FEEDBACK-3.0.md)，下文仍保留首次分析的背景。

## 1. AgentEngine 的主要业务入口

CharacterEditor 的浏览器桥接入口为 `ui/src/lib/agent.ts`。主要调用链如下：

| 场景 | 主要入口（相对 CharacterEditor 根目录） | 当前使用方式 |
| --- | --- | --- |
| AI 助手 | `ui/src/stores/useChatStore.ts`、`ui/src/features/chat/agentRuntime.ts` | 独立 Session 保存真实消息；先准备用户消息，再创建 Agent，调用 generate；事件投影成 UI 消息 |
| RP 聊天 | `ui/src/stores/useRPChatStore.ts`、`ui/src/lib/rpPromptCompiler.ts` | Session 树保存历史与分支；支持编辑、重生成、候选切换、续写和摘要分支 |
| 游戏卡持久 Agent | `ui/src/features/gameCards/gameAgentService.ts` | 使用树形 Session 或 ListSession；保存候选及选择；支持 generate、continue、resume 和重新生成 |
| 游戏卡单次生成 | `ui/src/features/gameCards/gameAiBackend.ts` | 创建独立 Session 和工具包，生成过程中经宿主转发事件与工具执行 |
| 会话标题等辅助调用 | `ui/src/features/conversation/sessionTitles.ts` | 独立短会话、单步、非流式调用 |

当前助手和 RP 都使用树形 Session 作为已提交会话的真实数据源，UI 列表是投影。新增 AgentSession 后，是否迁移某个场景应由需要保留的分支、轮次和候选语义决定，不能仅按“助手”名称自动选择。

## 2. Provider：业务已经自行实现 HTTP 与 SSE

证据：`ui/src/features/chat/providerRuntime.ts`，特别是 `createEngineProvider`、`createOpenAICompatibleClient`、`createAnthropicClient`、`createGeminiClient` 和 `parseSSE`。

目前业务为三种平台发送 HTTP 请求、处理鉴权、完整响应和 SSE，并提供 SDK 形状的对象给 AgentEngine 内置 Provider。Gemini 还需要将引擎输出的 SDK 形状请求转换为 HTTP 请求体。

这说明框架自行实现平台协议有直接的业务价值：业务可以减少模拟 SDK 接口、解析 SSE 和重复处理平台请求的代码。业务项目仍声明 openai 依赖，不能据此断言整个应用已经移除了 SDK。

### 对 3.0 的设计输入

- Provider 接受统一请求，自己负责平台协议转换和流解码。
- 支持注入网络传输。`ui/src/api/network.ts` 的 `apiFetch` 统一提供直接请求、Web 服务代理和 Tauri 原生桥，Provider 应能复用这个边界。
- 自定义网络层应获得 URL、请求方法、headers、body 和取消信号，并能返回可读取的响应流。最终接口形式待确定。
- 框架处理模型协议；业务继续负责自己的代理、设备能力、凭据获取和配置存储。
- 保留 Provider 包装或请求处理扩展点。当前 `providerPolicy.ts` 会在发送前处理模型能力、预算和推理配置。
- 保留媒体资源解析扩展点。`managedAttachments.ts` 将 `attachment://`、`appfile://` 引用转换为提交所需的媒体数据，同时保留会话中的原引用。

## 3. Session：编辑与存储需要明确的结构操作

证据：`ui/src/features/conversation/sessionCore.ts`、`sessionOperations.ts`、`assistantSession.ts`，以及两种聊天 Store 的编辑、删除、重生成、分支和压缩动作。

业务目前自行维护：

- metadata 中的稳定消息标识，以及 UI 标识与引擎消息的映射。
- 节点的查询、遍历、删除、光标调整和分支切换。
- 工具调用与结果的关联删除。
- 迭代式 Flat Session 编解码，保存完整树、节点顺序与当前路径，避免深树递归序列化。
- 业务状态在分支间的继承与关联。

### 对 3.0 的设计输入

- Message 与会话节点分开后，明确 Message ID、节点 ID、候选 ID、Turn ID 的含义及引用关系。
- 提供按稳定标识定位、查询、结构删除、替换和遍历的公开接口。用户获取 Message 后通过消息自身方法编辑内容；Session 的编辑便捷入口委托这些方法。结构变化后由 Session 保持选中项或当前路径有效。
- 三种会话都保存轮次、模型步骤和工具执行关联。续写合并后，一个 Message 可以具有多个生成来源，不能只保存单一 stepId。
- 明确工具调用及结果的关联规则，避免业务通过全树扫描维护基础协议一致性。
- 会话导出应保存组织结构与选择，并支持深历史；格式带版本，具体快照、增量保存或记录迭代接口待定。
- 会话和结构单元应允许关联业务扩展数据。当前大量会话状态存放在 system root 上，Message 脱离节点后需要为会话属性与结构状态提供明确归属。
- 不将 CharacterEditor 的状态继承、数据库或具体业务事务搬进引擎；引擎提供必要的定位与生命周期能力。

## 4. 继续生成：有现成业务实现可用于检验设计

证据：`ui/src/features/conversation/continuation.ts`、`useChatStore.ts` 的继续动作、`useRPChatStore.ts` 的 `continueGeneration`，以及 `ui/scripts/verify-continuation.mjs` 中的场景断言。

RP 续写会暂时移动已有 thinking 到助手文本消息、添加用户继续指令，再调用 generate。助手续写调用现有 agent.continue，事后标记其追加的用户指令。两者最终使用共享逻辑合并内容、移除临时消息和修整树。

业务语义比字符串拼接更完整：

- 正常完成：合并正文与思考，保留新媒体内容，清理临时指令。
- 用户中止：把已经输出的部分作为提前结束合并。
- 续写首次响应未完整返回就失败：恢复续写前状态，原回复不变。
- 续写首次响应完整返回后，后续工具步骤失败：保留已完成内容和后续执行进度。
- 首次续写回复含工具调用：工具调用之前的正文并入原回复；工具调用、结果及其后的消息保持有序关联，不全压成一条消息。
- 合并时还需保留原有分支和分支状态关系，移除临时节点不能改变其他分支的业务状态。

### 对 3.0 的设计输入

- 内置 continue 应绑定明确目标，并以临时请求上下文实现继续指令。
- 区分完成、中止和失败，明确哪些结果合并、哪些结果回滚。
- 合并操作必须保留媒体、工具协议关联和必要的模型元数据。
- 引擎提供通用的合并结果和结构变化信息，业务据此关联自己的状态。
- 当前业务的细节可作为候选行为和验证场景；尚需用户决定是否全部作为 3.0 默认行为。
- 旧数据转换属于 CharacterEditor 的迁移任务，不必进入 AgentEngine 核心。

## 5. 工具：可见、启用与执行授权是不同状态

证据：`ui/src/features/tools/onDemand.ts`、`toolBundles.ts`、`ui/src/features/chat/agentRuntime.ts` 的审批事件处理，以及 RP 工具事件绑定。

助手先暴露 tools_list / tools_enable，模型按需加载工具。工具启用后，下一次模型调用才获得完整定义；启用不等于批准执行。

助手和 RP 均将 Agent 配置为人工审批模式，再通过事件查询业务策略：自动允许的调用异步 approve，需要确认的调用显示审批卡片。业务自行维护审批 ID 与 Agent 的映射，处理完成、拒绝和运行结束后的清理。

游戏卡工具还直接使用已有 JSON Schema，并自行校验参数，包括 Param builder 不能完整表达的约束。

### 对 3.0 的设计输入

- 工具执行模块区分注册、模型可见性、启用与每次执行授权。
- 每次模型步骤读取当前工具定义，保留运行期间动态加载工具的能力。
- 支持完整 JSON Schema 输入，工具内部使用平台无关的定义；参数校验能力及依赖策略待确定。
- 执行策略允许访问解析后的参数、运行上下文和取消信号，支持自动允许、拒绝或等待人工决策。
- 审批请求、决策入口、超时与清理由独立工具执行能力维护；Agent 负责运行协调。
- 工具失败结果、抛错、暂停和并发策略应分别定义，避免一个选项隐式改变多个行为。
- 资源写入事务、应用权限目录和业务回滚规则继续由业务实现。

## 6. PromptBuilder：需要预览、异步准备与结算边界

证据：`ui/src/lib/rpPromptCompiler.ts`、`assistantRuntimePromptCompiler.ts`、`ui/src/features/chat/agentRuntime.ts`、`ui/src/features/macros/promptTransaction.ts` 和两个 Store 的 `getDebugMessages`。

上下文由角色资料、预设、世界书、Skills、记忆或笔记索引、宏和正则等多种来源组成。业务先完成异步准备，再创建同步 PromptBuilder；RP 还进行深度插入和相邻 system 消息合并。

预览与运行分开构建。调试面板通过消息对象身份、metadata 或 WeakMap 区分注入来源。提示词宏可能修改状态，因此业务通过 WeakMap 绑定暂存事务，生成后按已保留的完整模型步骤提交或回滚，并在工具写状态前结算相关宏。

### 对 3.0 的设计输入

- 保留任意消息数组转换能力，允许业务自定义顺序、位置、裁剪及内容处理。
- 明确异步准备与上下文构建的扩展入口，可考虑异步 builder 或独立准备阶段。
- 区分无副作用的预览和正式运行中的构建与消费；预览不应改变注入次数或提交业务状态。
- 上下文构建结果可携带来源、锚点和转换记录，使业务不必依赖对象身份判断来源。
- 提供生成前、模型步骤提交前后、运行结束等明确生命周期，使业务能绑定自己的暂存状态与结算逻辑。
- 区分模型完成、会话写入和业务持久化成功，框架内存提交不代表数据库提交。
- 世界书触发、角色宏、应用 Skills 和正则规则保持业务扩展。

## 7. 流式事件：明确运行、步骤、消息与内容归属

证据：`ui/src/features/chat/agentRuntime.ts` 的 `bindChatAgentEvents`、RP 流式展示绑定、`gameAgentService.ts` 的事件转发和 `gameAiBackend.ts` 的推理事件转换。

业务自行创建流式消息标识；每次工具循环切换占位消息；工具调用开始时固定已有文本；提交前再给 Message 写入 UI 标识。游戏 Agent 的转发层另行添加 runId、agentId 和 conversationId。

### 对 3.0 的设计输入

- 流式事件从生成开始就能关联运行、模型步骤和最终消息，必要时关联内容块和工具调用。
- delta 与累计 snapshot 的字段和语义保持一致，便于多种 UI 或宿主协议转换。
- 区分模型原始输出完成与应用转换后消息已提交。RP 会在提交前执行输出正则，最终保存内容可能不同于流式原文。
- 明确 partial、已完成步骤与失败原因，业务能直接判断保留或回滚范围，减少拼接多个可选字段推断状态的逻辑。
- 渲染节流、消息卡片和沙箱通信由业务处理，引擎输出结构化事实。

## 8. 优先讨论顺序

2026-10-08 补充核查：`features/media/adapters.ts`、`jobs.ts`、`tools/mediaTools.ts` 提供了图片生成、语音合成和视频异步任务，首次重构没有覆盖这些输出能力。现已添加 Provider 基类、独立媒体能力接口、GET/multipart/二进制传输和视频消息扩展；接口与边界见 [多媒体设计与实现](./MULTIMEDIA-3.0.md)。业务的持久化、模型目录、参数 schema 和界面继续通过扩展接入，未修改业务代码。

1. Message、节点、候选、Turn 和模型步骤的身份及关系。
2. Session 的公开编辑、生成提交和序列化契约。
3. continue 的目标绑定、合并、工具边界与失败语义。
4. 独立工具执行与审批策略，动态工具定义和参数校验。
5. Provider 的统一请求、可注入传输与媒体解析。
6. PromptBuilder 的来源信息、预览、异步扩展和生命周期。
7. 流式事件与配置 API，形成少量典型业务调用样例。

这些输入支持此前讨论的模块边界，并增加了对扩展入口、提交状态和身份关联的具体要求。后续应以选定的真实场景检验草案，避免将整个应用运行时复制到框架中。
