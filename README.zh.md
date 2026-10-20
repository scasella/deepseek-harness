# Loom for DeepSeek Harness

[English](README.md) | 中文

[![release: v0.1.0-alpha.1](https://img.shields.io/badge/release-v0.1.0--alpha.1-orange?logo=github)](https://github.com/scasella/deepseek-harness/releases/tag/loom-v0.1.0-alpha.1)

为智能体任务或一段文字创建分支，比较不同结果，并保留探索过的每条路径。Loom（织机）为 DeepSeek Harness 添加对话树、工作区比较和散文编辑器。

这是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的独立社区分支。DeepSeek Harness 是 DeepSeek AI 开发、由 Cordis 驱动的开源智能体框架。两个项目均采用 [MIT 许可证](LICENSE)。

[源码预发布版](https://github.com/scasella/deepseek-harness/releases/tag/loom-v0.1.0-alpha.1) · [观看演示](#demo) · [安装与设置](#run) · [Loom 用户指南](docs/user/guide/loom.zh.md) · [报告问题](https://github.com/scasella/deepseek-harness/issues)

<a id="demo"></a>
## 观看演示

https://github.com/user-attachments/assets/3a35ceab-bd12-4e20-a4c9-b0bda106d687

3 分 54 秒，1080p，带功能说明字幕，无音轨。演示使用真实模型调用及捕获的界面状态，经过节奏剪辑。可下载[完整画质视频](https://github.com/scasella/deepseek-harness/releases/download/loom-demo/Loom.mp4)或[字幕](https://github.com/scasella/deepseek-harness/releases/download/loom-demo/Loom.srt)。

<a id="features"></a>
## 可以做什么

| 功能 | 使用 Loom 探索 |
|---|---|
| 创建对话分支 | 重新生成多个回答，用不同指令引导变体，或编辑提示词创建新分支。可为子分支单独设置模型和思考选项。 |
| 阅读对话树 | 浏览同级分支、保留或搁置分支、展开继承轮次，并检查记录的模型请求和推理。 |
| 比较工作区更改 | 将竞争方案的文件编辑放在独立 Git 工作树中。比较测试、差异、自有用量和耗时；应用补丁、采纳分支或丢弃其工作树。 |
| 尝试假设性工具结果 | 在分支中编辑已记录的结果，让模型根据这一观察继续，无需重新运行工具。 |
| 用 Weave 写作 | 在光标处生成多个散文续写，预览并选择其一，同时保留同级候选。 |
| 探索词元 | 检查捕获的词元概率及候选，探索有界词元树，并从选定词元继续。需要模型支持。 |
| 策展与导出 | 用策展计量器记录 Weave 选择。将路径、同级候选或已保留散文导出为 HTML、文本或 JSON。 |
| 委托模型探索 | 让模型在分支、深度、词元及可选美元预算约束下，展开、等待、阅读、保留和归档分支。 |
| 查找与浏览分支 | 在多元宇宙中浏览分支族，搜索自有或继承消息，使用树形键盘快捷键，并在移动端切换分支。 |

<a id="run"></a>
## 安装与设置

[Loom v0.1.0-alpha.1 源码预发布版](https://github.com/scasella/deepseek-harness/releases/tag/loom-v0.1.0-alpha.1)包含配套的 Harness 更改。该版本提供源码，本分支尚未发布 npm 包或安装程序。已发布的 `@deepseek-ai/dsh` 包不包含这些 Loom API；请按下方说明使用完整检出。Loom 属于实验功能。在让智能体操作文件前，请阅读[安全说明](SAFETY.zh.md)。

<a id="run-from-source"></a>
### 从源码运行

安装 Git 2.26+、Node.js 24+（也支持 22.x 中的 22.19 及更高版本）和 pnpm **11.28.5**。以下命令使用 POSIX shell；工具链与 Windows 设置见[开发指南](docs/development.zh.md#setup-tutorial)。

```sh
git clone --branch loom-v0.1.0-alpha.1 --single-branch https://github.com/scasella/deepseek-harness.git deepseek-harness-loom
cd deepseek-harness-loom
pnpm install
pnpm run build

export DSH_HOME="$PWD/.artifacts/loom-home"
pnpm dsh plugin --profile web add link:./packages/experimental/loom-bundle --offline
pnpm dsh web --no-open --port 3097
```

打开启动器打印的 URL，包括其中的本地身份验证令牌。此设置会将 Loom 的配置档案、凭据和 Session 存入独立且被 Git 忽略的目录，并使用 **3097** 端口，不影响常规的 `~/.dsh` 目录及 **3080** 端口。以后继续使用时，回到此检出目录，设置相同的 `DSH_HOME`，再运行最后一条命令。如果 3097 已被占用，请改用其他空闲端口。

<a id="setup"></a>
### 配置第一个 Session

1. 打开**插件**，选择**实验性插件**旁的**更多**，确认**织机**已启用。上面的安装命令会启用它；也可用此开关关闭它。
2. 打开**设置 → 模型**，输入 DeepSeek API 密钥并保存。如需使用 OpenRouter、其他提供方或自定义端点，请参阅[配置模型](docs/user/guide/providers.zh.md)。在输入框的模型选择器中选择模型。
3. 点击**选择工作区**，添加项目目录并选中。第一次实验请使用可丢弃的项目。
4. 开始对话。第一个轮次完成后，打开聊天旁的**织机**；其中可使用**阅读**、**对比**和**编织**。侧栏会显示**多重宇宙**。

Loom 的聊天功能使用你配置的模型。Weave 需要无工具的助手前缀支持，概率探索还需要词元概率；[Loom 指南](docs/user/guide/loom.zh.md)介绍这些能力与完整工作流程。

<a id="first-experiment"></a>
### 创建第一组分支

在聊天中发送：

> Propose one small command-line task queue design. Keep it to five bullets and do not modify files.

打开**重新生成**旁的箭头，选择 **×2**，再点击**重新生成 ×2**。打开**织机 → 阅读**，在候选间切换，并将最喜欢的标为**保留**。用**多路分支**比较不同引导指令，或用**编辑并分支**修改原始提示词。

如需比较竞争方案的代码编辑，请在创建分支前选择**为每个分支单独创建 worktree**，然后用**对比**检查结果。工作区必须是至少有一次提交的 Git 仓库，且 Session 必须允许写入工作区。若想探索散文，可在**编织**中输入一个简短故事开头。

<a id="costs-and-limits"></a>
## 费用与限制

每个分支、散文续写和词元探测都可能产生额外的付费模型调用。默认不附带价格：未配置价格时，Loom 显示词元；配置后的美元金额为**标价估算**，并非账户账单。初次探索时请使用较少候选和较小预算。

工作树携带源检出中的已跟踪更改，不包含未跟踪或被忽略的文件，也不安装依赖。共享目录分支看到的是同一组文件。应用要求源检出干净；采纳保留历史，但不会应用文件或移除工作树。请用应用或丢弃清理工作树。宿主重启会丢失排队任务和自主探索预算；已持久化的历史、散文和选择仍会保留。在依赖运行结果前，请阅读[保存的数据与限制](docs/user/guide/loom.zh.md#limits)。

<a id="documentation-and-support"></a>
## 文档与支持

- [Loom 用户指南](docs/user/guide/loom.zh.md) — 分支、比较、Weave、导出和限制。
- [Loom 插件包](packages/experimental/loom-bundle/README.zh.md) — 本地安装、移除与配置档案设置。
- [Loom 服务](packages/experimental/loom/README.zh.md)和[自主探索工具](packages/experimental/tool-loom/README.zh.md) — 价格、权限和预算设置。
- [本分支的问题跟踪](https://github.com/scasella/deepseek-harness/issues) — Loom 反馈和错误报告。
- [上游文档](https://deepseek-harness.github.io/deepseek-harness/) — Harness 通用用法；Loom 在本分支中的专用说明保存在此仓库中。

<a id="development"></a>
## 开发

请先阅读[开发指南](docs/development.zh.md)、[架构文档](docs/architecture.zh.md)和[贡献指南](CONTRIBUTING.zh.md)。智能体应遵循 [AGENTS.md](AGENTS.md)。请将 Loom 贡献提交到本分支。

<a id="credits-and-license"></a>
## 致谢与许可证

DeepSeek Harness 由 [DeepSeek AI](https://deepseek.com) 开发，采用一切皆插件的架构，由 [Cordis](https://github.com/cordiverse/cordis) 驱动。Cordis 的设计参见 [_A Programming Paradigm for Spatiotemporal Composability_](https://arxiv.org/abs/2608.25512)。

[MIT](LICENSE)。第三方依赖及其许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

<details>
<summary>引用 DeepSeek Harness</summary>

```bibtex
@misc{deepseek-harness2026,
  title={DeepSeek Harness: Everything is a Plugin},
  author={DeepSeek-AI},
  year={2026},
  publisher={GitHub},
  howpublished={\url{https://github.com/deepseek-ai/deepseek-harness}},
}
```

</details>
