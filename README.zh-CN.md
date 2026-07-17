# Agent Sessions

快速找到 Claude Code、Codex 或 pi 的历史对话，看清工作如何在 Session 之间
流转，并通过可直接执行的恢复命令从原项目继续。

[English](README.md)

![Agent Sessions 总览](docs/dashboard.png)

Agent Sessions 是一个本地 Dashboard 和 CLI，适合同时使用多个编码 Agent、
维护多个项目的人。它直接读取各工具已经保存在本机的历史记录，不需要导入，
也不需要登录云端账号。

## 你可以用它做什么

- **检索用户直接创建的 Session**：按工具、项目路径、日期、状态、大小、名称、
  备注、首条消息或完整 Transcript 检索 Claude Code、Codex 和 pi 的历史；
  不包含工具内部的子 Agent Session。
- **回到原处继续工作**：复制经过安全转义的恢复命令，自动回到原工作目录，
  并沿用最后使用的模型。
- **阅读完整对话**：在独立详情页中查看 Markdown 渲染后的用户与 Agent 消息，
  支持浏览器前进和后退。
- **整理有价值的工作**：使用标记、名称、备注、状态和可恢复归档管理 Session。
- **查看 Session 血缘**：识别一个 Session 写出 Markdown/HTML 文件、另一个
  Session 接手的过程；悬停 Session 或文件即可聚焦直接上下游。
- **手动补全漏掉的血缘**：为当前 Session 添加上游；加错后可以取消。手动
  关系在刷新、重启和自动索引重建后仍会保留。
- **从终端自动化**：为其他 Agent 和脚本提供稳定的 JSON 输出。

## 快速开始

Agent Sessions 需要在 `PATH` 中安装
[ripgrep](https://github.com/BurntSushi/ripgrep)（`rg`）。

1. 从 [GitHub Releases](https://github.com/aswrise/agent-sessions/releases)
   下载与你的系统和架构匹配的文件。
2. 将文件改名为 `sessions`（Windows 为 `sessions.exe`）；Linux/macOS 还需
   添加执行权限，然后放入 `PATH`。
3. 启动 Dashboard：

```bash
sessions dash
```

正常情况下浏览器会自动打开；也可以手动访问 `http://127.0.0.1:7867/`。
Dashboard 只监听本机地址。

```bash
sessions dash --no-open  # 启动但不打开浏览器
sessions dash --stop     # 停止常驻 Dashboard
```

预构建的 x64 发布文件使用 Bun 标准 target，可能要求 CPU 支持 AVX2。较老的
Linux 或 Windows x64 CPU 请使用下文的 baseline 源码构建命令。

## 使用 Dashboard

### 查找并恢复 Session

使用 **普通** 检索名称、备注和首条消息；切换到 **深度** 并按 Enter，可检索
可读 Transcript 全文。还可以按工具、项目路径、更新/创建日期、大小和状态
进一步筛选。

点击表格行会复制恢复命令；点击 **查看** 可打开 Transcript 详情，再点击
**复制恢复命令**。按 `/` 可快速聚焦搜索框，按 `Esc` 可退出详情页。

![Dashboard 筛选](docs/dashboard-filters.png)

### 整理工作

- 点击 ☆ 标记重要 Session。
- 点击名称或备注单元格直接编辑。
- 设置 `todo`、`in progress`、`review`、`blocked`、`done` 等状态。
- 完成的工作可以归档；之后仍能从 **归档** 页签找回并恢复。

### 看懂 Session 血缘

打开 **关系图**，首次使用时点击 **开始分析**。Agent Sessions 会增量识别
Session 之间的文件交接，并按从上游到下游的方向排列。悬停 Session 或 FILE
卡片可聚焦相关路径；点击 Session 可查看它的 Transcript 和完整上下游链路。

如果自动分析漏掉了一次交接：

1. 打开下游 Session。
2. 点击 **补充上游**，选择对应的上游 Session。
3. 如果加错，在该手动上游旁点击 **取消关联**。

自动识别的 Artifact 关系保持只读；只有标记为 `MANUAL / 手动关联` 的关系
可以取消。

### 阅读 Transcript

详情页会把 Session 元信息、恢复操作、关系链和可读的 user/assistant 消息放在
一起，便于确认上下文后继续工作。

![Transcript 详情](docs/dashboard-detail.png)

## CLI 命令

Session ID 可以缩写为任意不重复的前缀。

| 命令 | 用途 |
| --- | --- |
| `sessions list -n 30` | 列出所有工具、所有项目中的最近 Session |
| `sessions list claude` | 只看 `claude`、`codex` 或 `pi` |
| `sessions find "关键词"` | 检索摘要和可读 Transcript 文本 |
| `sessions show 48e17d64` | 查看一个完整 Transcript |
| `sessions index` | 增量分析跨 Session 的文件交接 |
| `sessions lineage 48e17d64` | 查看完整上下游连通链 |
| `sessions star 48e17d64 "备注"` | 标记 Session，并可附带备注 |
| `sessions unstar 48e17d64` | 取消标记 |
| `sessions stars` | 列出所有已标记 Session |
| `sessions dash` | 启动或重新打开 Dashboard |

`list`、`find`、`show`、`index` 和 `lineage` 均可添加 `--json`，获得稳定的
机器可读输出。

## 本地数据与隐私

Agent Sessions 直接读取本地文件，不会上传 Transcript 数据。

| 工具 | Session 来源 |
| --- | --- |
| Claude Code | `~/.claude/projects/<路径-slug>/*.jsonl` |
| Codex | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` 及只读索引 |
| pi | `~/.pi/agent/sessions/<路径-slug>/*.jsonl` |

扫描、检索、详情和自动血缘分析不会修改源 Session。明确改名时会按各工具的
本地命名方式写入。标记、备注、状态和归档保存在 `stars.json`；
手动血缘保存在 `manual-lineages.json`；可随时重建的自动血缘缓存是
`lineage.sqlite`。POSIX 下这些文件位于
`~/.local/share/session-snapshots/`，原生 Windows 下位于平台本地应用数据
目录。

如果标注和手动血缘很重要，请备份 `stars.json` 和 `manual-lineages.json`；
`lineage.sqlite` 无需备份。

## 从源码构建

安装 Bun 1.3.14 和 `rg` 后执行：

```bash
bun install --frozen-lockfile
bun run compile
install -m 755 build/sessions ~/.local/bin/sessions
```

较老且不支持 AVX2 的 x64 CPU 可构建对应 baseline target：

```bash
bun scripts/compile.ts --target bun-linux-x64-baseline
bun scripts/compile.ts --target bun-windows-x64-baseline
```

如果只想在源码目录运行、不构建独立可执行文件：

```bash
bun install --frozen-lockfile
bun run build
./sessions dash
```

## 开发

```bash
bun run test                    # Bun seam 测试 + Vue DOM 测试
bun run typecheck               # vue-tsc --noEmit
bun run build                   # Vite 构建并内联资源
bun run compile                 # 构建当前主机独立可执行文件
bun scripts/real-data-check.ts  # 只读形状/数量检查，不输出 Transcript 文本
```

发布流程覆盖 Linux、macOS、Windows 的 x64 与 ARM64，生成 SHA-256 文件，
并明确记录哪些目标真正执行过烟测。
