---
description: "按照调用 Session 的文件策略创建、进入并移除 Git 工作树。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-worktree

[English](README.md) | 中文

## 概述

从本地提交或调用方未提交的已跟踪变更创建隔离的检出目录，并在其中继续同一个 Session。每次创建都会新建具名分支，源检出目录保持不变。所有写入均受现有沙箱约束。离开检出目录会保留文件与分支，直到消费方将其移除。

## 目录

- [使用本包](#use-this-package)
- [了解实现](#understand-the-implementation)
- [深入探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与待办工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

将服务与 `workingDirectory`、`fs`、`subprocess`、`sandbox` 和 `sandboxPolicy` 提供方一起挂载。模型需要此操作时，再添加工具包。

```yaml
- name: '@deepseek-ai/dsh-experimental-worktree'
- name: '@deepseek-ai/dsh-experimental-tool-worktree'
```

`ctx.worktrees.create(agent, { name?, from? }, signal?)` 创建新分支与检出目录，再通过 `ctx.workingDirectory.set` 进入规范化的检出目录。`from` 在创建前解析为本地提交，默认是 `HEAD`；暂存、未暂存、未跟踪以及被忽略的源文件均不复制。`baseCommit` 报告解析出的提交对象名称；仓库本地的替换引用仍作用于检出的内容。检出操作禁用已配置的 Git clean、smudge 和 process 过滤器，不修改仓库配置。分支或检出路径已存在时会报错。返回记录包含 `path`、`branch`、`baseCommit` 和 `repositoryRoot`。

`includeUncommitted: true`（同时省略 `from`）让检出基于一个新提交：其唯一父提交是 HEAD，其树包含调用方已跟踪文件的当前状态（含已暂存与未暂存的变更）；没有此类变更时基准就是 HEAD。该提交通过 `git stash create` 与 `git commit-tree` 生成，使用固定身份 `dsh worktree <worktree@dsh.invalid>`，并禁用已配置的过滤器；源检出目录的引用、索引条目和文件都不改变，未跟踪与被忽略的文件不会被带入。

`ctx.worktrees.remove(agent, { path, branch, repositoryRoot }, signal?)` 用 `git worktree remove --force` 移除一个链接检出目录并删除其分支，丢弃其中的文件。除非仓库在该路径登记了持有该分支的链接检出目录，否则它返回 `{ kind: 'missing' }` 且不作任何改动，因此消费方只会移除自己创建的检出目录。调用方的当前目录位于该检出目录内时，调用方先移到 `repositoryRoot`。`ctx.worktrees.locate(directory)` 根据目录本身或其上方最近的 `.git` 条目找到包含该目录的仓库，报告该条目是目录还是文件，且不运行任何命令。`ctx.worktrees.git(agent, { cwd, args, allowedExitCodes?, stdin?, disableFilters?, maxOutputBytes? })` 使用本服务的可执行程序运行一条 Git 命令，禁用 hook 与文件系统监视器，遵循调用方的文件策略，并把超出上限的标准输出报告为 `truncated` 而不是失败。

默认检出目录是 `<current checkout root>/.agents/worktrees/<name>`。返回的 `repositoryRoot` 是调用方当前检出目录的顶层目录；如果它是链接检出目录，工作树父目录就嵌套在其中。省略名称时，使用 `worktree-` 加 UUID。仅当服务的分配操作创建了父目录时，服务才会写入内容为 `*` 加换行符的 `.gitignore`；已有文件与忽略规则保持不变。相对路径 `directory`、生成名称使用的 `namePrefix`、可执行程序与进程限制可在[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-experimental-worktree)中查阅。

-----

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>实现细节——点击展开</summary>

Git 与目录分配通过挂载的子进程及沙箱提供方执行，沿用调用 Session 的文件策略。创建与移除操作不会扩大目标目录或共享 Git 管理目录的写权限。目录创建独占申请目标路径；取消或初始化失败可能留下已有产物，错误会包含其路径。服务销毁会中止待完成操作，并等待它们结束。

| 源码 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 解析源提交、创建检出目录并发布新的工作目录 |
| [`src/process.ts`](src/process.ts) | 约束字面参数、限制输出并等待进程终止 |
| [`src/directory.ts`](src/directory.ts) | 申请目标目录并初始化新建工作树父目录的忽略文件 |

本包不发布运行时不变量伴随入口：Git 拥有工作树注册信息，工作目录服务拥有 Session 目录；本包不保留二者的独立投影。

</details>

-----

<a id="further-exploration"></a>
## 深入探索

- [工作树子系统](../../../docs/subsystems/worktrees.zh.md)——请求、结果与服务参考。
- [工作目录](../../session/working-directory/README.zh.md) — 记录的 Session 目录与目录切换。
- [工作树工具](../tool-worktree/README.zh.md) — 面向模型的创建操作。
- [子进程](../../subprocess/subprocess/README.zh.md) — 进程所有权与执行环境。
- [创建决策](../../../.agents/notes/implemented/feature/2026-09-13-explicit-worktree-creation.zh.md) — 保留检出目录与既有写权限。

-----

<a id="model-experience"></a>
## 模型体验

通过工作树工具的创建结果与工作目录服务记录的 Session 上下文间接影响模型。

#### KV Cache 影响

本包不贡献提示文本。其消费方负责追加工具结果与记录的目录上下文。

## 已知限制与待办工作

<a id="known-limitations-and-deferred-work"></a>

- **保留产物**——离开工作树会保留其分支和文件，直到消费方调用 `remove()`。初始化失败也可能留下部分产物，服务不跟踪它们；清理注册信息以及移除未登记的检出目录由用户负责。
- **仅限本地提交**——创建操作不会获取远端提交或部分克隆中缺失的对象、初始化子模块、安装依赖或复制未跟踪文件；未提交的已跟踪变更只通过 `includeUncommitted` 带入。Git 满足执行要求时，本地对象缺失会导致创建失败。
- **过滤器处理前的内容**——检出时跳过已配置的过滤器，以避免执行仓库配置的程序或隐式下载。Git LFS 指针与加密 blob 保持存储时的形式；拉取实体内容或解密由用户另行执行。
- **执行要求**——子进程提供方必须在与文件系统提供方相同的执行环境中提供 Git 与 Node。Git 必须识别 `GIT_NO_LAZY_FETCH`：Git 2.45 及 2.39.4、2.40.2、2.41.1、2.42.2、2.43.4、2.44.1 维护版本均支持；更早的版本会忽略该变量并继续执行而不报错，因此创建操作可能从 promisor 远程获取缺失的部分克隆对象。`git --no-lazy-fetch` 选项会拒绝这些版本，但它仅在 Git 2.45 及以后存在，也会拒绝上述已修补的维护版本。现有沙箱必须允许写入检出目录与共享 Git 元数据。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

沙箱内的 Node 子进程提供[文件系统服务](../../fs/fs/src/index.ts)未公开的独占目录创建能力，并确定父目录是否由本服务创建。文件系统契约允许 [fs-local](../../fs/fs-local/src/index.ts) 等普通提供方在写入时忽略 `sandboxPolicy`；`createIfAbsent` 保护文件，但既不执行权限约束，也不确定目录由谁创建。将目录分配和忽略文件创建放在与 Git 相同的进程沙箱内，可保留对已有检出路径的拒绝行为，并落实创建 `.gitignore` 的条件。

</details>
