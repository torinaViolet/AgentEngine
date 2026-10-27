# 3.0.2：CE 接入缺陷修补

日期：2026-10-27。基线：`372f06adc6562e7d815810487db039d928dc7d1f`（3.0.1）。修补分支：`codex/ce-runtime-fixes`。

CE 接入 3.0 的审计发现输出截断、流完成判断、工具启动边界、失败修复、来源记录与长会话性能问题。本文记录本次实施，不代表 CE 本身已完成升级或三端验收。实际接口见 [API](./API.md)，版本变更见 [CHANGELOG](../CHANGELOG.md)。

## 修补范围

| 审计项 | 3.0.2 的行为 |
| --- | --- |
| AE-01 长度截断 | 增加 execution.lengthPolicy；默认 error，显式 complete 可完成无工具的截断回复，stopReason=length；截断工具调用仍失败 |
| AE-02 提前 EOF | HttpProvider 检查各协议完成状态；缺失完成信号时返回带 partial 的 GenerationError，不执行工具 |
| AE-03 流内错误 | 识别错误信封，保留 ProviderStreamError 的消息与 code/type/status；已有正文保留 |
| AE-04 陈旧会话工具 | afterCommit 后及工具实际启动点检查 Session 租约，冲突时不启动尚未开始的操作 |
| AE-05 取消/禁用窗口 | 异步通知后、调用 execute 前复查取消、启用和注册对象；审批等待结束后的变更也受检查 |
| AE-06 重复调用 ID | 按消息中的调用出现与结果顺序修复，不把 toolCallId 当成跨轮全局身份 |
| AE-07 partial 续写来源 | 共用提交归属登记，补工具失败记录；runId/stepId 查询与 JSON 往返一致 |
| AE-08 列表性能 | 一次遍历计算全部前缀，逐字节保持旧 JSON 指纹算法和持久化值 |
| AE-09 hook 契约 | commitContext 提供 signal；保持 live Session 租约直到 afterCommit 结束，随后正确结算中止/超时；忽略 signal 的外部回调不能被安全地强杀 |

新增回归还发现同一个网络块中，后面的畸形 SSE 事件会让前面已经解析的事件一起丢失。decodeSSE 改为逐事件交付，让 Provider 能保留此前有效的 partial，再传播后续错误。

## 兼容性与边界

- legacy API 与解析器没有修改。严格完成验证放在原生 HttpProvider，不强制自定义 ChatProvider 采用内置协议。
- OpenAI、Responses、Anthropic、Gemini 分别使用自己的完成信号；不能统一要求所有流包含 `[DONE]`。自定义中转必须保留协议完成事件。
- 长度截断的默认行为不变，CE 要显式采用 `execution: { lengthPolicy: "complete" }`。
- Session 格式仍为 version=3；List/AgentSession 的已有 context 值原样有效，避免升级后把历史全部判为 stale。
- 不撤销已发生的外部副作用；工具仍要传递 signal、按需要提供幂等保证。
- afterCommit 接收实际消息，因此不会在一个旧回调仍可能改它时释放租约。合作取消能及时结束；不合作的回调必须自己结束，框架不会伪造已经终止。afterRun 属于已结算后的通知。

## 验证

- 新增 70 项测试，位于 `test/v3/ce-audit-regressions.test.ts`、`stream-completion.test.ts`、`list-prefix-scaling.test.ts`。
- 同一批新增测试加载未修补的 npm 3.0.1，原始退出码为 1：11 通过、59 失败，证明没有仅检查“测试脚本能运行”。
- `npm test`：347 项，346 通过、1 项默认跳过的真实 API 测试；无失败。完整流程还通过浏览器构建、无 Buffer 运行、包导出检查。
- 复杂度检查统计 requestRevision 的实际读取数，在 250/500/1000/2000 轮下分别约束线性增长，不依赖某台机器的严格毫秒阈值。
- 指纹兼容测试用原 JSON 整体哈希算法独立计算期望值，包含引号、反斜杠、中文 ID，以及编辑/候选切换/accept/JSON 恢复。
- 相同本机 Node 合成测量：2000 轮 staleRowIds 从约 845ms 降为约 3ms，beginGeneration 从约 832ms 降为约 6ms。此结果不包含网络/UI，也不代替 CE 三端性能验收。

发布前运行 npm 的 prepublishOnly（完整测试与构建）并检查 npm 包内容；发布后回读精确版本与 dist 完整性。CE 升级包、接入长度开关、重录流程基线与设备验收仍在 CE 仓库独立进行。
