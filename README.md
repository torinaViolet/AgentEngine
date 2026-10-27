# AgentEngine 3.0

AgentEngine 是一个模块化的 TypeScript Agent 框架。Message 负责内容，Session 负责组织，PromptBuilder 负责临时上下文，Generator 负责一次模型请求，ToolExecutor 负责审批与执行，Agent 负责持续的工具循环和会话维护。

3.0 根入口使用新的 API。原 2.x 实现保留在 `@notic/agent-engine/legacy`，详见 [迁移说明](./docs/MIGRATION-3.0.md)。

```sh
npm install @notic/agent-engine@^3.0.0
```

```ts
import { Agent, AgentSession, OpenAIProvider, PromptBuilder } from "@notic/agent-engine";

const session = AgentSession.create({ systemPrompt: "你是一个简洁可靠的助手。" });
const promptBuilder = new PromptBuilder();
const agent = new Agent({
  provider: new OpenAIProvider({ apiKey: process.env.OPENAI_API_KEY }),
  model: "your-model",
  session,
  promptBuilder,
  generation: { temperature: 0.5, maxOutputTokens: 2048 },
  execution: { maxSteps: 10 },
});
agent.on("textDelta", event => {
  if (event.type === "textDelta") process.stdout.write(event.delta);
});
const result = await agent.chat("介绍一下 AgentEngine。");
console.log(result.message?.text, result.usage);
```

## 独立模块

| 模块 | 用途 |
| --- | --- |
| Message | 编辑文本、思考、媒体和工具内容块；稳定 ID、版本与变更通知 |
| TreeSession | 树结构会话、分支选择、剪枝与嫁接 |
| ListSession | 候选消息序列，默认 sequence，可选 turn |
| AgentSession | 一次用户交互作为一轮，轮内包含多个模型和工具步骤 |
| PromptBuilder | 临时注入、异步转换、来源追踪、不消耗寿命的预览 |
| Provider / 能力接口 | 可继承 HTTP 基类，聊天、图片、音频、视频、向量能力独立扩展 |
| Generator | 单次模型调用；不写 Session，不执行工具 |
| ToolKit / ToolExecutor | JSON Schema 校验、动态工具、授权、人工审批、取消与超时 |
| Agent | chat、run、continue、resume、步骤预算、提交与执行记录 |

三种 Session 都保存 Turn、Run、Step、工具执行及消息生成贡献，可以按轮次和执行查询；导出使用平坦的版本化结构。

Agent 使用传入的 Session 和 PromptBuilder。未提供 Session 时必须指定 `mode: "tree" | "list" | "agent"`；未提供 PromptBuilder 时创建默认实例，均可从 Agent 获取。

## 单次生成

```ts
import { Generator, Message, AnthropicProvider } from "@notic/agent-engine";

const generator = new Generator({
  provider: new AnthropicProvider({ apiKey: "your-key" }),
  model: "your-model",
});
const response = await generator.generate({
  messages: [Message.user("分析这段内容")],
  stream: false,
});
console.log(response.message.text);
```

自主维护上下文、执行工具的业务使用 Agent。已准备好 Session 时调用 `agent.run()`；开始新交互调用 `agent.chat(input)`。

## 平台与业务扩展

提供 OpenAIProvider（Chat Completions / OpenAI compatible）、OpenAIResponsesProvider、AnthropicProvider 和 GeminiProvider。运行时无需安装厂商 SDK，默认使用标准 fetch、Response 和 Web Streams；支持自定义地址、传输与附件解析器。工具校验依赖 Ajv。

框架复用经过验证的内部协议转换与解析代码，2.x 兼容层独立保留。浏览器入口不包含 Node builtin；本地文件附件解析器从 `@notic/agent-engine/node` 导入。

业务可以继承 Provider 或现有厂商 Provider，实现 ImageProvider、AudioProvider、VideoProvider，复用鉴权、传输、SSE、二进制和附件解析。视频任务提交与查询分开，便于恢复已有任务。Message 支持视频内容块；内置聊天 codec 暂不编码视频输入，可覆盖 serializeMessages 扩展。媒体接口由子类实现，详见 [多媒体扩展](./docs/MULTIMEDIA-3.0.md)。

消息的显示、保存和发送可以分别处理：流式事件用于即时显示，beforeCommit 用于修改保存内容，PromptBuilder 用于改变请求上下文。续写保留原消息身份并追加内容，临时续写指令不进入 Session。

运行中可以更新 Message 的业务 metadata/tags 或 Session.metadata；内容、协议元数据与结构编辑仍检测冲突。续写临时消息进入 PromptBuilder，previewContext 支持续写参数，beforeAppend 可编辑默认合并后的目标草稿。编译器可返回消息和来源标签；旧会话可直接映射公开的平坦结构导入，保留业务 ID 与兄弟顺序。具体行为见 [CE 反馈落实与接入契约](./docs/CE-FEEDBACK-3.0.md)。

## 文档与验证

- [3.0 API 与使用示例](./docs/API.md)
- [Provider 继承与多媒体](./docs/MULTIMEDIA-3.0.md)
- [CE 反馈落实与接入契约](./docs/CE-FEEDBACK-3.0.md)
- [3.0.2 缺陷修补与验证](./docs/FIXES-3.0.2.md)
- [2.x → 3.0 迁移](./docs/MIGRATION-3.0.md)
- [实施状态与设计基线](./docs/PLAN-3.0.md)
- [设计讨论记录](./docs/DESIGN-3.0.md)
- [数据模型设计](./docs/DATA-MODEL-3.0.md)
- [CharacterEditor 业务分析](./docs/CHARACTEREDITOR-3.0-NOTES.md)
- [2.x 历史 API](./docs/API-2.x.md)

```sh
npm install
npm test
npm run build
```

测试覆盖新 API、旧版兼容层、合成 HTTP/SSE、深树导入导出、审批、取消、续写、恢复及冲突；同时检查浏览器构建、无 Buffer 的附件处理和包导出。默认不调用真实模型。demo/battle 和 demo/editor 暂时使用 legacy 入口。
