# ⚡ AgentEngine

一个轻量、优雅、功能完整的 TypeScript AI Agent 框架。

> **简单的事情简单做，复杂的事情也能做。**

```typescript
const agent = new Agent({ client, model: "gpt-4o", session: Session.create("你是AI助手") });
agent.on(StreamEventType.TEXT_DELTA, (e) => process.stdout.write(e.delta));
await agent.run("你好");
```

---

## ✨ 核心特性

- 🌳 **树结构会话管理** — 天然支持对话分支、回退、分页导航
- 🔧 **工具生命周期钩子** — ON_CREATE → ON_VALIDATE → BEFORE_EXECUTE → AFTER_EXECUTE → ON_SERIALIZE / ON_ERROR
- 🌊 **流式解析器** — 无状态纯函数设计，结构化事件驱动
- 📝 **提示词构建器** — 声明式注入规则 + 生命周期 + 概率触发 + 扫描深度
- ⚙️ **请求参数配置器** — 预设模式+ 链式构建 + 三层优先级合并
- 🔌 **MCP 原生集成** — 一行代码接入，与手动工具完全同构
- 🎨 **多模态支持** — 图片/ 音频 / 文件，媒体资源懒加载
- 💭 **思考内容提取** — 兼容 DeepSeek / Qwen / Claude 的推理过程
- 🔄 **适配器模式** — 统一消息模型，一个接口换平台

---

## 📦 架构总览

```
AgentEngine
├── 📨 Message       统一消息模型（多模态 + 树结构）
├── 🔌 Adapter       消息序列化适配器（OpenAI / 可扩展）
├── 🖼️ Media         媒体资源懒加载解析器
├── 💬 Session       会话管理（树结构 + 分支 + 分页）
├── 🔧 Tool          工具系统（Builder + 生命周期钩子 + MCP）
├── 🌊 Stream        流式解析器（纯函数 + 结构化事件）
├── 📝 Prompt        提示词构建器（声明式注入 + 生命周期）
├── ⚙️ Config        请求参数配置器（预设 + 链式构建）
└── 🤖 Agent         智能体编排层（串联一切 + 自动循环）
```

---

##🚀 快速开始

### 安装依赖

```bash
npm install
```

### 最简示例

```typescript
import { Agent, Session, StreamEventType } from "./src";
import { OpenAI } from "openai";

const client = new OpenAI({ apiKey:"sk-...", baseURL: "..." });

const agent = new Agent({
  client,
  model: "gpt-4o",
  session: Session.create("你是一个友好的AI助手"),
});

agent.on(StreamEventType.TEXT_DELTA, (e) => process.stdout.write(e.delta));

const reply = await agent.run("你好！");
console.log(reply.text);
```

---

## 📖 模块详解

### 📨 Message — 统一消息模型

树结构消息模型，支持多模态内容，天然支持对话分支。

```typescript
// 创建消息
const msg = Message.user("你好");
const msg = Message.system("你是AI助手");
const msg = Message.assistant("你好！");

// 多模态
const msg = Message.user("看看这张图")
  .addImage("https://example.com/photo.jpg")
  .addFile("./data.csv")
  .tag("multimodal")
  .setMeta("priority", "high");

// 便捷 Getter
msg.text;         // 文本内容
msg.thinking;     // 思考/推理内容
msg.toolCalls;    // 工具调用列表
msg.hasMedia;     // 是否含媒体
msg.hasThinking;  // 是否含思考

// 树结构
msg.parent;       // 父节点
msg.children;     // 子节点列表
msg.getHistory(); // 从根到当前的路径
msg.depth;        // 在树中的深度
msg.isRoot;       // 是否根节点
msg.isLeaf;       // 是否叶子节点
```

#### 消息内容类型 (MessagePart)

| 类型 | 说明 |
|------|------|
| `TextPart` | 文本内容 |
| `ImagePart` | 图片（URL / data URI /本地路径） |
| `AudioPart` | 音频 |
| `FilePart` | 文件附件 |
| `ToolCallPart` | LLM 发起的工具调用 |
| `ToolResultPart` | 工具执行结果 |
| `ThinkingPart` | 模型推理/思考过程 |

### 💬 Session — 会话管理

基于树结构的会话管理器，通过光标（cursor）追踪当前对话位置。

```typescript
const session = Session.create("你是AI助手");

// 基本对话
session.addUser("你好");
session.addAssistant(reply);
const history = session.history(); // [System, User, Assistant]

// 分支对话 — 回退并分叉
const branchPoint = session.cursor.parent;
session.rewind(branchPoint);
session.addUser("换个话题"); // 自动产生新分支

// 分支导航
session.allLeaves;// 所有分支末端
session.branches;    // 所有分支路径

// 分页器— 在分支间切换
const pag = session.paginators[0];
pag.next();          // 下一个分支
pag.prev();          // 上一个分支
pag.goTo(2);         // 跳转到第3个分支
pag.total;           // 总分支数

// 系统提示词
session.systemPrompt = "新的系统提示";

// Token 统计
session.totalUsage;  // 累计所有 Assistant 消息的Usage
```

#### Inserter — 命令式插入器

用于在对话树中精确插入消息。

```typescript
const inserter = session.inserter;

inserter
  .top()        // 光标移到顶部
  .insertAssistantAfter("注入内容")  // 在光标后插入
  .execute();                       // 事务提交

// 按标签定位
inserter
  .moveByTags(["context"])
  .insertUserBefore("补充信息")
  .execute();
```

#### Query — 查询系统

```typescript
const query = session.query;

query.findByContent(["天气"], { scope: "branch" });
query.findByTags(["important"], { scope: "tree" });
query.findByRole(Role.User);
query.findFirst({ content: ["关键词"] });
```

### 🔧 Tool — 工具系统

Builder 模式定义工具，完整的生命周期钩子。

```typescript
const weatherTool = Tool.create(async (args) => {
    const city = args.city as string;
    return await fetchWeather(city);
  })
  .name("get_weather")
  .description("获取指定城市的天气")
  .params(Param.string("city").desc("城市名称").required(),
    Param.string("unit").desc("温度单位").enum(["celsius", "fahrenheit"]),
  )
  // 生命周期钩子
  .on(Hook.BEFORE_EXECUTE, (ctx) => {
    console.log(`即将查询: ${ctx.arguments.city}`);
    // ctx.cancel("理由")可取消执行
  })
  .on(Hook.AFTER_EXECUTE, (ctx) => {
    // 可改写结果
    ctx.result = { ...ctx.result, cached: true };
  })
  .on(Hook.ON_ERROR, (ctx) => {
    // 错误降级
    ctx.result = "天气服务暂不可用";
  })
  .on(Hook.ON_SERIALIZE, (ctx) => {
    // 自定义返回给LLM 的内容
  })
  .build();
```

####生命周期

```
ON_CREATE → ON_VALIDATE → BEFORE_EXECUTE → execute → AFTER_EXECUTE → ON_SERIALIZE↓
                                           ON_ERROR
```

####ToolKit — 工具包管理

```typescript
const toolkit = new ToolKit()
  .add(weatherTool, searchTool);

// MCP 一行接入
await toolkit.addMCP(mcpClient);

// 传给 LLM
const tools = toolkit.schemas;

// 执行
const result = await toolkit.execute(toolCallPart);
const results = await toolkit.executeAll(toolCallParts);
```

#### MCP 集成

```typescript
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "npx",
  args: ["-y", "@modelcontextprotocol/server-filesystem", "./"],
});

const mcpClient = new Client({ name: "my-app", version: "1.0.0" });
await mcpClient.connect(transport);

const toolkit = new ToolKit();
await toolkit.addMCP(mcpClient); // 自动发现所有工具，与手动工具完全同构
```

### 🌊 Stream — 流式解析器

无状态纯函数设计，将 OpenAI 流式 chunk 解析为结构化事件。

```typescript
const parser = new StreamParser();

for await (const chunk of stream) {
  const events = parser.feed(chunk);
  for (const event of events) {
    switch (event.type) {
      case StreamEventType.THINKING_DELTA:
        process.stdout.write(event.delta);  // 思考过程
        break;
      case StreamEventType.TEXT_DELTA:
        process.stdout.write(event.delta);  // 文本增量
        break;
      case StreamEventType.TOOL_CALL_START:
        console.log(`工具: ${event.name}`);
        break;
    }
  }
}

const finalEvents = parser.finish(); // TEXT_DONE, THINKING_DONE, MESSAGE_DONE
```

#### 事件类型

| 事件 | 说明 |
|------|------|
| `THINKING_DELTA` | 思考/推理增量 |
| `THINKING_DONE` | 思考完成 |
| `TEXT_DELTA` | 文本增量 |
| `TEXT_DONE` | 文本完成 |
| `TOOL_CALL_START` | 工具调用开始 |
| `TOOL_CALL_DELTA` | 工具参数增量 |
| `TOOL_CALL_DONE` | 工具调用完成 |
| `TOOL_EXECUTE_START` | 工具执行开始 |
| `TOOL_EXECUTE_DONE` | 工具执行完成 |
| `MESSAGE_DONE` | 消息组装完成 |
| `TURN_START` | 新一轮循环开始 |
| `TURN_END` | 一轮循环结束 |
| `ERROR` | 错误 |

### 📝 PromptBuilder — 提示词构建器

声明式注入规则，在不修改原始 Session 的情况下向上下文注入临时消息。

```typescript
const builder = new PromptBuilder();

// 注入时间感知（永久）
builder.injectSystem(Rule.top().after(), "当前时间：2025年7月16日");

// 注入临时约束（只生效3轮）
builder.injectSystem(
  Rule.byRole(Role.User).last().before(),
  "请用英文回复",
  3// life = 3
);

// 概率触发（50%概率注入）
builder.injectSystem(
  Rule.bottom().before(),
  "添加一个有趣的彩蛋",
  { life: -1, probability: 0.5 }
);

// 构建最终上下文
const context = builder.build(session.history());
// 原始 session 不受影响
```

#### Rule — 声明式定位规则

```typescript
// 位置定位
Rule.top().after()// 第一条之后
Rule.bottom().before()          // 最后一条之前
Rule.index(2).after()           // 第3条之后
Rule.index(-1).before()         // 倒数第1条之前

// 角色定位
Rule.byRole(Role.User).last().before()     // 最后一条 User 之前
Rule.byRole(Role.User).first().after()     // 第一条 User 之后
Rule.byRole(Role.User).all().before()      // 每条 User 之前

// 内容/标签定位
Rule.byContent(["天气"]).after()
Rule.byTags(["context"]).before()
Rule.by((msg, idx) => msg.hasTag("inject-point")).after()

// 扫描深度 + 方向
Rule.byContent(["关键词"]).scanDepth(5).scanReverse().after()   // 只扫描最近5条
Rule.byContent(["关键词"]).scanDepth(10).scanForward().after()  // 只扫描前10条

// 排序（同位置多条注入）
Rule.top().after().order(1)   // 排在前面
Rule.top().after().order(2)   // 排在后面

// 偏移
Rule.byRole(Role.System).first().offset(1).after()
```

#### 生命周期 & 概率

```typescript
// life = -1  → 永久
// life = N   → 剩余N次，每次build后递减
// life = 0   → 已过期，跳过

const inj = builder.inject(rule, message, { life: 5, probability: 0.8 });

inj.enabled;      // 手动开关
inj.life;          // 剩余次数
inj.isActive;      // 存活且启用
inj.probability;   // 触发概率

builder.disable(inj);   // 暂停（不消耗life）
builder.enable(inj);    // 恢复
builder.prune();         // 清理过期注入
```

### ⚙️ RequestConfig — 请求参数配置器

```typescript
// 预设模式
const config = RequestConfig.precise();    // 低温度、低随机
const config = RequestConfig.balanced();   // 适中
const config = RequestConfig.creative();   // 高温度、高创意

// 链式配置
const config = RequestConfig.create()
  .temperature(0.8)
  .topP(0.95)
  .topK(40)
  .maxTokens(2048)
  .frequencyPenalty(0.1)
  .presencePenalty(0.2)
  .stop("n", "END")
  .seed(42)
  .responseFormat("json_object")
  .set("custom_key", value);  // 自定义参数

// 操作
const cloned = config.clone();
const merged = base.merge(override);   // override 优先
const params = config.build();          // → Record<string, unknown>
```

#### 参数优先级

```
RequestConfig（最低） → requestOptions → run()的 options（最高）
```

### 🤖 Agent — 智能体

串联所有组件，实现完整的 Agent 循环。

```typescript
const agent = new Agent({
  client,// OpenAI 兼容客户端
  model: "gpt-4o",               // 模型名
  session: Session.create("..."), // 会话
  toolkit,                        // 工具包（可选）
  promptBuilder,                  // 提示词构建器（可选）
  config: RequestConfig.balanced(), // 请求配置（可选）
  adapter: new OpenAIAdapter(),   // 适配器（可选，默认OpenAI）
  maxTurns: 10,                   // 最大循环轮次（可选）
});

// 事件监听
agent
  .on(StreamEventType.THINKING_DELTA, (e) => { /* 思考增量 */ })
  .on(StreamEventType.TEXT_DELTA, (e) => { /* 文本增量 */ })
  .on(StreamEventType.TOOL_CALL_START, (e) => { /* 工具调用 */ })
  .on(StreamEventType.TOOL_EXECUTE_DONE, (e) => { /* 工具结果 */ });

// 运行
const reply = await agent.run("你好");
reply.text;       // 回复文本
reply.thinking;   // 思考内容
reply.usage;      // Token 用量
reply.toolCalls;  // 工具调用
```

#### 自动循环

`agent.run()` 自动完成：

```
用户输入 → Session.addUser→PromptBuilder.build (注入)
         → Adapter.serialize (序列化)
         → LLM 流式调用
         → StreamParser 解析
         → 有tool_calls? → ToolKit.execute → 结果回传→ 再次调用 LLM
         → 无 tool_calls → Session.addAssistant → 返回结果
```

---

## 🔌Adapter — 适配器

通过实现 `MessageAdapter` 接口适配不同 API 平台：

```typescript
interface MessageAdapter {
  serialize(messages: Message[]): Promise<SerializedResult>;
  deserialize(raw: unknown): Message;
}
```

内置 `OpenAIAdapter`，支持所有 OpenAI 兼容 API：

| 平台 | 支持 |
|------|:----:|
| OpenAI | ✅ |
| DeepSeek | ✅ |
| 通义千问 (Qwen) | ✅ |
| Kimi (Moonshot) | ✅ |
| GLM (智谱) | ✅ |
| MiniMax | ✅ |
| Claude (兼容模式) | ✅ |
| Gemini (兼容模式) | ✅ |

### 思考内容兼容

自动识别不同模型的思考字段：

| 模型 | 字段名 | 支持 |
|------|--------|:----:|
| DeepSeek Reasoner | `reasoning_content` | ✅ |
| Qwen (思考模式) | `reasoning_content` | ✅ |
| Claude (thinking) | `thinking` | ✅ |

---

## 🎮 Demo

项目包含一个精灵对战Demo，展示 AgentEngine 的实际应用：

```bash
npx tsx demo/server.ts
```

访问 `http://localhost:3000`，特性：

- 🎯 6 种属性精灵，属性克制系统
- 🤖 AI 对手由 Agent驱动，实时展示思考过程和工具调用
- 🎨 SVG 精灵 +碰撞动画
- 📋 在线获取模型列表 + 搜索选择
- 🌐 局域网可分享

---

## 📂 项目结构

```
src/
├── message/
│   ├── Message.ts          # 统一消息模型（树结构）
│   ├── MessagePart.ts      # 消息内容原子单元
│   ├── Role.ts             # 角色枚举
│   └── Usage.ts            # Token 用量统计
├── adapter/
│   ├── MessageAdapter.ts   # 适配器接口
│   └── OpenAIAdapter.ts    # OpenAI 适配器
├── media/
│   ├── MediaResolver.ts    # 媒体解析器接口
│   └── DefaultMediaResolver.ts
├── session/
│   ├── Session.ts          # 会话管理器
│   ├── Inserter.ts         # 命令式插入器
│   ├── Query.ts            # 查询系统
│   ├── Paginator.ts        # 分支分页器
│   ├── SearchCriteria.ts   # 搜索条件
│   └── matchUtils.ts       # 匹配工具函数
├── tool/
│   ├── Tool.ts             # 工具定义（Builder）
│   ├── ToolCall.ts         # 工具调用实例
│   ├── ToolKit.ts          # 工具包管理器
│   ├── McpToolAdapter.ts   # MCP 适配器
│   ├── Param.ts            # 参数定义
│   ├── Hook.ts             # 生命周期钩子
│   ├── Context.ts          # 钩子上下文
│   └── ValueType.ts        # JSON Schema 类型
├── stream/
│   ├── StreamEvent.ts      # 流式事件定义
│   └── StreamParser.ts     # 流式解析器
├── prompt/
│   ├── Rule.ts             # 声明式定位规则
│   ├── Injection.ts        # 注入实例
│   └── PromptBuilder.ts    # 提示词构建器
├── config/
│   └── RequestConfig.ts    # 请求参数配置器
├── agent/
│   └── Agent.ts            # 智能体
└── index.ts                # 统一导出

demo/
├── server.ts               # Demo 服务器
├── game.ts                 # 精灵对战引擎
└── index.html              # 前端页面

test/
├── agent_test.ts           # Agent 测试
├── session_test.ts         # Session 测试
├── prompt_test.ts          # PromptBuilder 测试
├── config_test.ts          # RequestConfig 测试
├── mcp_test.ts             # MCP 集成测试
├── multimodal_test.ts      # 多模态测试
├── full_test.ts            # 全模型交互测试
└── ...
```

---

## 🛠️ 开发

```bash
# 编译
npm run build

# 类型检查
npx tsc --noEmit

# 运行测试
npx tsx test/prompt_test.ts
npx tsx test/config_test.ts
npx tsx test/agent_test.ts

# 启动 Demo
npx tsx demo/server.ts
```

---

##📄 License

Private —暂不公开。
