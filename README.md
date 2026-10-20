# Loom for DeepSeek Harness

> **Loom has moved to [scasella/dsh-loom](https://github.com/scasella/dsh-loom).** Use that repository for the standalone plugin, current installation instructions, releases, and issue tracking. This fork is preserved as a read-only reference, including its historical releases, source, and existing links. The instructions below describe the historical fork release.

English | [中文](README.zh.md)

[![release: v0.1.0-alpha.1](https://img.shields.io/badge/release-v0.1.0--alpha.1-orange?logo=github)](https://github.com/scasella/deepseek-harness/releases/tag/loom-v0.1.0-alpha.1)

Branch an agent task or a passage of prose, compare alternatives, and keep every path you explored. Loom adds a conversation tree, workspace comparisons, and a prose editor to DeepSeek Harness.

This is an independently maintained community fork of [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), the open-source, Cordis-powered agent harness developed by DeepSeek AI. Both projects use the [MIT license](LICENSE).

[Source prerelease](https://github.com/scasella/deepseek-harness/releases/tag/loom-v0.1.0-alpha.1) · [Watch the demo](#demo) · [Install and set up](#run) · [Loom user guide](docs/user/guide/loom.md) · [Report an issue](https://github.com/scasella/deepseek-harness/issues)

<a id="demo"></a>
## Watch the demo

https://github.com/user-attachments/assets/3a35ceab-bd12-4e20-a4c9-b0bda106d687

3:54, 1080p, with explanatory captions and no audio. The demo uses real model calls and captured UI states with edited timing. Download the [full-quality video](https://github.com/scasella/deepseek-harness/releases/download/loom-demo/Loom.mp4) or [captions](https://github.com/scasella/deepseek-harness/releases/download/loom-demo/Loom.srt).

<a id="features"></a>
## What you can do

| Feature | Try it with Loom |
|---|---|
| Branch conversations | Regenerate several answers, steer variants with different instructions, or edit a prompt into a new branch. Override the children's model and thinking settings. |
| Read the tree | Navigate siblings, keep or set aside branches, expand inherited turns, and inspect logged model requests and reasoning. |
| Compare workspace changes | Give competing edits separate Git worktrees. Compare tests, diffs, own usage, and time; apply a patch, adopt a branch, or discard its worktree. |
| Try hypothetical tool results | Edit a recorded result in a fork and let the model continue from that observation without rerunning the tool. |
| Write with Weave | Generate several prose continuations at the cursor, preview them, choose one, and retain its siblings. |
| Explore tokens | Inspect captured token probabilities and alternatives, explore a bounded token tree, and continue from a selected token. Requires model support. |
| Curate and export | Track Weave choices with a curation meter. Export a path, its siblings, or kept prose as HTML, text, or JSON. |
| Delegate exploration | Let the model expand, wait for, read, keep, and archive branches under branch, depth, token, and optional dollar budgets. |
| Find and navigate branches | Browse families in Multiverse, search own or inherited messages, use tree keyboard shortcuts, and switch branches on mobile. |

<a id="run"></a>
## Install and set up

The [Loom v0.1.0-alpha.1 source prerelease](https://github.com/scasella/deepseek-harness/releases/tag/loom-v0.1.0-alpha.1) includes the matching Harness changes. It provides source, with no npm package or installer for this fork. The published `@deepseek-ai/dsh` package does not include these Loom APIs; use the complete checkout below. Loom is experimental. Read the [safety notice](SAFETY.md) before running agents on your files.

<a id="run-from-source"></a>
### Run from source

Install Git 2.26+, Node.js 24+ (or Node 22.19 or later within 22.x), and pnpm **11.28.5**. The following commands use a POSIX shell; see the [development guide](docs/development.md#setup-tutorial) for toolchain and Windows setup.

```sh
git clone --branch loom-v0.1.0-alpha.1 --single-branch https://github.com/scasella/deepseek-harness.git deepseek-harness-loom
cd deepseek-harness-loom
pnpm install
pnpm run build

export DSH_HOME="$PWD/.artifacts/loom-home"
pnpm dsh plugin --profile web add link:./packages/experimental/loom-bundle --offline
pnpm dsh web --no-open --port 3097
```

Open the URL printed by the launcher, including its local authentication token. This setup stores Loom's profiles, credentials, and Sessions in a separate, Git-ignored home and uses port **3097**, leaving the normal `~/.dsh` home and port **3080** untouched. To resume later, return to this checkout, set the same `DSH_HOME`, and rerun the last command. Choose another unused port if 3097 is occupied.

<a id="setup"></a>
### Configure your first Session

1. Open **Plugins**, select **More** beside **Experimental plugins**, and confirm **Loom** is enabled. The install command above enables it; the switch also lets you turn it off.
2. Open **Settings → Models**, enter your DeepSeek API key, and save. For OpenRouter, another provider, or a custom endpoint, follow [Configure models](docs/user/guide/providers.md). Select a model in the composer.
3. Click **Choose workspace**, add a project directory, and select it. Use a disposable project for your first experiment.
4. Start a conversation. After its first completed turn, open **Loom** beside Chat; **Read**, **Compare**, and **Weave** are available there. **Multiverse** appears in the sidebar.

Loom's Chat features use your configured model. Weave needs tool-free assistant-prefix support, and probability exploration additionally needs token probabilities; the [Loom guide](docs/user/guide/loom.md) explains these capabilities and the complete workflow.

<a id="first-experiment"></a>
### Make your first branches

Send this in Chat:

> Propose one small command-line task queue design. Keep it to five bullets and do not modify files.

Open the arrow beside **Regenerate**, select **×2**, and press **Regenerate ×2**. Open **Loom → Read**, move between them, and mark a favorite **Keep**. Use **Branch several** to compare different steering instructions or **Edit and branch** to revise the original prompt.

For competing code edits, select **Isolate each branch in a worktree** before branching, then use **Compare** to inspect results. The workspace must be a Git repository with at least one commit, and the Session must allow workspace writes. Try **Weave** with a short story opening to explore prose instead.

<a id="costs-and-limits"></a>
## Costs and limits

Each branch, prose continuation, and token probe can make additional paid model calls. No prices ship by default: without configured prices, Loom shows tokens; configured dollar figures are **list-price estimates**, not your account bill. Set small counts and budgets while exploring.

Worktrees carry tracked changes from the source checkout, exclude untracked and ignored files, and do not install dependencies. Shared-folder branches see the same files. Apply requires a clean source checkout; Adopt retains histories and does not apply files or remove worktrees. Use Apply or Discard for cleanup. Host restarts lose queued admissions and autonomous budgets; persisted histories, prose, and choices remain. See [saved data and limits](docs/user/guide/loom.md#limits) before relying on a run.

<a id="documentation-and-support"></a>
## Documentation and support

- [Loom user guide](docs/user/guide/loom.md) — branching, Compare, Weave, exports, and limits.
- [Loom bundle](packages/experimental/loom-bundle/README.md) — local installation, removal, and profile configuration.
- [Loom service](packages/experimental/loom/README.md) and [autoloom tools](packages/experimental/tool-loom/README.md) — pricing, permissions, and budget settings.
- [Fork issues](https://github.com/scasella/deepseek-harness/issues) — Loom feedback and bug reports.
- [Upstream documentation](https://deepseek-harness.github.io/deepseek-harness/) — general Harness usage; Loom's fork-specific instructions live in this repository.

<a id="development"></a>
## Development

Start with the [development guide](docs/development.md), [architecture](docs/architecture.md), and [contribution guide](CONTRIBUTING.md). Agents should follow [AGENTS.md](AGENTS.md). Submit Loom contributions to this fork.

<a id="credits-and-license"></a>
## Credits and license

DeepSeek Harness is developed by [DeepSeek AI](https://deepseek.com) on an everything-is-a-plugin architecture powered by [Cordis](https://github.com/cordiverse/cordis). Cordis's design is described in [_A Programming Paradigm for Spatiotemporal Composability_](https://arxiv.org/abs/2608.25512).

[MIT](LICENSE). Third-party dependencies and their licenses are disclosed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

<details>
<summary>Cite DeepSeek Harness</summary>

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
