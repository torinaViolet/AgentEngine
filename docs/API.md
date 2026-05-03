# AgentEngine API 文档

> 版本：1.0.0

---

## 目录

- [Message — 统一消息模型](#message--统一消息模型)
  - [Message 类](#message-类)
  - [Role 枚举](#role-枚举)
  - [MessagePart 类型](#messagepart-类型)
  - [Usage 类](#usage-类)
- [Session — 会话管理](#session--会话管理)
  - [Session 类](#session-类)
  - [Inserter 类](#inserter-类)
  - [Query 类](#query-类)
  - [Paginator 类](#paginator-类)
  - [SearchCriteria 接口](#searchcriteria-接口)
- [Tool — 工具系统](#tool--工具系统)
  - [Tool 类](#tool-类)
  - [Param 类](#param-类)
  - [ToolCall 类](#toolcall-类)
  - [ToolKit 类](#toolkit-类)
  - [Hook 枚举](#hook-枚举)
  - [Context 类](#context-类)
  - [ValueType 枚举](#valuetype-枚举)
  - [McpToolAdapter 类](#mcptooladapter-类)
- [Stream — 流式解析](#stream--流式解析)
  - [StreamParser 类](#streamparser-类)
  - [StreamEventType 枚举](#streameventtype-枚举)
  - [事件数据结构](#事件数据结构)
- [Prompt — 提示词构建](#prompt--提示词构建)
  - [PromptBuilder 类](#promptbuilder-类)
  - [Rule 类](#rule-类)
  - [Injection 类](#injection-类)
- [Config — 请求参数配置](#config--请求参数配置)
  - [RequestConfig 类](#requestconfig-类)
- [Adapter — 消息适配器](#adapter--消息适配器)
  - [MessageAdapter 接口](#messageadapter-接口)
  - [OpenAIAdapter 类](#openai-adapter-类)
  - [AnthropicAdapter 类](#anthropicadapter-类)
  - [GeminiAdapter 类](#geminiadapter-类)
  - [思考内容序列化](#思考内容序列化)
- [Agent — 智能体](#agent--智能体)
  - [Agent 类](#agent-类)
  - [AgentOptions 接口](#agentoptions-接口)
  - [AgentRunOptions 接口](#agentrunoptions-接口)
  - [工具审批](#工具审批)
  - [中断与恢复](#中断与恢复)
  - [运行状态](#运行状态)
- [Media — 媒体解析](#media--媒体解析)
  - [MediaResolver 接口](#mediaresolver-接口)
  - [DefaultMediaResolver 类](#defaultmediaresolver-类)
- [Utils — 工具函数](#utils--工具函数)

---

## Message — 统一消息模型

### Message 类

树结构消息模型，支持多模态内容，天然支持对话分支。

#### 静态工厂方法

| 方法                   | 签名                                                             | 说明                     |
| -------------------- | -------------------------------------------------------------- | ---------------------- |
| `user`               | `(content: string \| MessagePart \| MessagePart[]) => Message` | 创建 User 消息             |
| `assistant`          | `(content: string \| MessagePart \| MessagePart[]) => Message` | 创建 Assistant 消息        |
| `system`             | `(content: string) => Message`                                 | 创建 System 消息           |
| `emptySystem`        | `() => Message`                                                | 创建空 System 消息（用作树的根节点） |
| `tool`               | `(toolCallId: string, result: string) => Message`              | 创建 Tool Result 消息      |
| `assistantToolCalls` | `(toolCalls: {id, name, arguments}[]) => Message`              | 创建工具调用消息               |
| `fromJSON`           | `(data: Record<string, unknown>) => Message`                   | 从 JSON 反序列化（含子树）       |

#### 链式构建方法

| 方法         | 签名                                                        | 说明     |
| ---------- | --------------------------------------------------------- | ------ |
| `addText`  | `(text: string) => this`                                  | 追加文本内容 |
| `addImage` | `(url: string, mimeType?: string) => this`                | 追加图片   |
| `addAudio` | `(url: string, mimeType?: string) => this`                | 追加音频   |
| `addFile`  | `(url: string, options?: {mimeType?, fileName?}) => this` | 追加文件   |
| `setMeta`  | `(key: string, value: unknown) => this`                   | 设置元数据  |

#### 标签系统

| 方法       | 签名                                | 说明   |
| -------- | --------------------------------- | ---- |
| `tag`    | `(...tagNames: string[]) => this` | 添加标签 |
| `untag`  | `(...tagNames: string[]) => this` | 移除标签 |
| `hasTag` | `(tagName: string) => boolean`    | 检查标签 |

#### 树结构操作

| 方法/属性        | 签名                                     | 说明             |
| ------------ | -------------------------------------- | -------------- |
| `append`     | `(child: Message) => Message`          | 追加子节点，返回 child |
| `remove`     | `(mode: "prune" \| "graft") => void`   | 删除节点（剪枝/嫁接）    |
| `getHistory` | `(includeRoot?: boolean) => Message[]` | 从根到当前的路径       |
| `parent`     | `Message \| undefined`                 | 父节点            |
| `children`   | `Message[]`                            | 子节点列表          |
| `root`       | `Message`                              | 溯源到根节点         |
| `depth`      | `number`                               | 在树中的深度         |
| `isRoot`     | `boolean`                              | 是否根节点          |
| `isLeaf`     | `boolean`                              | 是否叶子节点         |
| `lastChild`  | `Message \| undefined`                 | 最后一个子节点        |

#### 便捷 Getter

| 属性            | 类型               | 说明                                   |
| ------------- | ---------------- | ------------------------------------ |
| `text`        | `string`         | 文本内容（拼接所有 TextPart + ToolResultPart） |
| `thinking`    | `string`         | 思考/推理内容                              |
| `toolCalls`   | `ToolCallPart[]` | 工具调用列表                               |
| `hasMedia`    | `boolean`        | 是否含媒体内容                              |
| `hasThinking` | `boolean`        | 是否含思考内容                              |

#### 实例属性

| 属性         | 类型                        | 说明        |
| ---------- | ------------------------- | --------- |
| `role`     | `Role`                    | 消息角色（只读）  |
| `parts`    | `MessagePart[]`           | 内容部件列表    |
| `metadata` | `Record<string, unknown>` | 自定义元数据    |
| `model`    | `string \| undefined`     | 生成该消息的模型名 |
| `usage`    | `Usage \| undefined`      | Token 用量  |
| `tags`     | `Set<string>`             | 标签集合      |

#### 序列化

| 方法       | 签名                              | 说明             |
| -------- | ------------------------------- | -------------- |
| `toJSON` | `() => Record<string, unknown>` | 序列化为 JSON（含子树） |

---

### Role 枚举

```typescript
enum Role {
  System = "system",
  User = "user",
  Assistant = "assistant",
  Tool = "tool",
}
```

---

### MessagePart 类型

```typescript
// 联合类型
type MessagePart = TextPart | ImagePart | AudioPart | FilePart
                 | ToolCallPart | ToolResultPart | ThinkingPart;
```

| 类型               | 字段                                                                           | 说明                        |
| ---------------- | ---------------------------------------------------------------------------- | ------------------------- |
| `TextPart`       | `{ type: "text", text: string }`                                             | 文本内容                      |
| `ImagePart`      | `{ type: "image", url: string, mimeType?: string }`                          | 图片（URL / data URI / 本地路径） |
| `AudioPart`      | `{ type: "audio", url: string, mimeType?: string }`                          | 音频                        |
| `FilePart`       | `{ type: "file", url: string, mimeType?: string, fileName?: string }`        | 文件附件                      |
| `ToolCallPart`   | `{ type: "tool_call", toolCallId: string, name: string, arguments: string }` | LLM 发起的工具调用               |
| `ToolResultPart` | `{ type: "tool_result", toolCallId: string, result: string }`                | 工具执行结果                    |
| `ThinkingPart`   | `{ type: "thinking", text: string }`                                         | 模型推理/思考过程                 |

---

### Usage 类

Token 用量统计。

#### 构造函数

```typescript
new Usage(promptTokens?: number, completionTokens?: number, totalTokens?: number)
```

#### 属性

| 属性                 | 类型       | 说明         |
| ------------------ | -------- | ---------- |
| `promptTokens`     | `number` | 输入 Token 数 |
| `completionTokens` | `number` | 输出 Token 数 |
| `totalTokens`      | `number` | 总 Token 数  |

#### 方法

| 方法         | 签名                              | 说明       |
| ---------- | ------------------------------- | -------- |
| `add`      | `(other: Usage) => Usage`       | 累加，返回新实例 |
| `toJSON`   | `() => Record<string, unknown>` | 序列化      |
| `toString` | `() => string`                  | 格式化输出    |

#### 静态方法

| 方法         | 签名                                         | 说明                  |
| ---------- | ------------------------------------------ | ------------------- |
| `zero`     | `() => Usage`                              | 零值                  |
| `fromRaw`  | `(raw: unknown) => Usage`                  | 从 OpenAI API 原始响应解析 |
| `fromJSON` | `(data: Record<string, unknown>) => Usage` | 从 JSON 反序列化         |

---

## Session — 会话管理

### Session 类

基于树结构的会话管理器，通过光标（cursor）追踪当前对话位置。

#### 静态方法

| 方法         | 签名                                           | 说明          |
| ---------- | -------------------------------------------- | ----------- |
| `create`   | `(systemPrompt?: string) => Session`         | 创建新会话       |
| `fromJSON` | `(data: Record<string, unknown>) => Session` | 从 JSON 反序列化 |

#### 对话操作

| 方法             | 签名                                                             | 说明              |
| -------------- | -------------------------------------------------------------- | --------------- |
| `addUser`      | `(content: string \| MessagePart \| MessagePart[]) => Message` | 追加 User 消息      |
| `addAssistant` | `(message: Message) => Message`                                | 追加 Assistant 消息 |
| `addMessage`   | `(message: Message) => Message`                                | 追加任意角色消息        |
| `addTool`      | `(messages: Message[]) => void`                                | 追加 Tool 结果消息    |

#### 历史与分支

| 方法/属性       | 签名                                     | 说明                  |
| ----------- | -------------------------------------- | ------------------- |
| `history`   | `(includeRoot?: boolean) => Message[]` | root → cursor 的完整路径 |
| `messages`  | `Message[]`                            | 同 `history(true)`   |
| `rewind`    | `(toMessage: Message) => void`         | 回退 cursor 到指定消息     |
| `allLeaves` | `Message[]`                            | 所有叶子节点              |
| `branches`  | `Message[][]`                          | 所有分支路径              |

#### 子系统

| 属性           | 类型            | 说明         |
| ------------ | ------------- | ---------- |
| `inserter`   | `Inserter`    | 获取命令式插入器   |
| `query`      | `Query`       | 获取查询器      |
| `paginators` | `Paginator[]` | 当前路径上所有分页器 |

#### 其他

| 方法/属性          | 签名                                       | 说明              |
| -------------- | ---------------------------------------- | --------------- |
| `cursor`       | `Message`                                | 当前光标位置          |
| `root`         | `Message`                                | 永恒根节点           |
| `systemPrompt` | `string` (get/set)                       | 系统提示词           |
| `totalUsage`   | `Usage`                                  | 全树累计 Usage（带缓存） |
| `paginator`    | `(parent: Message) => Paginator \| null` | 指定节点的分页器        |
| `clear`        | `() => void`                             | 清空对话            |
| `toJSON`       | `() => Record<string, unknown>`          | 序列化             |
| `id`           | `string`                                 | 会话唯一 ID         |
| `title`        | `string \| undefined`                    | 会话标题            |
| `createdAt`    | `Date`                                   | 创建时间            |

---

### Inserter 类

游标式插入器，通过移动光标定位插入点，支持事务提交。

> 从 `session.inserter` 获取，执行后自动报废。

#### 光标移动

| 方法              | 签名                             | 说明       |
| --------------- | ------------------------------ | -------- |
| `top`           | `() => this`                   | 移到顶部     |
| `bottom`        | `() => this`                   | 移到底部     |
| `move`          | `(offset: number) => this`     | 偏移移动     |
| `moveTo`        | `(message: Message) => this`   | 移到指定消息   |
| `moveByContent` | `(keywords, options?) => this` | 按内容查找并移动 |
| `moveByTags`    | `(tags, options?) => this`     | 按标签查找并移动 |

#### 插入操作

| 方法                      | 签名                             | 说明                 |
| ----------------------- | ------------------------------ | ------------------ |
| `insertAfter`           | `(message: Message) => this`   | 光标后插入              |
| `insertBefore`          | `(message: Message) => this`   | 光标前插入（嫁接式）         |
| `insertUserAfter`       | `(content) => this`            | 便捷：插入 User 消息      |
| `insertUserBefore`      | `(content) => this`            | 便捷：插入 User 消息      |
| `insertAssistantAfter`  | `(content) => this`            | 便捷：插入 Assistant 消息 |
| `insertAssistantBefore` | `(content) => this`            | 便捷：插入 Assistant 消息 |
| `insertToolAfter`       | `(toolCallId, result) => this` | 便捷：插入 Tool 消息      |
| `insertToolBefore`      | `(toolCallId, result) => this` | 便捷：插入 Tool 消息      |

#### 执行与状态

| 方法/属性          | 签名                           | 说明             |
| -------------- | ---------------------------- | -------------- |
| `execute`      | `() => Message \| undefined` | 事务提交，返回最后插入的消息 |
| `current`      | `Message`                    | 当前光标指向的消息      |
| `position`     | `number`                     | 光标索引           |
| `length`       | `number`                     | 分支长度           |
| `isExpired`    | `boolean`                    | 是否已执行          |
| `pendingCount` | `number`                     | 待执行命令数         |

---

### Query 类

在当前分支或全树中查询消息。

> 从 `session.query` 获取。

| 方法              | 签名                                           | 说明       |
| --------------- | -------------------------------------------- | -------- |
| `branch`        | `(criteria: SearchCriteria) => Message[]`    | 在当前分支中查找 |
| `tree`          | `(criteria: SearchCriteria) => Message[]`    | 在全树中查找   |
| `findByContent` | `(keywords, options?) => Message[]`          | 按内容查找    |
| `findByTags`    | `(tags, options?) => Message[]`              | 按标签查找    |
| `findByRole`    | `(role, scope?) => Message[]`                | 按角色查找    |
| `findBy`        | `(predicate, scope?) => Message[]`           | 自定义规则查找  |
| `findFirst`     | `(criteria, scope?) => Message \| undefined` | 第一个匹配    |
| `findLast`      | `(criteria, scope?) => Message \| undefined` | 最后一个匹配   |

---

### Paginator 类

在兄弟节点（分支）之间导航。

> 从 `session.paginators` 或 `session.paginator(parent)` 获取。

| 方法/属性          | 签名                        | 说明               |
| -------------- | ------------------------- | ---------------- |
| `next`         | `() => this`              | 下一页              |
| `prev`         | `() => this`              | 上一页              |
| `first`        | `() => this`              | 第一页              |
| `last`         | `() => this`              | 最后一页             |
| `goTo`         | `(index: number) => this` | 跳转到指定页码（0-based） |
| `pages`        | `Message[]`               | 所有页              |
| `total`        | `number`                  | 总页数              |
| `currentIndex` | `number`                  | 当前页码             |
| `current`      | `Message`                 | 当前页节点            |
| `hasNext`      | `boolean`                 | 是否有下一页           |
| `hasPrev`      | `boolean`                 | 是否有上一页           |
| `parent`       | `Message`                 | 父节点              |

---

### SearchCriteria 接口

```typescript
interface SearchCriteria {
  content?: (string | RegExp)[];    // 内容关键词/正则
  tags?: (string | RegExp)[];       // 标签匹配
  roles?: Role[];                   // 角色过滤
  mode?: MatchMode;                 // 匹配模式
  priority?: Priority;              // 选择优先级
}
```

#### MatchMode 枚举

| 值     | 说明            |
| ----- | ------------- |
| `AND` | 所有条件都必须匹配（默认） |
| `OR`  | 任一条件匹配即可      |
| `NOT` | 排除匹配的消息       |

#### Priority 枚举

| 值            | 说明         |
| ------------ | ---------- |
| `NEWEST`     | 取最新的匹配（默认） |
| `OLDEST`     | 取最早的匹配     |
| `BEST_MATCH` | 取匹配分最高的    |

---

## Tool — 工具系统

### Tool 类

Builder 模式定义工具。`build()` 前为构建阶段，`build()` 后为冻结状态。

#### 静态方法

| 方法        | 签名                                        | 说明                     |
| --------- | ----------------------------------------- | ---------------------- |
| `create`  | `(fn: ToolFunction) => Tool`              | 创建工具 Builder           |
| `fromRaw` | `(name, description, schema, fn) => Tool` | 从已有 schema 直接创建（MCP 等） |

#### 链式配置（build 前）

| 方法            | 签名                                           | 说明                  |
| ------------- | -------------------------------------------- | ------------------- |
| `name`        | `(n: string) => this`                        | 设置工具名               |
| `description` | `(desc: string) => this`                     | 设置描述                |
| `params`      | `(...params: Param[]) => this`               | 添加参数定义              |
| `on`          | `(hook: Hook, handler: HookHandler) => this` | 注册生命周期钩子            |
| `build`       | `() => this`                                 | 冻结配置，生成 JSON Schema |

#### 运行时（build 后）

| 方法/属性      | 签名                                        | 说明                           |
| ---------- | ----------------------------------------- | ---------------------------- |
| `schema`   | `ToolSchema`                              | OpenAI tools 格式的 JSON Schema |
| `toolName` | `string`                                  | 工具名                          |
| `func`     | `ToolFunction`                            | 执行函数                         |
| `create`   | `(toolCallId, args, signal?) => ToolCall` | 创建调用实例                       |
| `fire`     | `(hook, ctx) => Context`                  | 触发钩子链                        |

#### ToolFunction 签名

```typescript
type ToolFunction = (
  args: Record<string, unknown>,
  ctx: Context
) => unknown | Promise<unknown>;
```

#### HookHandler 签名

```typescript
type HookHandler = (ctx: Context) => void | Context;
```

---

### Param 类

参数定义，链式工厂模式。

#### 静态工厂

| 方法        | 签名                                                     | 说明         |
| --------- | ------------------------------------------------------ | ---------- |
| `string`  | `(name: string) => Param`                              | 字符串参数      |
| `integer` | `(name: string) => Param`                              | 整数参数       |
| `number`  | `(name: string) => Param`                              | 数字参数       |
| `boolean` | `(name: string) => Param`                              | 布尔参数       |
| `array`   | `(name: string, items: ValueType \| Param[]) => Param` | 数组参数       |
| `object`  | `(name: string, properties: Param[]) => Param`         | 对象参数（支持嵌套） |

#### 链式配置

| 方法         | 签名                              | 说明    |
| ---------- | ------------------------------- | ----- |
| `desc`     | `(description: string) => this` | 设置描述  |
| `required` | `() => this`                    | 标记为必填 |
| `enum`     | `(values: unknown[]) => this`   | 设置枚举值 |

#### 查询与序列化

| 方法/属性         | 签名                              | 说明                |
| ------------- | ------------------------------- | ----------------- |
| `isRequired`  | `boolean`                       | 是否必填              |
| `description` | `string`                        | 描述                |
| `name`        | `string`                        | 参数名               |
| `type`        | `ValueType`                     | 参数类型              |
| `toSchema`    | `() => Record<string, unknown>` | 生成 JSON Schema 片段 |

#### 对象和数组示例

```typescript
// 简单数组
Param.array("tags", ValueType.String)

// 对象数组
Param.array("items", [
  Param.string("name").desc("名称").required(),
  Param.number("count").desc("数量"),
])

// 嵌套对象
Param.object("address", [
  Param.string("city").desc("城市").required(),
  Param.object("geo", [
    Param.number("lat").desc("纬度").required(),
    Param.number("lng").desc("经度").required(),
  ]),
])
```

---

### ToolCall 类

一次具体的工具调用实例。由 `Tool.create()` 产生。

| 方法/属性        | 签名                        | 说明                |
| ------------ | ------------------------- | ----------------- |
| `execute`    | `() => Promise<unknown>`  | 执行（完整生命周期）        |
| `toMessage`  | `() => Message`           | 序列化为 Tool Message |
| `id`         | `string`                  | tool_call_id      |
| `name`       | `string`                  | 工具名               |
| `arguments`  | `Record<string, unknown>` | 调用参数              |
| `result`     | `unknown`                 | 执行结果（执行后可用）       |
| `isExecuted` | `boolean`                 | 是否已执行             |
| `error`      | `Error \| undefined`      | 执行异常              |

---

### ToolKit 类

工具包管理器，统一管理所有工具。

#### 注册工具

| 方法       | 签名                                         | 说明                |
| -------- | ------------------------------------------ | ----------------- |
| `add`    | `(...tools: Tool[]) => this`               | 添加工具（链式）          |
| `addMCP` | `(client: McpClientLike) => Promise<this>` | 从 MCP Client 自动发现 |

#### 查询

| 方法/属性     | 签名                                    | 说明                   |
| --------- | ------------------------------------- | -------------------- |
| `get`     | `(name: string) => Tool \| undefined` | 按名称获取                |
| `has`     | `(name: string) => boolean`           | 检查是否存在               |
| `schemas` | `ToolSchema[]`                        | 所有工具的 schema（传给 LLM） |
| `names`   | `string[]`                            | 所有工具名                |
| `size`    | `number`                              | 工具数量                 |

#### 执行

| 方法           | 签名                                                | 说明       |
| ------------ | ------------------------------------------------- | -------- |
| `execute`    | `(toolCallPart, options?) => Promise<Message>`    | 执行单个工具调用 |
| `executeAll` | `(toolCallParts, options?) => Promise<Message[]>` | 并行执行多个   |

#### ToolExecutionOptions

```typescript
interface ToolExecutionOptions {
  signal?: AbortSignal;
  errorPolicy?: "return_to_model" | "throw";
}
```

#### ToolExecutionError

当 `errorPolicy: "throw"` 时，工具执行失败抛出此错误。

| 属性           | 类型        | 说明           |
| ------------ | --------- | ------------ |
| `toolCallId` | `string`  | tool_call_id |
| `toolName`   | `string`  | 工具名          |
| `cause`      | `unknown` | 原始异常         |

---

### Hook 枚举

工具生命周期钩子。

```typescript
enum Hook {
  ON_CREATE = "on_create",           // Tool.create() 时
  ON_VALIDATE = "on_validate",       // 参数校验时
  BEFORE_EXECUTE = "before_execute", // 执行前（可取消）
  AFTER_EXECUTE = "after_execute",   // 执行后（可改写结果）
  ON_ERROR = "on_error",             // 执行异常（可降级）
  ON_SERIALIZE = "on_serialize",     // 序列化为 Message 时
}
```

#### 生命周期流程

```
ON_CREATE → ON_VALIDATE → BEFORE_EXECUTE → execute → AFTER_EXECUTE → ON_SERIALIZE
                                              ↓
                                          ON_ERROR
```

> **注意**：`ON_CREATE` 和 `ON_VALIDATE` 中的异常也会触发 `ON_ERROR`。整个生命周期共享同一个 `Context` 实例。

---

### Context 类

生命周期上下文，在钩子之间传递。

| 属性             | 类型                         | 说明           |
| -------------- | -------------------------- | ------------ |
| `id`           | `string`                   | tool_call_id |
| `name`         | `string`                   | 工具名          |
| `arguments`    | `Record<string, unknown>`  | 调用参数（可修改）    |
| `result`       | `unknown`                  | 执行结果（可改写）    |
| `error`        | `Error \| undefined`       | 执行异常         |
| `cancelled`    | `boolean`                  | 是否取消执行       |
| `cancelReason` | `string`                   | 取消原因         |
| `signal`       | `AbortSignal \| undefined` | 中断信号         |

| 方法               | 签名                         | 说明       |
| ---------------- | -------------------------- | -------- |
| `cancel`         | `(reason: string) => this` | 取消执行     |
| `throwIfAborted` | `() => void`               | 如果已中断则抛出 |

---

### ValueType 枚举

```typescript
enum ValueType {
  String = "string",
  Integer = "integer",
  Number = "number",
  Boolean = "boolean",
  Array = "array",
  Object = "object",
}
```

---

### McpToolAdapter 类

将 MCP Server 工具转换为内部 Tool 实例。

| 方法            | 签名                                           | 说明                   |
| ------------- | -------------------------------------------- | -------------------- |
| `fromClient`  | `(client: McpClientLike) => Promise<Tool[]>` | 从 MCP Client 自动发现并转换 |
| `convertTool` | `(client, mcpTool) => Tool`                  | 转换单个 MCP 工具          |

#### McpClientLike 接口

```typescript
interface McpClientLike {
  listTools(): Promise<{ tools: Array<{ name, description?, inputSchema }> }>;
  callTool(params: { name, arguments? }): Promise<{ content: Array<{ type, text? }> }>;
}
```

---

## Stream — 流式解析

### StreamParser 类

将 OpenAI 流式 chunk 解析为结构化事件。纯函数设计，不依赖 Session 或 ToolKit。

| 方法       | 签名                              | 说明                |
| -------- | ------------------------------- | ----------------- |
| `feed`   | `(chunk: any) => StreamEvent[]` | 喂入一个 chunk，返回事件列表 |
| `finish` | `() => StreamEvent[]`           | 通知流结束，产出最终事件      |
| `reset`  | `() => void`                    | 重置，可复用于下一轮        |

| 属性                   | 类型                          | 说明                |
| -------------------- | --------------------------- | ----------------- |
| `snapshot`           | `Message`                   | 当前已组装的 Message 快照 |
| `finishReason`       | `FinishReason \| undefined` | 模型完成原因            |
| `hasSnapshotContent` | `boolean`                   | 是否已有内容            |

---

### StreamEventType 枚举

| 事件                       | 值                          | 说明      |
| ------------------------ | -------------------------- | ------- |
| `THINKING_DELTA`         | `"thinking_delta"`         | 思考/推理增量 |
| `THINKING_DONE`          | `"thinking_done"`          | 思考完成    |
| `TEXT_DELTA`             | `"text_delta"`             | 文本增量    |
| `TEXT_DONE`              | `"text_done"`              | 文本完成    |
| `TOOL_CALL_START`        | `"tool_call_start"`        | 工具调用开始  |
| `TOOL_CALL_DELTA`        | `"tool_call_delta"`        | 工具参数增量  |
| `TOOL_CALL_DONE`         | `"tool_call_done"`         | 工具调用完成  |
| `TOOL_APPROVAL_REQUIRED` | `"tool_approval_required"` | 工具需要审批  |
| `TOOL_APPROVAL_ACCEPTED` | `"tool_approval_accepted"` | 审批通过    |
| `TOOL_APPROVAL_REJECTED` | `"tool_approval_rejected"` | 审批拒绝    |
| `TOOL_EXECUTE_START`     | `"tool_execute_start"`     | 工具执行开始  |
| `TOOL_EXECUTE_DONE`      | `"tool_execute_done"`      | 工具执行完成  |
| `TOOL_EXECUTE_ERROR`     | `"tool_execute_error"`     | 工具执行失败  |
| `MESSAGE_DONE`           | `"message_done"`           | 消息组装完成  |
| `TURN_START`             | `"turn_start"`             | 新一轮开始   |
| `TURN_END`               | `"turn_end"`               | 一轮结束    |
| `ERROR`                  | `"error"`                  | 错误      |

---

### 事件数据结构

```typescript
// 思考
ThinkingDeltaEvent  { type, delta: string, snapshot: string }
ThinkingDoneEvent   { type, thinking: string }

// 文本
TextDeltaEvent      { type, delta: string, snapshot: string }
TextDoneEvent       { type, text: string }

// 工具调用
ToolCallStartEvent  { type, index: number, toolCallId: string, name: string }
ToolCallDeltaEvent  { type, index: number, argsDelta: string, argsSnapshot: string }
ToolCallDoneEvent   { type, index: number, toolCallId, name, arguments: string }

// 工具审批
ToolApprovalRequiredEvent { type, approvalId, toolCallId, name, arguments, rawArguments, turn }
ToolApprovalAcceptedEvent { type, approvalId, toolCallId, name }
ToolApprovalRejectedEvent { type, approvalId, toolCallId, name, reason? }

// 工具执行
ToolExecuteStartEvent { type, toolCallId, name }
ToolExecuteDoneEvent  { type, toolCallId, name, result: Message }
ToolExecuteErrorEvent { type, toolCallId, name, error: Error, result?: Message }

// 消息
MessageDoneEvent    { type, message: Message, finishReason?: FinishReason }

// 循环
TurnStartEvent      { type, turn: number }
TurnEndEvent        { type, turn: number, hasToolCalls: boolean }

// 错误
ErrorEvent          { type, error: Error }
```

#### FinishReason 类型

```typescript
type FinishReason = "stop" | "length" | "tool_calls" | "content_filter" | "function_call" | string;
```

---

## Prompt — 提示词构建

### PromptBuilder 类

声明式注入规则，在不修改原始 Session 的情况下向上下文注入临时消息。

#### 注入注册

| 方法                | 签名                                            | 说明              |
| ----------------- | --------------------------------------------- | --------------- |
| `inject`          | `(rule, message, options?) => Injection`      | 注入一条消息          |
| `injectSystem`    | `(rule, content, options?) => Injection`      | 注入 System 消息    |
| `injectUser`      | `(rule, content, options?) => Injection`      | 注入 User 消息      |
| `injectAssistant` | `(rule, content, options?) => Injection`      | 注入 Assistant 消息 |
| `injectAll`       | `(rule, messages[], options?) => Injection[]` | 批量注入            |

#### InjectOptions

```typescript
interface InjectOptions {
  life?: number;         // 生命周期，默认 -1（永久）
  probability?: number;  // 触发概率（0~1），默认 1
  priority?: number;     // 执行优先级，默认 0（越小越先执行）
}
```

> `options` 参数也可直接传 `number`，表示 `life` 值。

#### 管理

| 方法                | 签名                               | 说明                  |
| ----------------- | -------------------------------- | ------------------- |
| `remove`          | `(injection: Injection) => this` | 移除注入                |
| `removeById`      | `(id: string) => this`           | 按 ID 移除             |
| `removeByRule`    | `(rule: Rule) => this`           | 按规则移除               |
| `enable`          | `(injection) => this`            | 启用注入                |
| `disable`         | `(injection) => this`            | 禁用注入（不消耗 life）      |
| `prune`           | `() => this`                     | 清理过期注入              |
| `clearInjections` | `() => this`                     | 清空所有注入              |
| `clear`           | `() => this`                     | 同 `clearInjections` |

#### 数组操作管线

| 方法                | 签名                                      | 说明      |
| ----------------- | --------------------------------------- | ------- |
| `use`             | `(op: Operation, label?) => this`       | 注册数组操作  |
| `insertAt`        | `(index, message, label?) => this`      | 指定位置插入  |
| `removeAt`        | `(index, count?, label?) => this`       | 指定位置移除  |
| `removeWhere`     | `(predicate, label?) => this`           | 按条件移除   |
| `replaceWhere`    | `(predicate, replacer, label?) => this` | 按条件替换   |
| `filter`          | `(predicate, label?) => this`           | 过滤      |
| `slice`           | `(start, end?, label?) => this`         | 截取      |
| `map`             | `(fn, label?) => this`                  | 映射变换    |
| `transform`       | `(fn, label?) => this`                  | 自由变换    |
| `removeOperation` | `(label: string) => this`               | 按标签移除操作 |
| `clearOperations` | `() => this`                            | 清空所有操作  |

```typescript
type Operation = (messages: Message[]) => Message[];
```

#### 构建

| 方法               | 签名                                 | 说明       |
| ---------------- | ---------------------------------- | -------- |
| `build`          | `(history, options?) => Message[]` | 构建最终上下文  |
| `buildBatch`     | `(history) => Message[]`           | 批量构建（默认） |
| `buildImmediate` | `(history) => Message[]`           | 即时构建     |

```typescript
interface BuildOptions {
  strategy?: "batch" | "immediate";
}
```

- **batch**（默认）：所有 Injection 基于原始 history 定位
- **immediate**：后续 Injection 可看到前序 Injection 的插入结果

#### 查询

| 属性/方法          | 签名                               | 说明      |
| -------------- | -------------------------------- | ------- |
| `injections`   | `readonly Injection[]`           | 所有注入    |
| `operations`   | `readonly {op, label?}[]`        | 所有操作    |
| `aliveCount`   | `number`                         | 存活注入数   |
| `expiredCount` | `number`                         | 过期注入数   |
| `activeCount`  | `number`                         | 活跃注入数   |
| `findByRule`   | `(rule) => Injection[]`          | 按规则查找   |
| `findById`     | `(id) => Injection \| undefined` | 按 ID 查找 |

---

### Rule 类

声明式定位规则。无状态、可复用。

#### 静态工厂

| 方法          | 签名                                      | 说明           |
| ----------- | --------------------------------------- | ------------ |
| `top`       | `() => Rule`                            | 定位到第一条消息     |
| `bottom`    | `() => Rule`                            | 定位到最后一条消息    |
| `index`     | `(n: number) => Rule`                   | 按索引定位（支持负索引） |
| `byRole`    | `(role, options?) => Rule`              | 按角色定位        |
| `byContent` | `(keywords, options?) => Rule`          | 按内容关键词/正则定位  |
| `byTags`    | `(tags, options?) => Rule`              | 按标签定位        |
| `by`        | `(fn: (msg, index) => boolean) => Rule` | 自定义谓词        |

#### 选择策略

| 方法      | 签名           | 说明          |
| ------- | ------------ | ----------- |
| `first` | `() => this` | 取第一个匹配      |
| `last`  | `() => this` | 取最后一个匹配（默认） |
| `all`   | `() => this` | 所有匹配点都插入    |

#### 插入方向

| 方法       | 签名           | 说明          |
| -------- | ------------ | ----------- |
| `before` | `() => this` | 在锚点之前插入     |
| `after`  | `() => this` | 在锚点之后插入（默认） |

#### 配置

| 方法            | 签名                    | 说明          |
| ------------- | --------------------- | ----------- |
| `offset`      | `(n: number) => this` | 在定位结果上偏移    |
| `order`       | `(n: number) => this` | 同位置排序（小的在前） |
| `scanDepth`   | `(n: number) => this` | 限制扫描条数      |
| `scanForward` | `() => this`          | 从顶部开始扫描     |
| `scanReverse` | `() => this`          | 从底部开始扫描（默认） |

#### 解析

| 方法        | 签名                                  | 说明        |
| --------- | ----------------------------------- | --------- |
| `resolve` | `(messages: Message[]) => number[]` | 解析出所有插入索引 |

---

### Injection 类

Rule + Message + 生命周期的绑定。

| 属性/方法         | 类型/签名                 | 说明               |
| ------------- | --------------------- | ---------------- |
| `id`          | `string`              | 唯一标识             |
| `rule`        | `Rule`                | 定位规则             |
| `message`     | `Message`             | 要注入的消息           |
| `enabled`     | `boolean`             | 手动开关             |
| `life`        | `number`              | 剩余生命值            |
| `isAlive`     | `boolean`             | 是否存活（life !== 0） |
| `isActive`    | `boolean`             | 存活且启用            |
| `probability` | `number` (get/set)    | 触发概率（0~1）        |
| `priority`    | `number` (get/set)    | 执行优先级            |
| `setPriority` | `(n: number) => this` | 链式设置优先级          |
| `rollTrigger` | `() => boolean`       | 掷骰子判定            |
| `consume`     | `() => void`          | 消耗一次生命           |

#### 生命周期规则

| life 值  | 行为           |
| ------- | ------------ |
| `-1`    | 永久，不递减       |
| `N > 0` | 每次 build 后递减 |
| `0`     | 已过期，跳过       |

---

## Config — 请求参数配置

### RequestConfig 类

链式构建 LLM 请求参数。

#### 静态工厂

| 方法         | 签名                    | 说明        |
| ---------- | --------------------- | --------- |
| `create`   | `() => RequestConfig` | 创建空配置     |
| `precise`  | `() => RequestConfig` | 精确模式（低温度） |
| `balanced` | `() => RequestConfig` | 平衡模式      |
| `creative` | `() => RequestConfig` | 创意模式（高温度） |

#### 参数设置

| 方法                 | 签名                                 | 范围      | 说明         |
| ------------------ | ---------------------------------- | ------- | ---------- |
| `temperature`      | `(t: number) => this`              | [0, 2]  | 温度         |
| `topP`             | `(p: number) => this`              | [0, 1]  | 核采样        |
| `topK`             | `(k: number) => this`              | ≥ 1     | Top-K      |
| `maxTokens`        | `(n: number) => this`              | ≥ 1     | 最大生成 Token |
| `frequencyPenalty` | `(p: number) => this`              | [-2, 2] | 频率惩罚       |
| `presencePenalty`  | `(p: number) => this`              | [-2, 2] | 存在惩罚       |
| `stop`             | `(...sequences: string[]) => this` | 最多 4 个  | 停止序列       |
| `seed`             | `(s: number) => this`              | 整数      | 随机种子       |
| `responseFormat`   | `(format, schema?) => this`        | —       | 响应格式       |
| `set`              | `(key, value) => this`             | —       | 自定义参数      |
| `unset`            | `(key) => this`                    | —       | 移除参数       |

#### 操作

| 方法      | 签名                                        | 说明                 |
| ------- | ----------------------------------------- | ------------------ |
| `build` | `() => Record<string, unknown>`           | 构建为普通对象            |
| `merge` | `(other: RequestConfig) => RequestConfig` | 合并（other 优先），返回新实例 |
| `clone` | `() => RequestConfig`                     | 克隆                 |

#### 查询

| 方法/属性      | 签名                 | 说明    |
| ---------- | ------------------ | ----- |
| `get`      | `(key) => unknown` | 获取参数值 |
| `has`      | `(key) => boolean` | 是否设置  |
| `size`     | `number`           | 参数数量  |
| `keys`     | `string[]`         | 所有参数键 |
| `toString` | `() => string`     | 格式化输出 |

---

## Adapter — 消息适配器

### MessageAdapter 接口

```typescript
interface MessageAdapter {
  readonly capabilities?: AdapterCapabilities;
  serialize(messages: Message[], options?: SerializeOptions): Promise<SerializedResult>;
  deserialize(raw: unknown): Message;
}
```

```typescript
interface SerializedResult {
  messages: unknown[];
  systemMessage?: string;  // 提取出的 system 消息（Anthropic/Gemini 用）
}

interface AdapterCapabilities {
  nativeThinking?: boolean;    // 是否支持原生 thinking 字段
  messageThinking?: boolean;   // 是否支持降级为普通文本
}
```

---

### OpenAI Adapter 类

支持所有 OpenAI 兼容 API（OpenAI、DeepSeek、Qwen、Kimi、GLM 等）。

| 方法                    | 签名                                                  | 说明                                 |
| --------------------- | --------------------------------------------------- | ---------------------------------- |
| `serialize`           | `(messages, options?) => Promise<SerializedResult>` | Message[] → OpenAI JSON            |
| `deserialize`         | `(raw) => Message`                                  | OpenAI 响应 → Message                |
| `deserializeResponse` | `(raw) => Message`                                  | 完整 API 响应 → Message（含 usage/model） |

**构造函数**：`new OpenAIAdapter(resolver?: MediaResolver)`

---

### AnthropicAdapter 类

适配 Anthropic Claude API。

- System 消息提取到顶层 `system` 字段
- 思考内容使用 `thinking` block
- 工具调用使用 `tool_use` / `tool_result` block
- 自动合并连续同角色消息

**构造函数**：`new AnthropicAdapter(resolver?: MediaResolver)`

---

### GeminiAdapter 类

适配 Google Gemini API。

- System 消息提取到顶层 `system_instruction`
- 角色映射：assistant → model
- 思考内容使用 `thought: true` 标记
- 工具调用使用 `functionCall` / `functionResponse`
- 自动合并连续同角色消息

**构造函数**：`new GeminiAdapter(resolver?: MediaResolver)`

---

### 思考内容序列化

通过 `SerializeOptions.thinking` 控制是否以及如何回传思考内容。

```typescript
interface SerializeOptions {
  thinking?: ThinkingSerializationOptions;
}

interface ThinkingSerializationOptions {
  mode?: "none" | "native" | "message" | "auto";
  scope?: "none" | "last" | "tool_call" | "all";
  include?: (msg, index, messages) => boolean;
  messagePrefix?: string;
}
```

| mode      | 说明                              |
| --------- | ------------------------------- |
| `none`    | 不回传（默认）                         |
| `native`  | 使用平台原生字段（如 `reasoning_content`） |
| `message` | 降级为普通文本前缀                       |
| `auto`    | 优先 native，不支持则 message          |

| scope       | 说明                             |
| ----------- | ------------------------------ |
| `none`      | 不回传任何（默认）                      |
| `last`      | 仅最后一条含 thinking 的 assistant 消息 |
| `tool_call` | 仅含工具调用的 assistant 消息           |
| `all`       | 所有含 thinking 的 assistant 消息    |

---

## Agent — 智能体

### Agent 类

串联所有组件，实现完整的 Agent 循环。

#### 构造函数

```typescript
new Agent(options: AgentOptions)
```

#### 运行

| 方法        | 签名                                           | 说明                     |
| --------- | -------------------------------------------- | ---------------------- |
| `run`     | `(content, options?) => Promise<Message>`    | 添加用户消息并运行              |
| `runWith` | `(message, options?) => Promise<Message>`    | 添加任意消息并运行              |
| `runRaw`  | `(messages[], options?) => Promise<Message>` | 直接传入消息列表运行（不走 Session） |

#### 事件

| 方法                   | 签名                                            | 说明           |
| -------------------- | --------------------------------------------- | ------------ |
| `on`                 | `(event, handler) => this`                    | 注册事件监听（类型安全） |
| `off`                | `(event, handler) => this`                    | 移除事件监听       |
| `once`               | `(event, handler) => this`                    | 一次性监听        |
| `removeAllListeners` | `(event?) => this`                            | 移除所有监听器      |
| `emit`               | `(event: StreamEvent \| CustomEvent) => void` | 发射事件         |

```typescript
// 类型安全的事件监听
agent.on(StreamEventType.TEXT_DELTA, (e) => {
  e.delta;  // 自动推断为 string
});

// 自定义事件
agent.on("my_event", (e) => { ... });
```

#### 配置

| 方法                    | 签名                        | 说明       |
| --------------------- | ------------------------- | -------- |
| `setModel`            | `(model: string) => this` | 设置模型     |
| `setAdapter`          | `(adapter) => this`       | 设置适配器    |
| `setConfig`           | `(config) => this`        | 设置请求配置   |
| `setPromptBuilder`    | `(builder) => this`       | 设置提示词构建器 |
| `setToolKit`          | `(toolkit) => this`       | 设置工具包    |
| `setMaxTurns`         | `(n) => this`             | 设置最大循环轮次 |
| `setRequestOptions`   | `(options) => this`       | 设置额外请求参数 |
| `setToolApproval`     | `(handler) => this`       | 设置工具审批函数 |
| `setToolApprovalMode` | `(mode) => this`          | 设置审批模式   |
| `setToolErrorPolicy`  | `(policy) => this`        | 设置工具错误策略 |

#### 状态查询

| 属性                 | 类型                                 | 说明     |
| ------------------ | ---------------------------------- | ------ |
| `model`            | `string`                           | 当前模型   |
| `session`          | `Session`                          | 当前会话   |
| `toolApproval`     | `ToolApprovalHandler \| undefined` | 审批函数   |
| `toolErrorPolicy`  | `AgentToolErrorPolicy`             | 错误策略   |
| `lastRunState`     | `AgentRunState \| undefined`       | 最近运行状态 |
| `canResume`        | `boolean`                          | 是否可恢复  |
| `canContinue`      | `boolean`                          | 是否可继续  |
| `isRunning`        | `boolean`                          | 是否运行中  |
| `pendingApprovals` | `ToolApprovalRequest[]`            | 待审批请求  |

---

### AgentOptions 接口

```typescript
interface AgentOptions {
  client: OpenAIClientLike;            // OpenAI 兼容客户端
  model: string;                       // 模型名
  session: Session;                    // 会话
  adapter?: MessageAdapter;            // 适配器（默认 OpenAIAdapter）
  toolkit?: ToolKit;                   // 工具包
  config?: RequestConfig;              // 请求配置
  promptBuilder?: PromptBuilder;       // 提示词构建器
  maxTurns?: number;                   // 最大循环轮次（默认 10）
  toolApproval?: ToolApprovalHandler;  // 工具审批函数
  toolApprovalMode?: ToolApprovalMode; // 审批模式
  toolApprovalTimeoutMs?: number;      // manual 审批超时
  toolApprovalTimeoutPolicy?: ToolApprovalTimeoutPolicy;
  toolErrorPolicy?: AgentToolErrorPolicy;
  requestOptions?: Record<string, unknown>; // 额外请求参数
}
```

#### OpenAIClientLike

```typescript
interface OpenAIClientLike {
  chat: {
    completions: {
      create(params: any, options?: any): Promise<any>;
    };
  };
}
```

---

### AgentRunOptions 接口

```typescript
interface AgentRunOptions extends Record<string, unknown> {
  signal?: AbortSignal;                  // 中断信号
  timeoutMs?: number;                    // 超时时间
  promptBuildOptions?: BuildOptions;     // PromptBuilder 构建选项
  serializeOptions?: SerializeOptions;   // Adapter 序列化选项
  // 其余字段作为额外请求参数传递
}
```

#### 参数优先级

```
RequestConfig（最低） → requestOptions → AgentRunOptions（最高）
```

---

### 工具审批

#### ToolApprovalHandler

```typescript
type ToolApprovalHandler = (request: ToolApprovalRequest) => ToolApprovalResult | Promise<ToolApprovalResult>;

interface ToolApprovalRequest {
  approvalId: string;
  toolCallId: string;
  name: string;
  arguments: Record<string, unknown>;
  rawArguments: string;
  turn: number;
}

type ToolApprovalResult = boolean | { approved: boolean; reason?: string };
```

#### 审批模式

| 模式         | 说明                              |
| ---------- | ------------------------------- |
| `"auto"`   | 无审批函数时自动通过                      |
| `"manual"` | 等待外部调用 `approve()` / `reject()` |

#### Manual 模式 API

| 方法        | 签名                                         | 说明  |
| --------- | ------------------------------------------ | --- |
| `approve` | `(approvalId: string) => boolean`          | 批准  |
| `reject`  | `(approvalId: string, reason?) => boolean` | 拒绝  |

#### 超时策略

| 策略         | 说明               |
| ---------- | ---------------- |
| `"reject"` | 超时后拒绝该工具调用（默认）   |
| `"abort"`  | 超时后中断整个 Agent 运行 |

#### 工具错误策略

| 策略                  | 说明             |
| ------------------- | -------------- |
| `"return_to_model"` | 将错误信息返回给模型（默认） |
| `"pause"`           | 暂停运行，保留现场可恢复   |
| `"throw"`           | 直接抛出异常         |

---

### 中断与恢复

| 方法         | 签名                                                           | 说明                                       |
| ---------- | ------------------------------------------------------------ | ---------------------------------------- |
| `abort`    | `(reason?) => boolean`                                       | 中断当前运行                                   |
| `continue` | `(options?: AgentContinueOptions) => Promise<Message>`       | 继续/恢复任务                                  |
| `resume`   | `(options?) => Promise<Message>` | 严格恢复（等同 `continue({ mode: "resume" })` ） |

```typescript
interface AgentContinueOptions extends AgentRunOptions {
  mode?: "auto" | "resume" | "continue";
  prompt?: string;
  thinkingMode?: ThinkingSerializationMode;
}
```

| mode         | 说明                |
| ------------ | ----------------- |
| `"auto"`     | 有中断则恢复，否则普通继续（默认） |
| `"resume"`   | 严格恢复              |
| `"continue"` | 普通继续              |

#### 错误类型

| 类                   | 说明                           |
| ------------------- | ---------------------------- |
| `AgentAbortError`   | 主动中断错误（`name: "AbortError"`） |
| `AgentTimeoutError` | 超时错误（`name: "TimeoutError"`） |

---

### 运行状态

```typescript
interface AgentRunState {
  id: string;
  status: "running" | "completed" | "interrupted" | "failed";
  stopReason?: AgentStopReason;
  error?: Error;
  partialMessage?: Message;
  lastMessage?: Message;
  turn: number;
  canResume: boolean;
  createdAt: Date;
  updatedAt: Date;
}

type AgentStopReason =
  | "final" | "continue" | "abort" | "timeout"
  | "network_error" | "stream_error"
  | "tool_approval_rejected" | "tool_execution_error"
  | "max_tokens" | "max_turns" | "unknown_error";
```

---

## Media — 媒体解析

### MediaResolver 接口

```typescript
interface MediaResolver {
  resolve(url: string): Promise<ResolvedMedia>;
}

interface ResolvedMedia {
  base64: string;
  mimeType: string;
}
```

---

### DefaultMediaResolver 类

内置媒体解析器，支持三种 URL 格式：

| 格式                     | 说明       |
| ---------------------- | -------- |
| `https://` / `http://` | fetch 下载 |
| `data:mime;base64,...` | 直接拆解     |
| 本地路径 / `file:///`      | 读取本地文件   |

**构造函数**：`new DefaultMediaResolver()`

---

## Utils — 工具函数

### generateId

```typescript
function generateId(prefix?: string): string
```

生成格式为 `[prefix-]<timestamp>-<random>` 的唯一标识符。

```typescript
generateId()          // "lx1abc12-r4nd0m00"
generateId("inj")     // "inj-lx1abc12-r4nd0m00"
generateId("run")     // "run-lx1abc12-r4nd0m00"
```

---

## 自动循环流程

`agent.run()` 的完整执行流程：

```
用户输入
  → Session.addUser()
  → PromptBuilder.build()（注入临时消息）
  → Adapter.serialize()（序列化为平台格式）
  → LLM 流式调用
  → StreamParser 解析
  → 有 tool_calls?
      → 工具审批（auto / manual / handler）
      → ToolKit.execute()
      → 结果回传 Session
      → 再次调用 LLM（循环）
  → 无 tool_calls
      → Session.addAssistant()
      → 返回结果
```

最大循环轮次由 `maxTurns` 控制（默认 10），超出后抛出异常。

---

## 平台兼容性

### 适配器支持

| 平台               | 适配器                | 支持  |
| ---------------- | ------------------ |:---:|
| OpenAI           | `OpenAIAdapter`    | ✅   |
| DeepSeek         | `OpenAIAdapter`    | ✅   |
| 通义千问 (Qwen)      | `OpenAIAdapter`    | ✅   |
| Kimi (Moonshot)  | `OpenAIAdapter`    | ✅   |
| GLM (智谱)         | `OpenAIAdapter`    | ✅   |
| MiniMax          | `OpenAIAdapter`    | ✅   |
| Anthropic Claude | `AnthropicAdapter` | ✅   |
| Google Gemini    | `GeminiAdapter`    | ✅   |

### 思考内容兼容

| 模型                | 字段名                 | 支持  |
| ----------------- | ------------------- |:---:|
| DeepSeek Reasoner | `reasoning_content` | ✅   |
| Qwen (思考模式)       | `reasoning_content` | ✅   |
| Claude (thinking) | `thinking` block    | ✅   |
| Gemini (thinking) | `thought: true`     | ✅   |
