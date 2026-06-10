# AgentEngine API 教程

版本：1.2.x

AgentEngine 是一个 TypeScript AI Agent 框架。它把一次模型调用拆成几个可以单独理解、测试和替换的模块：

- `Message`：统一的消息对象，支持文本、多模态、工具调用、思考内容和树形会话。
- `Session`：会话树，负责历史、分支、回退、查询和插入。
- `Tool`：工具定义、参数 schema、生命周期 Hook 和执行结果回传。
- `Stream`：把 OpenAI-compatible stream chunk 解析成结构化事件。
- `Prompt`：用声明式规则把临时提示词注入历史。
- `Config`：链式构建请求参数。
- `Client`：只负责发送已经适配好的请求，返回 stream 或完整响应。
- `Adapter`：把统一消息模型序列化到 OpenAI / Anthropic / Gemini 等平台格式。
- `Provider`：以低耦合方式组合 Client、Adapter 和 Parser。
- `Agent`：把上面所有模块串起来，完成“请求 -> 解析 -> 工具执行 -> 再请求 -> 最终回复”的自动循环。

这份文档会像教程一样讲 API：先跑起来，再分模块深入。README 只做项目介绍和快速入口，完整用法以后主要看这里。

## 目录

- [安装与最小示例](#安装与最小示例)
- [核心心智模型](#核心心智模型)
- [Message：统一消息模型](#message统一消息模型)
- [Session：会话树](#session会话树)
- [Tool：工具系统](#tool工具系统)
- [Stream：流式事件](#stream流式事件)
- [Prompt：提示词构建](#prompt提示词构建)
- [Config：请求参数](#config请求参数)
- [Provider：平台能力组合](#provider平台能力组合)
- [Adapter：平台适配](#adapter平台适配)
- [Media：媒体解析](#media媒体解析)
- [Agent：智能体编排](#agent智能体编排)
- [Utils：工具函数](#utils工具函数)
- [常见组合方案](#常见组合方案)

## 安装与最小示例

安装 AgentEngine：

```bash
npm install @notic/agent-engine
```

AgentEngine 不强绑定具体模型 SDK。你使用 OpenAI、DeepSeek、Qwen、Kimi 等 OpenAI-compatible 平台时，通常安装 `openai`：

```bash
npm install openai
```

使用原生 Anthropic 或 Gemini Provider 时，安装对应官方 SDK：

```bash
npm install @anthropic-ai/sdk
npm install @google/genai
```

最小可运行示例：

```ts
import OpenAI from "openai";
import { Agent, Session, StreamEventType } from "@notic/agent-engine";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  baseURL: "https://api.openai.com/v1",
});

const agent = new Agent({
  client,
  model: "gpt-4o-mini",
  session: Session.create("你是一个简洁、可靠的助手。"),
});

agent.on(StreamEventType.TEXT_DELTA, (event) => {
  process.stdout.write(event.delta);
});

const reply = await agent.run("用一句话介绍 AgentEngine。");
console.log("\n\nfinal:", reply.text);
```

如果你接 DeepSeek、Qwen 或其他 OpenAI-compatible 平台，只需要替换 `baseURL` 和 `model`：

```ts
const client = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY,
  baseURL: "https://api.deepseek.com",
});

const agent = new Agent({
  client,
  model: "your-model-name",
  session: Session.create("你是一个中文助手。"),
});
```

## 核心心智模型

一次常规 Agent 运行大致是这样的：

```text
User input
  -> Message.user()
  -> Session 追加用户消息
  -> PromptBuilder 注入临时上下文
  -> Adapter 序列化成平台请求格式
  -> ModelClient.stream() 或 ModelClient.complete()
  -> Parser 解析流式 chunk，或 Adapter 解析完整响应
  -> Agent 派发事件并生成 assistant Message
  -> 如果有 tool_calls，ToolKit 执行工具并写回 Session
  -> 再次请求模型，直到获得最终回复
```

你可以只用 `Agent`，也可以单独使用底层模块：

```ts
import { Message, Session, Tool, ToolKit, StreamParser } from "@notic/agent-engine";
```

推荐学习顺序：

1. 先用 `Agent + Session` 跑通一次模型调用。
2. 再学习 `Tool + ToolKit`，让模型能调用你的函数。
3. 然后学习 `PromptBuilder`，把系统规则、短期上下文、动态提示注入对话。
4. 最后根据平台需要学习 `Provider`、`Adapter`、`MediaResolver` 和 `StreamParser`。

## Message：统一消息模型

`Message` 是 AgentEngine 的最小数据单位。无论是用户输入、模型回复、工具调用、工具结果，最终都会表示为 `Message`。

### 创建消息

```ts
import { Message } from "@notic/agent-engine";

const user = Message.user("你好");
const assistant = Message.assistant("你好，我在。");
const system = Message.system("你是一个严谨的助手。");
const emptyRoot = Message.emptySystem();
```

多模态内容用链式方法追加：

```ts
const message = Message.user("请分析这张图")
  .addImage("https://example.com/chart.png", "image/png")
  .addFile("./data.csv", { fileName: "data.csv" })
  .tag("analysis")
  .setMeta("source", "user-upload");
```

也可以直接传入 `MessagePart`：

```ts
const message = Message.user([
  { type: "text", text: "请总结这个文件" },
  { type: "file", url: "./report.pdf", mimeType: "application/pdf" },
]);
```

### 读取消息内容

常用 getter：

```ts
message.text;        // 拼接所有 text 和 tool_result 内容
message.thinking;    // 拼接所有 thinking 内容
message.toolCalls;   // 当前消息中的 tool_call 列表
message.hasMedia;    // 是否包含 image/audio/file
message.hasThinking; // 是否包含 thinking
```

这些 getter 有缓存。如果你直接修改 `message.parts`，需要手动刷新：

```ts
message.parts.push({ type: "text", text: "追加内容" });
message.invalidateCache();
```

如果使用 `addText()`、`addImage()` 等内置方法，缓存会自动失效。

### 标签与元数据

标签适合做查询、分组和后续插入定位：

```ts
const msg = Message.user("这条消息需要重点处理")
  .tag("important", "todo")
  .setMeta("priority", 10);

msg.hasTag("important"); // true
msg.untag("todo");
```

### 工具消息

模型发起工具调用时，消息里会出现 `tool_call` part。工具执行完成后，用 `Message.tool()` 创建结果：

```ts
const toolResult = Message.tool(
  "call_123",
  JSON.stringify({ temperature: 21 }),
  "get_weather"
);
```

也可以手动构造 assistant 的工具调用消息，测试工具链时很有用：

```ts
const assistantCall = Message.assistantToolCalls([
  { id: "call_123", name: "get_weather", arguments: "{\"city\":\"北京\"}" },
]);
```

### 树结构

`Message` 本身就是树节点。`Session` 会利用这个能力做分支会话。

```ts
const root = Message.system("系统提示");
const user = root.append(Message.user("第一轮问题"));
const assistant = user.append(Message.assistant("第一轮回答"));

assistant.getHistory().map((msg) => msg.text);
// ["系统提示", "第一轮问题", "第一轮回答"]
```

删除节点有两种模式：

```ts
message.remove("prune"); // 删除自己和所有后代
message.remove("graft"); // 删除自己，但把子节点接到父节点下面
```

### 序列化

```ts
const json = message.toJSON();
const restored = Message.fromJSON(json);
```

序列化会保留：

- `role`
- `parts`
- `metadata`
- `tags`
- `model`
- `usage`
- 子树结构

### Message API 摘要

| API | 说明 |
| --- | --- |
| `Message.user(content)` | 创建用户消息 |
| `Message.assistant(content)` | 创建助手消息 |
| `Message.system(content)` | 创建系统消息 |
| `Message.emptySystem()` | 创建空系统根节点 |
| `Message.tool(toolCallId, result, name?)` | 创建工具结果消息 |
| `Message.assistantToolCalls(calls)` | 创建带工具调用的助手消息 |
| `addText(text)` | 追加文本 |
| `addImage(url, mimeType?)` | 追加图片 |
| `addAudio(url, mimeType?)` | 追加音频 |
| `addFile(url, options?)` | 追加文件 |
| `tag(...names)` / `untag(...names)` | 管理标签 |
| `setMeta(key, value)` | 写入元数据 |
| `append(child)` | 追加子节点 |
| `remove("prune" \| "graft")` | 删除节点 |
| `getHistory(includeRoot?)` | 获取根节点到当前节点的路径 |

## Session：会话树

`Session` 管理一棵消息树。最常见的用法是让 `Agent` 自动写入用户消息、助手消息和工具结果。

### 创建会话

```ts
import { Session } from "@notic/agent-engine";

const session = Session.create("你是一个代码助手。");
```

如果不传系统提示，会创建一个空 system root。空 root 在 `history()` 中会被自动跳过，避免发给不支持空系统消息的平台。

```ts
const session = Session.create();
session.history(); // []
```

### 手动追加消息

```ts
session.addUser("你好");
session.addAssistant(Message.assistant("你好，我在。"));

session.history().map((msg) => msg.text);
// ["你好", "你好，我在。"]
```

如果你已经有完整 `Message` 对象，用 `addMessage()`：

```ts
const msg = Message.user("带标签的输入").tag("important");
session.addMessage(msg);
```

工具结果用 `addTool()`，它可以一次追加多条：

```ts
session.addTool([
  Message.tool("call_1", "{\"ok\":true}", "save_file"),
  Message.tool("call_2", "{\"ok\":true}", "run_test"),
]);
```

### 历史与光标

`Session` 有一个当前光标 `cursor`，所有新增消息都会挂在光标后面。

```ts
session.cursor;          // 当前消息
session.history();       // root -> cursor 的路径
session.history(false);  // 不包含 root
session.messages;        // history(true) 的别名
```

### 分支与回退

回退到旧消息后再追加新消息，会自然产生分支：

```ts
const first = session.addUser("方案 A 怎么做？");
session.addAssistant(Message.assistant("A 的回答"));

session.rewind(first);
session.addUser("那方案 B 呢？");
session.addAssistant(Message.assistant("B 的回答"));
```

这时 `first` 下面有两个子分支。你可以用分页器在兄弟分支间切换。

### Query：查询消息

`session.query` 返回查询器。它不是链式 builder，而是提供一组直接返回结果的方法：

```ts
import { Role } from "@notic/agent-engine";

const users = session.query.findByRole(Role.User);
const important = session.query.findByTags(["important"]);

const latestAnswer = session.query.findLast({ roles: [Role.Assistant] });
```

常见查询条件：

```ts
session.query.findByContent(["error"]);
session.query.findByTags(["todo"], { scope: "tree" });
session.query.findBy((msg) => msg.text.length > 100);
session.query.findFirst({ content: ["关键问题"] });
session.query.findLast({ roles: [Role.User] });
```

### Inserter：在历史中插入消息

`Inserter` 适合做会话修补、动态插入上下文等操作。

```ts
const anchor = session.query.findFirst({ content: ["关键问题"] });

if (anchor) {
  session.inserter
    .moveTo(anchor)
    .insertAfter(Message.system("补充背景：这是一个高优先级任务"))
    .execute();
}
```

常见操作：

```ts
session.inserter.moveTo(anchor).insertAfter(msg).execute();
session.inserter.moveTo(anchor).insertBefore(msg).execute();
session.inserter.bottom().insertUserAfter("追加一条用户消息").execute();
session.inserter.top().insertAssistantBefore("插到顶部之前").execute();
```

### Paginator：切换分支

```ts
const paginator = session.paginator(parentMessage);

if (paginator) {
  paginator.total;     // 分支数量
  paginator.currentIndex; // 当前分支序号
  paginator.next();    // 切到下一个分支
  paginator.prev();    // 切到上一个分支
  paginator.goTo(0);   // 切到指定分支
}
```

### Session API 摘要

| API | 说明 |
| --- | --- |
| `Session.create(systemPrompt?)` | 创建会话 |
| `addUser(content)` | 追加用户消息 |
| `addAssistant(message)` | 追加助手消息 |
| `addTool(messages)` | 追加工具结果 |
| `addMessage(message)` | 追加任意消息 |
| `history(includeRoot?)` | 获取当前路径 |
| `rewind(message)` | 把光标回退到指定消息 |
| `query` | 查询器 getter |
| `inserter` | 插入器 getter |
| `paginators` | 当前路径上的所有分支分页器 |
| `paginator(message)` | 创建指定父节点的分支分页器 |
| `clear()` | 清空会话到 root |
| `systemPrompt` | 读取或设置系统提示 |
| `toJSON()` / `fromJSON()` | 序列化与恢复 |

## Tool：工具系统

工具让模型可以调用你的 TypeScript 函数。AgentEngine 的工具系统包含四层：

- `Param`：定义参数 JSON Schema。
- `Tool`：定义函数、名称、描述、参数和生命周期 Hook。
- `ToolKit`：注册多个工具，并根据模型的 `tool_call` 执行对应函数。
- `Context`：工具执行期间共享的上下文，可读写参数、结果和错误。

### 定义第一个工具

```ts
import { Param, Tool, ToolKit } from "@notic/agent-engine";

const getWeather = Tool.create(async (args) => {
  const city = args.city as string;
  return { city, temperature: 21, unit: "celsius" };
})
  .name("get_weather")
  .description("查询城市天气")
  .params(
    Param.string("city").desc("城市名称，例如北京").required(),
    Param.string("unit").desc("温度单位").enum(["celsius", "fahrenheit"])
  )
  .build();

const toolkit = new ToolKit().add(getWeather);
```

传给 Agent：

```ts
const agent = new Agent({
  client,
  model: "your-model",
  session: Session.create("你可以在需要时调用工具。"),
  toolkit,
});
```

当模型返回工具调用时，Agent 会自动：

1. 解析 `tool_call`
2. 审批工具调用
3. 调用 `ToolKit.execute()`
4. 把工具结果作为 `tool` 消息写回 `Session`
5. 再次请求模型生成最终答案

### 参数定义 Param

```ts
import { ValueType } from "@notic/agent-engine";

Param.string("name").required().desc("姓名");
Param.integer("age").desc("年龄");
Param.number("score");
Param.boolean("enabled");
Param.array("tags", ValueType.String);
Param.object("range", [
  Param.number("min").required(),
  Param.number("max").required(),
]);
```

数组元素可以是基本类型，也可以是对象参数：

```ts
const items = Param.array("items", [
  Param.string("title").required(),
  Param.integer("count").required(),
]);
```

### 生命周期 Hook

Hook 让你在工具执行的不同阶段插入逻辑：

```ts
import { Hook } from "@notic/agent-engine";

const tool = Tool.create(async (args) => {
  return { ok: true, args };
})
  .name("save")
  .description("保存数据")
  .params(Param.string("content").required())
  .on(Hook.ON_VALIDATE, (ctx) => {
    if ((ctx.arguments.content as string).length === 0) {
      throw new Error("content 不能为空");
    }
  })
  .on(Hook.AFTER_EXECUTE, (ctx) => {
    ctx.result = { ...ctx.result as object, savedAt: new Date().toISOString() };
  })
  .on(Hook.ON_ERROR, (ctx) => {
    ctx.result = { ok: false, error: ctx.error?.message };
  })
  .build();
```

Hook 顺序：

```text
ON_CREATE -> ON_VALIDATE -> BEFORE_EXECUTE -> function -> AFTER_EXECUTE -> ON_SERIALIZE
                                      \-> ON_ERROR
```

常用 Hook：

| Hook | 用途 |
| --- | --- |
| `ON_CREATE` | 工具调用对象创建后 |
| `ON_VALIDATE` | 内置必填校验前后做额外校验 |
| `BEFORE_EXECUTE` | 真正执行函数前 |
| `AFTER_EXECUTE` | 函数成功执行后，可改写结果 |
| `ON_SERIALIZE` | 转成 `Message.tool()` 前 |
| `ON_ERROR` | 校验或执行出错时，可设置 fallback result |

### Context

工具函数和 Hook 都能访问 `Context`：

```ts
const tool = Tool.create(async (args, ctx) => {
  ctx.throwIfAborted();
  ctx.result = { ok: true };
  return ctx.result;
});
```

常用字段：

- `ctx.id`
- `ctx.name`
- `ctx.arguments`
- `ctx.result`
- `ctx.error`
- `ctx.cancelled`
- `ctx.cancelReason`
- `ctx.signal`
- `ctx.cancel(reason)`
- `ctx.throwIfAborted()`

### ToolKit 执行工具

```ts
const result = await toolkit.execute({
  type: "tool_call",
  toolCallId: "call_1",
  name: "get_weather",
  arguments: "{\"city\":\"北京\"}",
});

console.log(result.text);
```

执行多个工具：

```ts
const results = await toolkit.executeAll(toolCalls);
```

错误策略：

```ts
await toolkit.execute(toolCall, { errorPolicy: "return_to_model" });
await toolkit.execute(toolCall, { errorPolicy: "throw" });
```

- `return_to_model`：工具异常会转成模型可读的 tool result。
- `throw`：抛出 `ToolExecutionError`。

### MCP 工具

如果你使用 Model Context Protocol，可以把 MCP client 的工具导入 `ToolKit`：

```ts
await toolkit.addMCP(mcpClient);
```

MCP client 需要提供：

```ts
interface McpClientLike {
  listTools(): Promise<{
    tools: Array<{
      name: string;
      description?: string;
      inputSchema: Record<string, unknown>;
    }>;
  }>;

  callTool(params: {
    name: string;
    arguments?: Record<string, unknown>;
  }): Promise<{
    content: Array<{ type: string; text?: string }>;
  }>;
}
```

### Tool API 摘要

| API | 说明 |
| --- | --- |
| `Tool.create(fn)` | 创建工具 builder |
| `Tool.fromRaw(name, desc, schema, fn)` | 从已有 schema 创建工具 |
| `tool.name(name)` | 设置工具名 |
| `tool.description(desc)` | 设置描述 |
| `tool.params(...params)` | 添加参数 |
| `tool.on(hook, handler)` | 注册 Hook |
| `tool.build()` | 冻结 schema，进入运行态 |
| `tool.schema` | OpenAI tools schema |
| `tool.create(id, args, signal?)` | 创建一次具体工具调用 |
| `new ToolKit().add(...tools)` | 注册工具 |
| `toolkit.schemas` | 所有工具 schema |
| `toolkit.execute(call, options?)` | 执行单个工具调用 |
| `toolkit.executeAll(calls, options?)` | 执行多个工具调用 |

## Stream：流式事件

`StreamParser` 把 OpenAI-compatible 的流式 chunk 解析成结构化事件。你通常不需要手动使用它，因为 `Agent` 已经内置；但写底层测试、自定义客户端或调试流式协议时很有用。

### 手动解析 stream

```ts
import { StreamParser, StreamEventType } from "@notic/agent-engine";

const parser = new StreamParser();

for await (const chunk of stream) {
  const events = parser.feed(chunk);

  for (const event of events) {
    if (event.type === StreamEventType.TEXT_DELTA) {
      process.stdout.write(event.delta);
    }
  }
}

const finalEvents = parser.finish();
const done = finalEvents.find((event) => event.type === StreamEventType.MESSAGE_DONE);
console.log(done?.message.text);
```

### 支持的增量内容

`StreamParser` 支持：

- `delta.content`：文本
- `delta.reasoning_content`：DeepSeek / Qwen 等推理内容
- `delta.thinking`：Claude-like thinking 内容
- `delta.tool_calls`：工具调用增量
- `usage`：stream usage chunk

### 常用事件

| 事件 | 触发时机 |
| --- | --- |
| `TEXT_DELTA` | 收到文本增量 |
| `TEXT_DONE` | 文本流结束 |
| `THINKING_DELTA` | 收到思考增量 |
| `THINKING_DONE` | 思考流结束 |
| `TOOL_CALL_START` | 第一次拿到工具调用 id 和 name |
| `TOOL_CALL_DELTA` | 收到工具参数增量 |
| `TOOL_CALL_DONE` | 工具调用参数组装完成 |
| `MESSAGE_DONE` | 完整 assistant message 组装完成 |
| `ERROR` | chunk 解析异常 |

`Agent` 会额外派发：

| 事件 | 触发时机 |
| --- | --- |
| `TURN_START` | 新一轮模型调用开始 |
| `TURN_END` | 一轮模型调用结束 |
| `TOOL_APPROVAL_REQUIRED` | 工具调用需要审批 |
| `TOOL_APPROVAL_ACCEPTED` | 工具调用审批通过 |
| `TOOL_APPROVAL_REJECTED` | 工具调用审批拒绝 |
| `TOOL_EXECUTE_START` | 工具开始执行 |
| `TOOL_EXECUTE_DONE` | 工具执行完成 |
| `TOOL_EXECUTE_ERROR` | 工具执行失败 |

## Prompt：提示词构建

`PromptBuilder` 用来在模型请求前动态改写上下文。它不会修改原始 `Session`，而是基于 `history` 生成一个临时消息数组。

适合这些场景：

- 在最近一条用户消息前插入临时规则。
- 在系统提示后追加运行时上下文。
- 按标签、角色、内容定位消息，然后插入补充说明。
- 在发送模型前过滤、裁剪或改写历史。

### 注入一条系统提示

```ts
import { PromptBuilder, Rule } from "@notic/agent-engine";

const builder = new PromptBuilder();

builder.injectSystem(
  Rule.top().after(),
  "运行时上下文：当前用户是高级开发者。"
);

const context = builder.build(session.history());
```

`Rule.top().after()` 的意思是：定位到第一条消息，在它后面插入。

### 按角色定位

```ts
import { Role } from "@notic/agent-engine";

builder.injectSystem(
  Rule.byRole(Role.User).last().before(),
  "请优先回答用户最近的问题。"
);
```

### 按内容或标签定位

```ts
builder.injectAssistant(
  Rule.byContent(["数据库", "迁移"]).after(),
  "已检测到数据库迁移相关上下文。"
);

builder.injectSystem(
  Rule.byTags(["important"]).before(),
  "下面是一条重要消息。"
);
```

### 生命周期、概率和优先级

```ts
builder.injectSystem(Rule.top().before(), "只生效一次", {
  life: 1,
  probability: 1,
  priority: 10,
});
```

- `life: -1`：永久有效。
- `life: 1`：触发并构建一次后过期。
- `probability`：0 到 1，控制是否触发。
- `priority`：多个 injection 的执行优先级，数值越小越早执行。

清理过期 injection：

```ts
builder.prune();
```

### batch 与 immediate

`build()` 默认使用 `batch`：

```ts
builder.build(history, { strategy: "batch" });
```

- `batch`：所有 injection 都基于原始 history 定位。
- `immediate`：后面的 injection 能看到前面 injection 插入后的结果。

例子：

```ts
builder.injectSystem(Rule.bottom().after(), "第一条");
builder.injectSystem(Rule.byContent(["第一条"]).after(), "第二条");

builder.build(history, { strategy: "batch" });     // 第二条找不到第一条
builder.build(history, { strategy: "immediate" }); // 第二条能插入到第一条后面
```

### 数组操作管线

除了 injection，`PromptBuilder` 还可以像数组管线一样改写上下文：

```ts
builder
  .filter((msg) => msg.text.length > 0)
  .slice(-20)
  .map((msg) => msg)
  .insertAt(0, Message.system("最高优先级规则"));

const context = builder.build(session.history());
```

常用操作：

```ts
builder.use((messages) => messages);
builder.insertAt(index, message);
builder.removeAt(index, count);
builder.removeWhere((msg) => msg.hasTag("debug"));
builder.replaceWhere((msg) => msg.hasTag("old"), Message.system("new"));
builder.filter((msg) => msg.role !== Role.Tool);
builder.slice(-10);
builder.map((msg) => msg);
builder.transform((messages) => messages.reverse());
```

### Rule API 摘要

| API | 说明 |
| --- | --- |
| `Rule.top()` | 定位第一条消息 |
| `Rule.bottom()` | 定位最后一条消息 |
| `Rule.index(n)` | 定位指定索引，支持负数 |
| `Rule.byRole(role)` | 按角色定位 |
| `Rule.byContent(keywords, options?)` | 按内容关键词定位 |
| `Rule.byTags(tags)` | 按标签定位 |
| `Rule.by(fn)` | 自定义谓词 |
| `first()` / `last()` / `all()` | 匹配策略 |
| `before()` / `after()` | 插入方向 |
| `offset(n)` | 在匹配点上偏移 |
| `order(n)` | 同插入点展示顺序 |
| `scanDepth(n)` | 限制扫描深度 |
| `scanForward()` / `scanReverse()` | 扫描方向 |
| `resolve(messages)` | 返回插入索引 |

### PromptBuilder API 摘要

| API | 说明 |
| --- | --- |
| `inject(rule, message, options?)` | 注入任意消息 |
| `injectSystem(rule, content, options?)` | 注入 system 消息 |
| `injectUser(rule, content, options?)` | 注入 user 消息 |
| `injectAssistant(rule, content, options?)` | 注入 assistant 消息 |
| `injectAll(rule, messages, options?)` | 批量注入 |
| `remove(injection)` / `removeById(id)` / `removeByRule(rule)` | 删除 injection |
| `enable(injection)` / `disable(injection)` | 启用或禁用 |
| `clearInjections()` | 清空 injection |
| `clearOperations()` | 清空操作管线 |
| `clear()` | 清空 injection 和 operation |
| `build(history, options?)` | 生成临时上下文 |
| `buildBatch(history)` | batch 构建 |
| `buildImmediate(history)` | immediate 构建 |

## Config：请求参数

`RequestConfig` 用链式 API 构建模型请求参数。

```ts
import { RequestConfig } from "@notic/agent-engine";

const config = RequestConfig.create()
  .temperature(0.3)
  .topP(0.9)
  .maxTokens(1024)
  .stop("\n\nEND")
  .seed(42);
```

传给 Agent：

```ts
const agent = new Agent({
  client,
  model: "your-model",
  session,
  config,
});
```

### 预设

```ts
RequestConfig.precise();   // 低温度，偏稳定
RequestConfig.balanced();  // 平衡
RequestConfig.creative();  // 高温度，偏发散
```

### 自定义参数

不同平台可能有额外字段，用 `set()`：

```ts
const config = RequestConfig.create()
  .set("response_format", { type: "json_object" })
  .set("parallel_tool_calls", false);
```

常用内置方法：

```ts
config.temperature(0.7);
config.topP(0.95);
config.topK(40);
config.maxTokens(2048);
config.frequencyPenalty(0.2);
config.presencePenalty(0.2);
config.stop("END");
config.seed(123);
config.responseFormat("json_object");
config.unset("seed");
```

### 参数优先级

一次 Agent 请求最终参数按这个顺序合并，后者覆盖前者：

```text
RequestConfig -> Agent.requestOptions -> agent.run(..., runOptions)
```

例子：

```ts
const agent = new Agent({
  client,
  model: "your-model",
  session,
  config: RequestConfig.create().temperature(0.2),
  requestOptions: { temperature: 0.5 },
});

await agent.run("这一轮更发散一点", { temperature: 1.0 });
```

最终 `temperature` 是 `1.0`。

### Config API 摘要

| API | 说明 |
| --- | --- |
| `RequestConfig.create()` | 空配置 |
| `precise()` / `balanced()` / `creative()` | 预设 |
| `temperature(n)` | 温度，自动 clamp 到 0-2 |
| `topP(n)` | top_p，自动 clamp 到 0-1 |
| `topK(n)` | top_k，最小为 1 |
| `maxTokens(n)` | max_tokens，最小为 1 |
| `frequencyPenalty(n)` / `presencePenalty(n)` | 惩罚参数 |
| `stop(...seq)` | 停止序列，最多保留 4 个 |
| `seed(n)` | 随机种子 |
| `responseFormat(format, schema?)` | 响应格式 |
| `set(key, value)` | 自定义字段 |
| `unset(key)` | 删除字段 |
| `merge(other)` | 合并配置 |
| `clone()` | 克隆 |
| `build()` | 输出普通对象 |

## Provider：平台能力组合

Provider 是 AgentEngine 的平台边界。它不拥有 Agent 的 Session、工具循环或运行状态，
只组合三个可以独立替换的组件：

```text
Provider
├─ ModelClient          发送请求，返回 stream 或完整响应
├─ MessageAdapter       Message[] <-> 平台请求/响应
└─ MessageStreamParser  平台 stream -> 统一事件和 Message
```

因此接入新平台时，不需要在 `Agent` 中增加平台判断。只需提供对应的 Client、Adapter
和 Parser，并保证最终仍然使用统一 `Message`。

### OpenAI Compatible Provider

适用于 OpenAI Chat Completions，以及 DeepSeek、Qwen、Kimi、GLM 等兼容接口：

```ts
import OpenAI from "openai";
import {
  Agent,
  OpenAICompatibleProvider,
  Session,
} from "@notic/agent-engine";

const client = new OpenAI({
  apiKey: process.env.PROVIDER_API_KEY,
  baseURL: "https://your-provider.example/v1",
});

const agent = new Agent({
  provider: new OpenAICompatibleProvider(client),
  model: "your-model",
  session: Session.create(),
});
```

为了兼容旧代码，也可以继续直接传 `client`。此时 Agent 默认使用
`OpenAIAdapter + StreamParser`。

### OpenAI Responses Provider

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

该 Provider 使用原生 Responses API，并支持：

- `response.output_text.*` 文本事件
- reasoning summary 与 encrypted reasoning item 回传
- `function_call` / `function_call_output` 工具循环
- `max_output_tokens`、结构化输出和 usage
- 流式及非流式完整响应

### Anthropic Provider

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

Anthropic Provider 使用原生 Messages API，处理 system 提取、content blocks、thinking
signature、tool use 和原生 usage。

### Gemini Provider

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

Gemini Provider 使用 `generateContentStream()` 和 `generateContent()`，处理 contents、
systemInstruction、functionCall、functionResponse 和 thought signature。

### 流式与非流式

内置 Provider 同时支持两种运行方式：

```ts
// 默认：增量事件
const streamed = await agent.run("介绍一下这个项目");

// 完整响应：不经过 StreamParser
const completed = await agent.run("介绍一下这个项目", {
  stream: false,
});
```

非流式模式仍然经过统一 Adapter，并保留 Session、PromptBuilder、工具审批、工具执行、
自动多轮循环、timeout、abort、model 和 usage。它不产生 `TEXT_DELTA`，但会产生
`TEXT_DONE`、`TOOL_CALL_DONE` 和 `MESSAGE_DONE`。

```ts
provider.supportsComplete; // ModelClient 是否实现 complete()
```

### 自定义 Provider

自定义 Client 只负责传输，不需要认识 Message、Session 或 Tool：

```ts
import {
  Agent,
  ModelClient,
  Provider,
  Session,
} from "@notic/agent-engine";

const client: ModelClient = {
  async stream(request, options) {
    return mySdk.createStream(request, { signal: options?.signal });
  },
  async complete(request, options) {
    return mySdk.create(request, { signal: options?.signal });
  },
};

const provider = Provider.create({
  client,
  adapter: new MyAdapter(),
  parserFactory: () => new MyStreamParser(),
});

const agent = new Agent({
  provider,
  model: "my-model",
  session: Session.create(),
});
```

`ModelClient.complete()` 是可选能力。只实现 `stream()` 的自定义 Provider 仍然兼容，
但调用 `{ stream: false }` 时会收到明确错误。显式传给 Agent 的 `client`、`adapter`
或 `parserFactory` 会覆盖 Provider 中的对应预设。

## Adapter：平台适配

AgentEngine 内部统一使用 `Message`，但不同平台请求格式不同。`Adapter` 负责把 `Message[]` 转成平台格式，也可以把平台响应转回 `Message`。

内置适配器：

| 适配器 | 常见平台 |
| --- | --- |
| `OpenAIAdapter` | OpenAI、DeepSeek、Qwen、Kimi、GLM 等 OpenAI-compatible API |
| `AnthropicAdapter` | Claude Messages API |
| `GeminiAdapter` | Gemini |

`Agent` 默认使用 `OpenAIAdapter`。

### 手动指定适配器

```ts
import { Agent, OpenAIAdapter } from "@notic/agent-engine";

const agent = new Agent({
  client,
  model: "your-model",
  session,
  adapter: new OpenAIAdapter(),
});
```

### 自定义 MediaResolver

多模态消息里可能有本地文件、HTTP 文件或 data URI。`OpenAIAdapter` 可以接收媒体解析器：

```ts
import { DefaultMediaResolver, OpenAIAdapter } from "@notic/agent-engine";

const adapter = new OpenAIAdapter(new DefaultMediaResolver());
```

### 思考内容序列化

AgentEngine 支持 thinking / reasoning 内容。序列化时可以控制是否回传给模型：

```ts
await agent.run("继续", {
  serializeOptions: {
    thinking: {
      mode: "auto",
      scope: "last",
    },
  },
});
```

`mode`：

- `none`：不序列化 thinking。
- `native`：使用平台原生 thinking 字段。
- `message`：把 thinking 放进文本消息。
- `auto`：根据 adapter 能力自动选择。

`scope`：

- `none`：不包含。
- `last`：只包含最后一条。
- `tool_call`：工具调用相关场景包含。
- `all`：全部包含。

DeepSeek / Qwen 等模型如果要求工具调用时回传 reasoning 内容，可以在 `run()` 时显式设置。

## Media：媒体解析

`MediaResolver` 用来把图片、音频、文件 URL 转成模型平台需要的 base64 / MIME 信息。

接口：

```ts
interface MediaResolver {
  resolve(url: string): Promise<{
    mimeType: string;
    base64: string;
  }>;
}
```

默认实现：

```ts
import { DefaultMediaResolver } from "@notic/agent-engine";

const resolver = new DefaultMediaResolver();
const file = await resolver.resolve("./image.png");
```

`DefaultMediaResolver` 支持：

- `data:` URI
- HTTP / HTTPS URL
- 本地文件路径

无法识别 MIME 时，会退回到 `application/octet-stream`。

## Agent：智能体编排

`Agent` 是最常用入口。它把 `Session`、`Adapter`、`StreamParser`、`ToolKit`、`PromptBuilder` 和 `RequestConfig` 串起来。

### 创建 Agent

```ts
import OpenAI from "openai";
import { Agent, RequestConfig, Session } from "@notic/agent-engine";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const agent = new Agent({
  client,
  model: "gpt-4o-mini",
  session: Session.create("你是一个可靠的助手。"),
  config: RequestConfig.create().temperature(0.3).maxTokens(1024),
  maxTurns: 8,
});
```

`client` 只需要满足这个最小接口：

```ts
interface OpenAIClientLike {
  chat: {
    completions: {
      create(params: any, options?: any): Promise<any>;
    };
  };
}
```

这意味着你可以传官方 `openai` SDK，也可以传自己的兼容客户端。

### 运行

```ts
const reply = await agent.run("帮我写一个提交说明。");
console.log(reply.text);
```

默认使用流式请求。需要等待一次完整响应时，设置 `stream: false`：

```ts
const reply = await agent.run("直接返回完整结果", {
  stream: false,
});

console.log(reply.text);
console.log(reply.usage);
```

非流式模式仍然支持 Session 写入、工具自动循环、工具审批、超时和中断。
它不会产生 `TEXT_DELTA` 等增量事件，但会产生 `TEXT_DONE`、`TOOL_CALL_DONE`
和 `MESSAGE_DONE` 等完成事件。

内置 Provider 都支持非流式请求。自定义 Provider 可以通过
`provider.supportsComplete` 检查其 `ModelClient` 是否实现了 `complete()`。

传入已构建的消息：

```ts
const input = Message.user("这条消息带标签").tag("task");
const reply = await agent.runWith(input);
```

不写入 `Session`，直接跑一次 raw 请求：

```ts
const reply = await agent.runRaw([
  Message.system("你是一个 JSON 助手。"),
  Message.user("输出 {\"ok\":true}"),
], { stream: false });
```

### 监听事件

```ts
agent
  .on(StreamEventType.TEXT_DELTA, (event) => {
    process.stdout.write(event.delta);
  })
  .on(StreamEventType.TOOL_EXECUTE_START, (event) => {
    console.log("tool start:", event.name);
  })
  .on(StreamEventType.TOOL_EXECUTE_DONE, (event) => {
    console.log("tool done:", event.name, event.result.text);
  })
  .on(StreamEventType.ERROR, (event) => {
    console.error(event.error);
  });
```

事件 handler 抛错默认会打印到 `console.error`，但不会中断 Agent。可以自定义处理器：

```ts
agent.setHandlerErrorHandler((error, event) => {
  logger.warn({ error, event }, "Agent event handler failed");
});
```

### 请求级参数

```ts
await agent.run("这一轮限制更短", {
  temperature: 0,
  max_tokens: 128,
  timeoutMs: 30_000,
});
```

`AgentRunOptions` 中的特殊字段不会发送给模型：

- `signal`
- `timeoutMs`
- `promptBuildOptions`
- `serializeOptions`
- `stream`

其他字段会作为模型请求参数合并进去。

### 动态更新配置

```ts
agent.setModel("another-model");
agent.setMaxTurns(12);
agent.setConfig(RequestConfig.precise());
agent.setRequestOptions({ temperature: 0.1 });
agent.setPromptBuilder(builder);
agent.setToolErrorPolicy("pause");
```

常用 getter：

```ts
agent.model;
agent.session;
agent.config;
agent.promptBuilder;
agent.toolApproval;
agent.toolErrorPolicy;
agent.lastRunState;
agent.canResume;
agent.canContinue;
agent.isRunning;
```

### 工具审批

默认是自动批准工具调用。如果你想自己判断：

```ts
const agent = new Agent({
  client,
  model: "your-model",
  session,
  toolkit,
  toolApproval: async (request) => {
    if (request.name === "delete_file") {
      return { approved: false, reason: "危险操作需要人工确认" };
    }
    return true;
  },
});
```

审批请求结构：

```ts
interface ToolApprovalRequest {
  approvalId: string;
  toolCallId: string;
  name: string;
  arguments: Record<string, unknown>;
  rawArguments: string;
  turn: number;
}
```

### 手动审批模式

如果你要把审批交给 UI：

```ts
const agent = new Agent({
  client,
  model: "your-model",
  session,
  toolkit,
  toolApprovalMode: "manual",
  toolApprovalTimeoutMs: 60_000,
});

const run = agent.run("执行需要审批的任务");

// UI 轮询或订阅 pendingApprovals
const [approval] = agent.pendingApprovals;
agent.approve(approval.approvalId);
// 或 agent.reject(approval.approvalId, "用户拒绝");

await run;
```

也可以监听 `TOOL_APPROVAL_REQUIRED`：

```ts
agent.on(StreamEventType.TOOL_APPROVAL_REQUIRED, (event) => {
  showApprovalDialog(event);
});
```

超时策略：

- `toolApprovalTimeoutPolicy: "reject"`：超时后拒绝工具调用。
- `toolApprovalTimeoutPolicy: "abort"`：超时后中断本次运行。

### 工具错误策略

```ts
const agent = new Agent({
  client,
  model: "your-model",
  session,
  toolkit,
  toolErrorPolicy: "return_to_model",
});
```

策略：

- `return_to_model`：默认。工具异常变成 tool result，让模型自己解释或重试。
- `pause`：写入带 `paused: true` 的 tool result，Agent 进入可恢复失败状态。
- `throw`：直接抛出错误，不写入可恢复状态。

### 中断、继续与恢复

中断当前运行：

```ts
agent.abort("用户取消");
```

用外部 `AbortSignal`：

```ts
const controller = new AbortController();

await agent.run("长任务", {
  signal: controller.signal,
});
```

超时：

```ts
await agent.run("最多等 10 秒", { timeoutMs: 10_000 });
```

如果中断时已经有部分内容，Agent 会把 partial assistant message 写入 session，并设置 `canResume`：

```ts
if (agent.canResume) {
  await agent.resume();
}
```

普通继续：

```ts
if (agent.canContinue) {
  await agent.continue({
    prompt: "请继续上一条回答，不要重复已经说过的内容。",
  });
}
```

### 运行状态

```ts
const state = agent.lastRunState;

state?.status;      // "running" | "completed" | "interrupted" | "failed"
state?.stopReason;  // "final" | "timeout" | "abort" | "tool_execution_error" ...
state?.turn;        // 当前轮次
state?.canResume;   // 是否可恢复
state?.lastMessage; // 最近完成的消息
state?.partialMessage; // 部分消息
state?.error;       // 错误对象
```

常见 `stopReason`：

| stopReason | 含义 |
| --- | --- |
| `final` | 正常完成 |
| `abort` | 主动中断 |
| `timeout` | 超时 |
| `network_error` | 网络或 API 请求失败 |
| `stream_error` | 流式解析或读取失败 |
| `tool_approval_rejected` | 工具审批被拒绝 |
| `tool_execution_error` | 工具执行失败 |
| `max_tokens` | 模型输出达到 token 限制 |
| `max_turns` | 工具循环超过最大轮数 |
| `unknown_error` | 未分类错误 |

### AgentOptions 摘要

| 字段 | 说明 |
| --- | --- |
| `client` | OpenAI-compatible 客户端 |
| `model` | 模型名 |
| `session` | 会话 |
| `adapter?` | 消息适配器，默认 `OpenAIAdapter` |
| `toolkit?` | 工具包 |
| `toolApproval?` | 自定义工具审批函数 |
| `toolApprovalMode?` | `"auto"` 或 `"manual"` |
| `toolApprovalTimeoutMs?` | 手动审批超时 |
| `toolApprovalTimeoutPolicy?` | `"reject"` 或 `"abort"` |
| `toolErrorPolicy?` | `"return_to_model"` / `"pause"` / `"throw"` |
| `maxTurns?` | 最大自动循环轮数，默认 10 |
| `promptBuilder?` | 提示词构建器 |
| `config?` | 请求参数配置 |
| `requestOptions?` | 额外请求参数 |

## Utils：工具函数

### generateId

```ts
import { generateId } from "@notic/agent-engine";

generateId();        // 类似 "l3k..."
generateId("msg");   // 类似 "msg-l3k..."
```

它用于生成轻量 ID，不保证密码学安全。

## 常见组合方案

### 方案一：只做聊天

```ts
const agent = new Agent({
  client,
  model: "your-model",
  session: Session.create("你是一个中文助手。"),
});

const reply = await agent.run("你好");
```

### 方案二：聊天 + 工具

```ts
const toolkit = new ToolKit().add(getWeather, searchDocs);

const agent = new Agent({
  client,
  model: "your-model",
  session: Session.create("需要外部信息时请调用工具。"),
  toolkit,
});

await agent.run("今天北京适合跑步吗？");
```

### 方案三：聊天 + 动态提示词

```ts
const promptBuilder = new PromptBuilder()
  .injectSystem(Rule.top().after(), "当前产品版本：1.1.x")
  .slice(-30);

const agent = new Agent({
  client,
  model: "your-model",
  session,
  promptBuilder,
});
```

### 方案四：人工审批危险工具

```ts
const agent = new Agent({
  client,
  model: "your-model",
  session,
  toolkit,
  toolApproval: (request) => {
    if (request.name.startsWith("delete_")) {
      return { approved: false, reason: "禁止删除操作" };
    }
    return true;
  },
});
```

### 方案五：真实 API 测试

项目内建议把真实 API 测试和 fake 测试分开：

```bash
npm test
```

默认只跑本地 fake / 单元测试。真实 API 测试可以使用显式开关：

```bash
RUN_REAL_DEEPSEEK_TESTS=1 DEEPSEEK_API_KEY=sk-... npm run test:real:deepseek
```

这样 CI、开发机和发布前验证都不会误触发真实请求。
