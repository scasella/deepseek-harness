# Agent Note: 面向 Session 分支与文本写作的 Loom 界面

Status: proposed

[English](2026-10-18-loom-interface.md) | 中文

## 问题

Loom（得名于 janus 的 Loom）把模型输出视为一棵树：生成多个续写，逐一阅读，保留其中一个，同时不丢失其余续写。dsh 已经存储了这棵树：fork 是一个 Session，它复制精确的事件前缀，并记录自己的 `parentSession`（[fork.ts](../../../../packages/core/session/src/fork.ts)）。但产品既不展示也不使用这棵树：

- fork 在侧边栏中显示为扁平的行。通过 Branch 创建的每个 fork 都被重命名为「… (1)」，因此五个同级 fork 无法区分，根 Session 也可能被滚动到「Show N more sessions」之下。
- 打开 fork 时，切点处没有任何标记，页脚还把继承来的轮次计为它自己的轮次。
- 已提交的轮次不支持重新生成、编辑后分支，也不支持在同级之间导航。
- 无法在决策点分出 N 个分支、比较结果并采用其中之一。
- dsh 从不采集 token 概率，因此无法显示模型在何处不确定，也无法从选定的 token 继续生成。

促成本 Agent Note 的这一轮设计在运行中的 Web 应用里，基于真实 fork 与真实 token 概率绘制了十个界面，并整理出 27 项提案（L1–L27）。本 Agent Note 是分阶段构建这些提案的计划。

## 提案

### 工作划分

Loom 的行为位于新的实验性包中；发布包缺少座位、投影或请求字段时，由对应的所有者包做少量改动：

| 包 | face | 负责内容 |
|---|---|---|
| `packages/experimental/loom` | Host 服务与 `loom` Remote（模板：`api-speech-to-text`） | `plugin:loom/*` 记录、`loomBranch` 投影单元、分支运行器、worktree 衔接逻辑、比较、采用与应用、`requestAt`、导出路由、Weave、定价 `Config`、遥测脱敏 |
| `packages/experimental/client-ui-loom` | Client 插件 | 所有 Loom slot 条目、Loom 视图标签页、multiverse 页面、条带、翻页器、表单、token 着色、树形快捷键、locale 命名空间 `loom` |
| `packages/experimental/tool-loom` | Host 模型工具 | 供 autoloom（L24）使用的 `loom_expand`、`loom_wait`、`loom_read`、`loom_cull`、`loom_keep` |
| `packages/experimental/loom-bundle` | 可选组合包 | 插入上述三个包（L12 还需插入 `worktree`）；一项 `OPTIONAL_BUNDLES` 条目 |

Loom 分支始终是通过 `SessionController.fork` 创建的顶层 fork Session，绝不是隐藏的 subagent。分支运行器延迟执行 fork：只有并发名额允许时才创建子 Session；它移除继承来的下一轮次 inbox 项，使父 Session 中排队的提示词无法抢先运行；写入一条 `plugin:loom/branch` 记录；并以 `user-rpc` 来源发送子 Session 的提示词。页面关闭时不会遗留空 fork。

### 未决问题的决定

- **fork 路由（L11）。** fork 已经沿用父 Session 日志中记录的路由继续运行：`session-fork.host.spec.ts` 断言了这一点，2026-10-18 的一次真实 API 检查在另一个默认模型下也确认了这一点。L11 因此缩减为两项：通过 `selectForNextRequest` 为每个分支显式覆盖路由（该方法从不保存全局默认值）；切点位于首个请求之前时，采用父 Session 第 1 轮次的路由。
- **继承的排队提示词。** 只有 Loom 丢弃它们。产品的 Branch 按钮保持现有行为；改变该行为需要升级指南，不在本计划范围内。
- **Weave。** 一种文本写作模式，其文档保存在 `plugin:loom/weave-*` 记录中。Weave 生成的文本不进入 Chat 界面。「在 Chat 中继续」操作不在范围内。
- **筛选计量（L18）。** 只统计 Weave 中的选择，计为每次选择的 log2 n 之和（Σ log2 n）。采用决定会被记录，但不计入。
- **限定范围的搜索（L22）。** 侧边栏搜索的默认范围保持不变；Loom 显式传入搜索范围。
- **交付方式。** Loom 以默认关闭的可选组合包发布；启用前，插件管理器把它放在「更多」中。用于开发的 `--patch` overlay 在 S1 随首个可见 slot 及其 overlay 等价性 Web 测试一起提供。
- **升级为正式事件。** Loom 记录保持为实验性插件记录。把它们升级为 `SessionEventMap` 成员会使其成为读取时必需（required-on-read）的事件，因此要等设计稳定后再进行。
- **fork 页脚拆分（F3）。** fork 补齐的收尾事件计为继承的工作。用量胶囊标签先显示自身总量与自身缓存命中率（Compact 模式同样如此），再显示继承总量；其对话框列出自身的各分桶和一行「继承」。活动胶囊标签的两半都使用未 fork Session 的计数措辞。fork 模式 subagent 子会话的页眉 token 指标只统计其自身的请求。
- **家族读取（F4–F5）。** 浏览器用共享的 `forkFamily()` 导出从客户端 Session 列表推导 fork 家族，兄弟节点按 `forkLineage.createdAt`、再按 Session id 排序。Host 的 `loom.family` Remote 服务没有 Session 列表的调用方。分支准入上限在 S2 随执行它们的分支运行器一起成为 `Config` 字段。
- **fork 模式 subagent 的预期输出。** fork 模式 subagent 子会话的页眉 token 指标与输入框 dock 的无密钥 Web 预期输出在 S1 提供，S1 会以 fork 面包屑改动同一页眉；S0 以 ui-subagent 与 ui-chat 的客户端测试覆盖这一改动。

### 阶段

每个阶段以一个或多个提交落在 `loom/loom-interface` 上。当类型检查、带逐文件覆盖率的聚焦测试、`build:check`、相关的 `doc-sync` 门禁以及该阶段的真实 API 测试套件全部通过，并且花费台账已更新时，该阶段即完成。

**S0 基础。**
- F1：在 session-controller 中提供 `completedPrefixBefore(events, turn)`，包括第 1 轮次的切点（首个提示词拼接之前的最后一个独立事件）。修正陈旧的 fork 文档（[architecture.md](../../../../docs/architecture.zh.md) 中的 `seedLength`，以及 `docs/subsystems/session.md`）。
- F2：一个发布包中的 `forkLineage` 投影（`parentSession`、切点 seq、切点轮次、`createdAt`），侧边栏和 Loom 可以从列表提示中读取它。
- F3：在 `tokenUsage` 与 `sessionStats` 投影中区分自身与继承两个分桶并提升 `stateVersion`，以及读取这些分桶的页脚胶囊标签。
- F4–F6：`loom` 与 `client-ui-loom` 的骨架、`loom-bundle`，以及所有共享注册（tsconfig paths、face、bundle 行、CLI 与 Web 依赖），由同一个 agent（智能体）编写。
- F7：`llm-replay` 按创建顺序而非首次调用顺序绑定其安装之后创建的子 Session；已存储和预置的子 Session 保持首次调用绑定。
- F8：Web scaffold 为 fork 家族填充种子信息（`parentSession`、`isSeeded`、继承的 `session/end-seed`）。
- F9：修复 pi-ai 路由：映射 `usage.reasoning`，经 `samplingParams` 透传 `stop`，通过路由 profile 的 `openRouterProvider` 字段固定模型提供商，并提供可用的「关闭思考」映射。
- 工具链探查：在本机检验 `persistence-changes --record` 与 Python SDK 快照刷新。

**S1 定位（只读）。** L1：fork 横条、在 Chat 中折叠继承区段（ui-chat 的发布改动，含其 `conversation.chat.fork-cut` slot）、页眉中的 fork 面包屑，以及页脚中自身／继承的计数；L8：带大纲树与阅读窗格的 Loom 标签页；L26：以 `loom.requestAt` Remote 提供「模型看到了什么」；L20：树形快捷键；L27：在同级卡片上折叠推理（reasoning）内容并显示其 token 数。

**S2 分支。** L3：重新生成 ×N；L4：N 路分支，每个子 Session 各带一行 steering（中途引导）；L5：运行中分支条带；L11：路由覆盖；L2：同级翻页器（需要扩展 `AssistantActionOwnerProps`，并在 ui-chat 的 Branch 之后增加一个座位）；L13：编辑较早的用户消息并分支（新的 `conversation.chat.user-actions` 座位）；L15：带遥测脱敏监听器的私有标记；L23：提示词变体集。

**S3 工作区与费用。** L12：每个分支独立的 worktree 隔离；L6：结果优先的比较（用可配置的模式从分支自身的命令输出中解析测试结果，从 git 获取 diff 统计，以及分支自身的成本与耗时）；L7：采用、应用与归档；L25：基于经过校验的定价 `Config` 的成本预览；L24：`tool-loom` 中的 autoloom。

**S4 应用外壳。** L10：侧边栏中的 fork 家族与感知 fork 的标题（需改动所有者包 session-title 与 ui-workspace；需要升级指南）；L9：multiverse 页面；L22：限定在自身、继承或同级历史中的搜索（session-query 与控制器）；L21：移动端布局，以及 ui-primitives 中的底部抽屉基础组件。

**S5 循环入口。** F10：agent-loop 的 `continue` 入口，它在没有新用户消息的情况下运行一个步骤，并附带 `turn/start.continuation?` 标记、一个控制器 RPC、架构文档，以及两个 SDK 的预期输出。随后是 L14：编辑已记录的工具结果（仅替换内容的 surface 替换，Session 已经允许这种替换）并继续。

**S6 token 与文本写作。** L16：逐 token 的 logprobs，作为 `block-end` 流分片上的可选 `logprobs` 字段，在 pi-ai 路由上采集；L17：仅在不带工具的辅助调用上从 assistant 前缀继续生成；Weave：先领跑后并发（lead-then-burst）的调度方式，以及块级 multiverse 视图；L18：筛选计量；L19：导出一条路径、一条路径及其同级，或已保留的分支，并附带筛选记录。

### 真实 API 测试

回归防护分为两层：

- **无密钥，在 CI 中运行。** 逐文件 100% 覆盖率的单元测试、手写或回放的会话快照，以及使用 `DSH_SNAPSHOT=replay` 的 Web ARIA 预期输出。这些都不产生费用。
- **真实 API，在本地运行。** 真实 API 测试套件以 `OPENROUTER_DEEPSEEK_API_KEY` 为前提，该变量为空时自动跳过；运行命令为 `DEEPSEEK_API_KEY= pnpm run test:e2e <files>`，否则 `.env` 中未充值的 `DEEPSEEK_API_KEY` 会让以 DeepSeek 密钥为前提的套件运行并失败。测试 overlay 使用普通模型 id `deepseek/deepseek-v4.1-flash-1017` 并固定模型提供商，从不使用账户预设，因此不会有账户专属的 id 进入 fixture（测试前置数据）。真实浏览器运行使用隔离的 `DSH_HOME`、3080 以外的端口，以及 `--patch apps/web/tests/pin-browse-picker.overlay.yml`。

每个阶段都为自己改动的内容增加真实 API 用例：S0 验证 fork 路由（session-controller 中的 `fork-route.e2e.ts`）。跨 fork 的缓存复用尚未解决：在 OpenRouter 路由上，pi-ai 把每个 Session 自己的 id 作为 `x-session-id` 亲和性请求头发送；2026-10-18 的一次探查中，同一 id 下重复的请求读取了 1,536 个缓存 token，换一个 id 则为零。S2 真实执行重新生成与分支，并检查子 Session 的路由、提示词以及 `cacheReadTokens > 0`，这需要每个 fork 家族使用同一个亲和性键；S3 隔离两个以不同内容写入同一文件的分支；S5 在编辑工具结果后继续；S6 检查正文 logprobs、思考模式下不存在推理 logprobs、句中续写，以及带工具历史时的拒绝。

## 考虑过的替代方案

**在同一个 Session 内保存多条备选 assistant 消息。** surface 无法容纳它们：`assistant/message` 永远不能成为替换型 surface 事件。把同级作为独立的 fork Session，可以复用 dsh 已有的存储。

**用 subagent、工作流或 Agent Teams 实现分支。** 它们的子 Session 是隐藏的 `origin: subagent` 行，只能以调用方自身最后一个轮次的结束点作为种子。Loom 分支需要在另一个 Session 的精确 seq 处切分。

**在 agent loop（智能体循环）中预填充。** 只要请求带有工具或工具历史，DeepSeek 就拒绝前缀续写，而循环发出的每个请求都携带 preset 的工具。预填充仅限于先把确切请求写入日志的辅助调用。

**为 logprobs 新增流分片变体。** 读取方对分片类型使用穷举 switch，llm-replay 也以白名单列出这些类型，因此新变体会在运行时出错。已发布的读取方会忽略 `block-end` 上的可选字段。

**声明 `loom/*` 会话事件。** 没有任何 API 能以可忽略方式追加已声明的事件，因此旧读取方会拒绝含有这些事件的日志。实验性插件记录是可忽略的，并会随 fork 一起复制。

**用 canvas 图形库绘制这棵树。** 谱系是每个节点只有一个父节点的树；APG 大纲树（`SubagentHeaderLineage` 模式）无需新增依赖，即可支持键盘、屏幕阅读器和手机。

## 验收标准

- 启用 Loom 组合包时，L1–L27 的每项提案和 Weave 都能在 Web 应用中使用；停用时没有任何变化，上文列出的发布包所有者改动除外（侧边栏中的 fork 家族、fork 面包屑、Chat 中折叠到一行的继承历史及其 `conversation.chat.fork-cut` slot、页脚中自身／继承的计数、fork 模式 subagent 页眉中只统计自身的 token、pi-ai 的 `stop`／关闭思考／推理计数映射、`forkLineage` 投影、限定范围的搜索参数、logprob 采集）。
- 每个阶段的无密钥测试、快照和 Web 预期输出在 CI 中通过，其真实 API 套件在本地通过，且花费控制在为本工作批准的 5 美元台账之内。
- 没有新增 `as unknown` 断言，no-unknown-casts 基线不增长，新文件和受门禁约束的文件达到逐文件 100% 覆盖率，并且 `doc-sync` 通过。
- `block-end.logprobs` 与 `turn/start.continuation?` 都有持久化确认记录；TypeScript 与 Python SDK 的预期输出已为 F10 刷新。

## 风险

- **花费。** 重新生成 ×N、变体和 autoloom 会成倍增加调用次数。S2 把 `maxBranchesPerRequest` 与 `maxConcurrentBranches`、S3 把 autoloom 预算作为经过校验的 `Config` 字段加入，成本预览始终注明「按标价计算」。
- **共享文件夹。** 没有 L12 时，并发写入的分支会在同一个文件夹上竞争。除非用户选择逐个运行，否则运行器拒绝在没有隔离的情况下并发运行具有写权限的分支。
- **遥测。** 由反馈触发的导出包含插件记录与 logprobs；Loom 挂载一个脱敏监听器。
- **记录持久性。** 格式迁移时，实验性记录只会尽力保留；README 会说明这一点。
- **需要人工参与。** 组合包图标与新字形（keep、set aside、multiverse、weave、bottom sheet）需要设计师批准；zh 文案需要译者评审；需要决定是否在 CI 中配置 OpenRouter 密钥（在此之前真实 API 套件只在本地运行）。这些事项阻塞合入 master，不阻塞分支上的工作。
