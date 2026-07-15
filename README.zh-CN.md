# agent-sessions

跨项目目录检索 Claude Code、Codex 和 pi 的 Session 历史。CLI 与 localhost
dashboard 由一个 Bun 可执行文件提供，Vue 页面已内嵌；唯一外部运行时依赖是
[ripgrep](https://github.com/BurntSushi/ripgrep)。

[English](README.md)

## 安装

从 GitHub Releases 下载对应系统和架构的文件，改名为 `sessions`（Windows 为
`sessions.exe`）并放入 `PATH`。发布目标覆盖 Linux、macOS、Windows 的 x64
与 ARM64。
标准 x64 文件沿用 Bun 的标准 target，需要 CPU 支持 AVX2；更老的 x64 CPU
需要另行构建带 `-baseline` 的 target。

从源码构建需安装 Bun 1.3.14 和 `rg`：

```bash
bun install --frozen-lockfile
bun run compile
install -m 755 build/sessions ~/.local/bin/sessions
```

## 用法

```bash
sessions list -n 30              # 跨工具、跨路径列出最近 Session
sessions list claude             # 只看 claude / codex / pi
sessions find "关键词"           # 通过 rg 全文搜索
sessions star 48e17d64 备注       # 按 id 前缀标记
sessions unstar 48e17d64
sessions stars
sessions dash                    # 启动/打开 localhost 常驻 dashboard
sessions dash --stop
```

恢复命令保留原工作目录和最后使用的模型。POSIX 系统输出安全转义的 shell
命令；原生 Windows 输出安全转义的 PowerShell 命令。

## Dashboard

### Session 总览

![Session dashboard 总览](docs/dashboard.png)

### 筛选和状态

![展开后的筛选和状态](docs/dashboard-filters.png)

### Transcript 详情

![Transcript 详情](docs/dashboard-detail.png)

Dashboard 仅绑定 `127.0.0.1:7867`，保留以下行为：

- 全部/工具/已标记/已归档视图，关键词、路径、日期、大小、状态筛选，可排序
  列、每页 100 行和强制刷新；
- 点击行复制恢复命令，query-string Transcript 详情与前进/后退，悬浮预览，
  主题和列宽本地记忆；
- 页内标记、备注、名称、状态、归档操作，失败时保留原值并可重试；
- Claude 追加 `/rename` 记录、pi 改首行名称、Codex 仅保存本工具 override；
- 减少动态、减少透明度、高对比度和键盘操作适配。

生命周期状态包含经校验的 pid、端口和随机 nonce。启动/停止只信任回显该
nonce 的普通 GET 健康响应，不会接管占用端口的无关进程。

## 数据与隐私

| 工具 | Session 来源 |
| --- | --- |
| Claude Code | `~/.claude/projects/<路径-slug>/*.jsonl` |
| Codex | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` 及只读索引 |
| pi | `~/.pi/agent/sessions/<路径-slug>/*.jsonl` |

扫描、搜索、列表、详情和刷新均只读；只有明确改名会写 Session 文件。
`stars.json` 保持兼容：POSIX 位于 `~/.local/share/session-snapshots/`，原生
Windows 位于平台本地应用数据目录。

## 启动 Dashboard

根据安装方式选择对应命令：

```bash
# 已安装到 PATH 的可执行文件
sessions dash

# 从源码构建的独立可执行文件
./build/sessions dash

# 源码目录直接启动（首次启动前先构建内嵌页面）
bun install --frozen-lockfile
bun run build
./sessions dash
```

前两种方式要求对应的可执行文件已经存在。源码方式首次启动前需要先执行
构建命令。如果浏览器没有自动打开，可访问 `http://127.0.0.1:7867/`。使用
`sessions dash --no-open`（或将 `sessions` 替换为上面的其他命令）可禁止自动
打开浏览器，使用 `sessions dash --stop` 可停止常驻 Dashboard。只有需要构建
独立可执行文件时才需要执行 `bun run compile`。

## 开发

```bash
bun run test                    # Bun seam 测试 + Vue DOM 测试
bun run typecheck               # vue-tsc --noEmit
bun run build                   # Vite 构建并内联资源
bun run compile                 # 构建当前主机可执行文件
bun scripts/real-data-check.ts  # 只读形状/数量检查，不输出 Transcript 文本
```

Tag 构建生成六个目标及 SHA-256，运行宿主 x64 烟测，并附带明确的验证状态。
ARM64 交叉构建在原生或等效 runner 验证前保持 `executed: false`，不会被误报
为已执行。
