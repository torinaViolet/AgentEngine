# AgentEngine 3.0 消息、会话与运行记录契约草案

记录日期：2026-10-08。

依据：[设计讨论记录](./DESIGN-3.0.md)、[CharacterEditor 使用分析](./CHARACTEREDITOR-3.0-NOTES.md)。本文保留讨论阶段的职责、数据关系和操作语义。相关运行时代码已实现，实际字段和接口见 [API](./API.md)；下文草案用于解释设计动机。

当前实施边界和默认选择见 [3.0 设计基线与实施计划](./PLAN-3.0.md)。本文列出的细节问题用于指导实现样例和验证，常规选择由该计划收敛。

## 1. 本轮明确的要求

- Message 脱离节点结构，但保留自身的内容编辑能力。
- Session 提供详细查询，让用户获得具体 Message；便捷编辑接口委托 Message 的编辑方法。
- 模型生成、会话保存、界面显示不保证内容或形状一致，需要明确转换与关联关系。
- TreeSession、ListSession、AgentSession 都保留消息轮次与工具使用轮次信息。
- AgentEngine 要覆盖实际业务需要的通用逻辑；业务通过稳定公开接口接入自己的规则。

以下为实现这些要求的设计草案，未确认的行为在最后单独列出。

## 2. 职责与所有权

| 对象 | 拥有的内容 | 提供的操作 |
| --- | --- | --- |
| Message | 标识、角色、内容块、消息元数据、内容版本 | 内容读取、追加、替换、移除、克隆与消息数据导出 |
| Session | 消息集合、组织结构、选择状态、会话扩展数据、运行关联记录 | 查询、结构编辑、历史投影、生成提交、会话导入导出 |
| TurnRecord | 一次用户交互的身份和输入关联 | 将多个运行和消息归入同一次交互 |
| RunRecord | 一次实际执行及其步骤、停止原因、提交目标 | 表达一次生成、重生成、继续或恢复的执行记录 |
| StepRecord | 一次模型调用及其输出关联、用量和结束原因 | 关联模型请求与输出，并关联这一步发起的工具调用 |
| ToolExecutionRecord | 一次工具调用的参数、审批、执行状态和结果关联 | 记录工具执行事实，关联模型步骤或独立调用来源 |
| PromptBuilder | 上下文构建规则和构建结果的来源信息 | 为请求构建临时上下文，提供预览与扩展入口 |

2026-10-08 后续讨论提出独立的单次生成单元（暂称 Generator），Agent 在其上组合上下文与自主执行循环。Generator 产生一次模型响应；Step 记录该调用，二者不是同一个数据对象。具体入口与名称待确认，见 [设计记录 4.4](./DESIGN-3.0.md#44-一次生成与-agent-自主执行分别建模)。

RunRecord 是可保存的数据；运行时的 Run 控制对象另外持有 AbortController、等待中的 Promise 和执行依赖。这些运行时对象不进入会话 JSON。

Message 不拥有 Session、节点位置、父子关系或当前候选，也不直接执行数据库保存和界面渲染。

## 3. Message：内容编辑由消息本身完成

倾向使用具有编辑方法的 Message class。具体实现形式仍可调整，但外部不需要了解缓存或内容块维护细节。

建议保留和补充少量明确操作：

```ts
message.text;
message.thinking;
message.parts;

message.setText("替换正文");
message.appendText("追加正文");
message.setThinking("替换思考");
message.appendThinking("追加思考");
message.setParts(parts);
message.addPart(part);
message.replacePart(partId, replacement);
message.removePart(partId);
message.setMeta("business.source", value);
```

语义要求：

- 文本编辑保留未涉及的思考、媒体和工具内容块。
- 部分内容块的编辑保留其余块的顺序，不随意重排平台所需的内容顺序。
- 编辑方法统一维护缓存与版本；用户不需要手动 invalidateCache。
- parts 及嵌套内容通过只读视图或快照公开，避免数组和对象的直接写入绕过编辑方法。
- 消息 ID 在内容编辑后保持不变；版本随内容变化更新。
- 普通克隆产生新的消息身份；请求构建可以使用保留来源标识的值快照。两者语义分别定义，避免同 ID 的独立可变对象混淆。
- provider 所需的协议扩展数据有明确归属；内容编辑之后这些数据是否仍有效，需要由协议转换层判断。

内容块是否全部具有稳定 ID、setText 在多个文本块中的具体替换位置、元数据变更如何计入版本，还需要按多模态和平台协议样例确定。

### 3.1 独立编辑与 Session 的变化感知

用户从 Session 查询到的 Message 是该 Session 持有的对象，可以直接调用内容编辑方法。

建议 Message 发出不依赖 Session 类型的变更通知，Session 注册消息时监听，移除或释放时解除监听。这样 Message 不反向依赖 Session，Session 又能更新内容版本、查询索引和历史失效标记。

变更通知与可阻止修改的执行 Hook 分别定义。多个 Session 显式共享同一个 Message 时，直接修改应当影响所有持有者；需要隔离的业务使用克隆。

Session 的编辑便捷入口委托 Message：

```ts
const message = session.getMessage(messageId);
message?.setText("修改后的内容");

// 等价的便捷调用，不复制一套文本编辑逻辑。
session.editMessage(messageId, message => {
  message.setText("修改后的内容");
});
```

Session 负责定位及结构有效性，Message 负责内容变更。编辑中的冲突与运行提交规则见第 7 节。

## 4. 三种 Session 共用轮次与执行记录

轮次信息属于所有 Session 的共同记录能力，组织结构是另外一个维度。

```text
                      共同消息与执行记录
                  Turn → Run → Step → ToolExecution
                            │
                消息出现位置与生成贡献关联
                            │
            ┌───────────────┼───────────────┐
         TreeSession     ListSession     AgentSession
         按树组织         按候选槽位组织    按交互轮组织
```

AgentSession 按 Turn 直接组织交互；TreeSession 和 ListSession 保留相同的轮次信息，用于查询、导出和恢复后的展示。

### 4.1 轮次定义

- Turn：一次用户交互。新 chat 创建新 Turn；继续或恢复关联原 Turn。
- Run：一次实际执行。重新生成、续写和恢复有独立 Run，保留运行之间的关联。
- Step：某个 Run 中的一次模型调用，编号在该 Run 内计算。
- ToolExecution：一个模型 Step 可以发起多个工具调用；每次具体执行有自己的标识和结果。

模型返回的 toolCallId 用于平台协议配对。内部 toolExecutionId 用于标识一次真实执行，不把厂商的调用 ID 当作跨步骤、跨运行的全局唯一身份。

手动添加的 system、user、assistant、tool 消息不一定具有完整运行来源。提供显式归组或关联入口；来源未知时保留未知，不按角色顺序伪造完整的执行历史。

小生成单元使用明确传入的上下文，不创建用户输入或自动维护 Turn。调用方若将结果纳入 Session，允许显式关联执行与 Turn；没有明确用户交互来源时保留为独立生成，不伪造用户输入。Agent 的自主执行入口负责其 Turn / Run 归属；确切默认归组策略待定。

### 4.2 Message 的身份与出现位置分别管理

轮次关联不应仅在 Message 上写一个 turnId 或 stepId。

原因：

- 同一 Message 可能在多个 Session 或结构位置中使用。
- 续写后的一个 Message 可能包含多次模型调用的贡献。
- 重生成会保留同一交互的多个候选，各自有不同的运行记录。

建议 Session 保存消息出现位置与执行记录的关联。关联包含可定位的结构身份，如节点 ID 或候选 ID，以及 turnId、runId、stepId。Message 只处理自身内容。

### 4.3 合并后的消息保留多次生成贡献

例如用户提出任务后，模型调用工具并回复，随后继续生成：

```text
Turn T1
  Run R1：正常生成
    Step S1：Assistant M1 发起工具调用 C1
      ToolExecution E1：结果 Message M2
    Step S2：生成回答 Message M3

  Run R2：继续生成，目标为 M3
    Step S3：生成续写，提交时合并进 M3

最终会话：M1 → M2 → M3
M3 的生成贡献：R1/S2 + R2/S3
```

示例中的 S1/S2/S3 是稳定标识；步骤显示编号分别为 R1 的 1、2 和 R2 的 1。

建议保存独立的消息生成贡献记录：关联生成来源、目标 Message ID、目标版本和本次提交操作，如 create、append 或 replace。精确记录到内容块或范围的方式待定。

后续用户编辑可以使历史贡献的文本范围不再准确，此时保留生成来源并标明内容已编辑，不声称当前文本仍等同于原始模型输出。

Step 保留自身 usage，合并正文不覆盖此前调用的用量。按 Run、Turn 或候选汇总时，明确计算范围并按模型调用去重。

### 4.4 分支、候选与删除

- 重生成使用新的 Run 和 Step，保留旧候选的记录；选中历史与全会话记录可分别查询。
- 分支中的交互顺序由当前路径计算。稳定身份与界面上的“第几轮”分别管理。
- 切换候选后，查询当前上下文时仅包含选中的路径或候选；查询完整记录时可包含未选中的执行。
- 删除当前内容不会静默改变已经执行过工具的事实。可以保留脱离当前内容的历史记录，并提供显式清理机制；确切删除与清理策略待定。
- 所有 Session 的导出和导入都保留必要的 Turn、Run、Step、ToolExecution 与消息关联，轮次信息不能只存在于流式事件或 Agent 内存中。
- 不要求默认保存每次调用的完整原始请求、原始响应和重复媒体。保留结构与执行事实，详细原始数据可由显式记录策略提供。

## 5. Session 查询契约

采用公共查询能力，默认范围为当前选中历史，显式选择全会话范围。API 示例：

```ts
session.getMessage(messageId);
session.query.messages({ role: "assistant", scope: "active" });
session.query.messages({ tags: ["important"], scope: "all" });
session.query.messages({ turnId, scope: "active" });
session.query.messages({ runId, toolCallId, scope: "all" });

session.query.turns({ scope: "active" });
session.query.runs({ turnId, scope: "all" });
session.query.steps({ runId });
session.query.toolExecutions({ runId, status: "awaitingApproval" });
```

查询维度可包含标识、角色、内容、标签、消息元数据、内容块类型、轮次、运行、步骤和工具执行。允许自定义谓词。

查询返回的 Message 可以通过自身接口编辑；执行记录提供只读结果，由会话提交接口或执行模块维护其一致性。

需要明确：

- 当前范围与全会话范围的顺序、分页以及身份去重规则。
- 通过 Message 查询内容，与通过节点、候选、Turn 查询出现位置的区别。
- 同一内容出现在多个位置时，结构操作必须指定位置身份，不能仅凭 Message ID 猜测删除哪个节点。
- 仅消息查询不代表某次调用生成时的原始内容；追踪执行来源时查询相应记录和贡献。

## 6. 生成、提交、请求上下文与显示分别表达

CharacterEditor 已存在输出正则、仅请求生效的正则和仅显示生效的正则。框架不强制这些内容相同，也不把所有转换塞进 Message.text。

```text
模型原始输出 → 提交前处理 → Session 中的 Message
                                   ├→ 请求上下文转换 → Provider
                                   ├→ 业务显示投影 → UI
                                   └→ 会话数据导出 → 业务存储
```

原则：

- Message 表达当前版本的消息内容，能够被用户编辑。
- Step 和生成贡献表达模型执行与提交来源。
- PromptBuilder 基于消息快照构建临时上下文，转换不修改 Session；保留来源关联。
- UI 可以隐藏思考、将工具调用投影成卡片、合并展示或修改显示文本，显示投影不自动写回会话。
- 提交前转换允许明确修改即将进入 Session 的内容。
- Session 内存提交与业务持久化完成是两个阶段，不把 MESSAGE_COMMITTED 当作数据库成功。

建议事件至少区分模型消息组装完成与会话提交完成，并带有关联身份。继续生成可在 UI 中先显示旧内容加新增量，最终用已提交 Message 校正显示；不强制用户采用特定渲染方式。

## 7. 生成提交与外部编辑

Agent 在开始运行时绑定 Turn、目标位置、候选和需要检查的内容版本；完成时通过 Session 的提交操作应用结果。

Message 的编辑能力保持独立。运行中的外部编辑、目标删除和候选切换由提交规则处理，不能默默把输出写到结束时的新光标，也不能覆盖已经编辑的消息。

继续生成尤其需要校验目标版本。可采用检测冲突后保留未应用结果的默认策略；是否允许用户指定追加、另建候选或其他解决方式，待确定。

提交操作协调消息编辑与执行记录：

- create：创建并放入指定位置，登记生成贡献。
- append：调用目标 Message 的追加方法，登记新贡献。
- replace：替换目标内容或位置引用，保留明确的旧记录关系。
- failure / interruption：记录实际执行进度和最终保留内容，不制造未执行工具的成功结果。

框架提供内存层面的协调；业务可以在明确的提交生命周期绑定自己的状态和持久化事务。框架不会承诺撤销外部工具副作用。

## 8. 需要继续决定的细节

1. Message 的内容块身份、编辑方法的精确语义、变更通知与版本粒度。
2. 手动添加消息和 generate 的默认 Turn 归组方式。
3. 节点、候选和交互轮的公共引用形式，以及共享 Message 的约束。
4. 生成贡献是否默认精确到内容块；编辑、删除后如何保留或清理记录。
5. Run / Step / ToolExecution 的最小持久字段与运行时状态的区别。
6. continue 在工具调用、中止和失败时的具体提交策略。
7. 外部编辑冲突的默认处理与结果返回类型。
8. 公开查询 API 的命名、范围、顺序与分页，避免引入大量重复入口。

下一步可以用正常聊天、工具循环、重生成、继续生成、消息编辑、导出恢复六组样例检验这些契约，再进入实现。
