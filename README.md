# AgentEngine

AgentEngine 是一个轻量、模块化、可测试的 TypeScript AI Agent 框架。

它的目标不是把所有能力塞进一个黑盒，而是把 Agent 拆成清晰的模块：消息、会话、工具、流式解析、提示词构建、请求配置、平台适配和自动循环。你可以直接使用完整的 `Agent`，也可以单独拿其中某个模块来构建自己的系统。

> 简单的事情简单做，复杂的事情也能拆开做。

```ts
import OpenAI from "openai";
import { Agent, Session, StreamEventType } from "@notic/agent-engine";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const agent = new Agent({
  client,
  model: "gpt-4o-mini",
  session: Session.create("你是一个简洁可靠的助手。"),
});

agent.on(StreamEventType.TEXT_DELTA, (event) => {
  process.stdout.write(event.delta);
});

const reply = await agent.run("用一句话介绍 AgentEngine。");
console.log(reply.text);
```

需要一次性取得完整响应时：

```ts
const reply = await agent.run("用一句话介绍 AgentEngine。", {
  stream: false,
});
```

流式与非流式模式使用同一套 `Message`、Session 和工具调用循环。

如果上下文已经写入当前 `Session`，可以直接生成 Assistant：

```ts
session.addUser("已经准备好的上下文");
const reply = await agent.generate();
```

在 Assistant 写入 Session 前执行可等待转换：

```ts
agent.on(StreamEventType.BEFORE_ASSISTANT_COMMIT, async (event) => {
  const transformed = await transformText(event.message.text);
  event.message.setText(transformed);
});
```

## 适合做什么

- 构建带工具调用的 AI Agent
- 管理多轮对话、分支会话和可恢复上下文
- 把 OpenAI-compatible、Anthropic、Gemini 等平台统一到同一套消息模型
- 解析模型 stream，并把文本、思考内容、工具调用转换成结构化事件
- 用声明式规则动态注入提示词和运行时上下文
- 为 Agent 各模块编写可控的单元测试和 fake client 测试

## 核心特性

- **模块化架构**：`Message`、`Session`、`Tool`、`Stream`、`Prompt`、`Config`、`Adapter`、`Agent` 都可以单独使用。
- **统一消息模型**：支持文本、图片、音频、文件、工具调用、工具结果和 thinking 内容。
- **树形会话管理**：天然支持对话分支、回退、分页、查询和插入。
- **工具系统**：Builder 风格定义工具，自动生成 JSON Schema，支持生命周期 Hook、MCP 和错误策略。
- **流式事件**：把模型 stream 解析成 `TEXT_DELTA`、`TOOL_CALL_*`、`MESSAGE_DONE` 等事件。
- **提示词构建器**：用 `Rule` 定位消息，再注入临时上下文；也支持数组操作管线。
- **请求配置器**：链式构建 temperature、top_p、max_tokens、response_format 等参数。
- **低耦合 Provider**：Client、Adapter、Parser 三层可独立替换，内置 OpenAI Compatible、OpenAI Responses、Anthropic 和 Gemini 预设。
- **流式与非流式**：同一套 Agent、Session 和工具循环同时支持增量 stream 与完整响应。
- **浏览器安全入口**：根入口不包含 Node.js builtin，本地文件解析通过显式 `./node` 子入口使用。
- **中断与恢复**：支持 abort、timeout、partial message、continue 和 resume。
- **工具审批**：支持自动审批、自定义审批、手动审批和审批超时策略。

## 安装

```bash
npm install @notic/agent-engine
```

根据你使用的平台安装对应 SDK：

```bash
# OpenAI / DeepSeek / Qwen / Kimi 等 OpenAI-compatible 平台
npm install openai

# Anthropic 原生 Messages API
npm install @anthropic-ai/sdk

# Gemini 原生 API
npm install @google/genai

# MCP 集成，可选
npm install @modelcontextprotocol/sdk
```

环境要求：

- Node.js >= 18
- TypeScript 项目推荐开启 `strict`

根入口可直接用于浏览器和 WebView。Node.js 中需要读取本地媒体文件时：

```ts
import { DefaultMediaResolver } from "@notic/agent-engine/node";
```

## 快速开始

### 1. 创建 Agent

```ts
import OpenAI from "openai";
import { Agent, RequestConfig, Session } from "@notic/agent-engine";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  baseURL: "https://api.openai.com/v1",
});

const agent = new Agent({
  client,
  model: "gpt-4o-mini",
  session: Session.create("你是一个友好的中文助手。"),
  config: RequestConfig.create().temperature(0.3).maxTokens(1024),
});
```

OpenAI-compatible 平台只需要替换 `baseURL` 和 `model`：

```ts
const client = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY,
  baseURL: "https://api.deepseek.com",
});
```

### 2. 监听流式输出

```ts
import { StreamEventType } from "@notic/agent-engine";

agent.on(StreamEventType.TEXT_DELTA, (event) => {
  process.stdout.write(event.delta);
});

agent.on(StreamEventType.TOOL_EXECUTE_START, (event) => {
  console.log("tool:", event.name);
});
```

### 3. 运行一轮对话

```ts
const reply = await agent.run("帮我写一个 npm 包介绍。");
console.log(reply.text);
```

`Agent` 会自动把用户消息和助手回复写入 `Session`。

## Provider

Provider 只负责组合三块可替换能力：

- `ModelClient`：发送平台请求，返回流或完整响应。
- `MessageAdapter`：在统一 `Message` 与平台 JSON 之间转换。
- `MessageStreamParser`：把平台流事件转换成统一事件和 `Message`。

Agent 不需要知道当前使用哪一家模型平台。

### OpenAI Compatible

适用于 OpenAI Chat Completions，以及 DeepSeek、Qwen、Kimi、GLM 等兼容平台：

```ts
import OpenAI from "openai";
import {
  Agent,
  OpenAICompatibleProvider,
  Session,
} from "@notic/agent-engine";

const client = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY,
  baseURL: "https://api.deepseek.com",
});

const agent = new Agent({
  provider: new OpenAICompatibleProvider(client),
  model: "deepseek-chat",
  session: Session.create(),
});
```

### OpenAI Responses API

```ts
import OpenAI from "openai";
import { Agent, OpenAIResponsesProvider, Session } from "@notic/agent-engine";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const agent = new Agent({
  provider: new OpenAIResponsesProvider(client),
  model: "your-openai-model",
  session: Session.create(),
});
```

Responses Provider 会保留 reasoning item、加密推理状态和 function call item，供下一轮工具调用继续使用。

### Anthropic

```ts
import Anthropic from "@anthropic-ai/sdk";
import { Agent, AnthropicProvider, Session } from "@notic/agent-engine";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const agent = new Agent({
  provider: new AnthropicProvider(client),
  model: "your-claude-model",
  session: Session.create(),
});
```

### Gemini

```ts
import { GoogleGenAI } from "@google/genai";
import { Agent, GeminiProvider, Session } from "@notic/agent-engine";

const client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const agent = new Agent({
  provider: new GeminiProvider(client),
  model: "your-gemini-model",
  session: Session.create(),
});
```

所有内置 Provider 都支持：

```ts
await agent.run("增量输出");
await agent.run("完整响应", { stream: false });
```

## 工具调用示例

```ts
import { Agent, Param, Session, Tool, ToolKit } from "@notic/agent-engine";

const getWeather = Tool.create(async (args) => {
  return {
    city: args.city,
    temperature: 21,
    unit: "celsius",
  };
})
  .name("get_weather")
  .description("查询城市天气")
  .params(
    Param.string("city").desc("城市名称").required()
  )
  .build();

const toolkit = new ToolKit().add(getWeather);

const agent = new Agent({
  client,
  model: "your-model",
  session: Session.create("需要外部信息时可以调用工具。"),
  toolkit,
});

const reply = await agent.run("北京今天适合跑步吗？");
console.log(reply.text);
```

当模型发起工具调用时，AgentEngine 会自动执行工具、把结果写回会话，并再次请求模型生成最终答案。

## 模块地图

```text
AgentEngine
├─ Message   统一消息模型：文本、多模态、工具调用、树节点
├─ Session   会话树：历史、分支、查询、插入、分页
├─ Tool      工具系统：Param、Tool、ToolKit、Hook、MCP
├─ Stream    流式解析：chunk -> 结构化事件 -> Message
├─ Prompt    提示词构建：Rule、Injection、数组操作管线
├─ Config    请求参数：预设、链式配置、三层优先级
├─ Client    传输边界：流式请求、完整响应、中断信号
├─ Adapter   消息转换：OpenAI、Responses、Anthropic、Gemini
├─ Provider  Client + Adapter + Parser 的低耦合组合
├─ Media     媒体解析：浏览器默认实现 + Node 本地文件子入口
└─ Agent     编排层：自动循环、审批、中断、恢复
```

### Message

统一消息对象，支持：

- `Message.user()` / `Message.assistant()` / `Message.system()`
- 文本、图片、音频、文件
- 工具调用和工具结果
- thinking 内容
- 标签、元数据和树结构
- `setText()` / `setParts()` 安全替换内容并自动失效缓存

### Session

会话管理器，负责：

- root -> cursor 的当前历史路径
- 对话分支和回退
- 查询当前分支或全树
- 在历史中插入消息
- 在兄弟分支间分页切换

### Tool

工具系统，负责：

- 用 `Param` 定义参数 schema
- 用 `Tool` 包装 TypeScript 函数
- 用 `ToolKit` 注册并执行多个工具
- 用 Hook 处理校验、取消、结果改写和错误降级

### Stream

流式解析器，负责：

- 文本增量
- thinking / reasoning 增量
- 工具调用增量
- usage
- 最终 `Message` 组装

### Prompt

提示词构建器，负责：

- 按角色、标签、内容或自定义规则定位消息
- 动态注入 system/user/assistant 消息
- 控制注入生命周期、概率和优先级
- 在发送模型前过滤、裁剪或转换上下文

### Config

请求参数配置器，负责：

- temperature / top_p / top_k
- max_tokens
- stop
- seed
- response_format
- 自定义平台参数

### Adapter

平台适配器，负责：

- 把 AgentEngine 的 `Message[]` 序列化成平台请求格式
- 处理多模态内容
- 处理工具调用和工具结果
- 控制 thinking 内容如何回传

### Provider

Provider 提供平台预设，但不接管 Agent 执行流程：

- `OpenAICompatibleProvider`
- `OpenAIResponsesProvider`
- `AnthropicProvider`
- `GeminiProvider`
- `Provider.create()` 自定义组合

通过 `provider.supportsComplete` 可以检查是否支持非流式完整响应。

### Agent

智能体编排层，负责：

- 管理 `Session`
- 调用模型 stream
- 派发事件
- 在 Assistant 提交 Session 前等待生命周期转换
- 执行工具循环
- 处理工具审批
- 中断、超时、恢复和继续

## 文档

完整教程式 API 文档见：

- [docs/API.md](./docs/API.md)
- [CHANGELOG.md](./CHANGELOG.md)

建议阅读顺序：

1. 安装与最小示例
2. Agent：智能体编排
3. Tool：工具系统
4. Prompt：提示词构建
5. Session：会话树
6. Adapter / Media：平台与多模态适配

## 测试

项目使用 Node.js 内置测试运行器。

```bash
npm test
```

真实 API 测试需要显式开启，避免普通测试误触发外部请求：

```bash
RUN_REAL_DEEPSEEK_TESTS=1 DEEPSEEK_API_KEY=sk-... npm run test:real:deepseek
```

## 构建

```bash
npm run build
```

## License

Apache-2.0
