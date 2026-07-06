# agent-sessions

跨路径检索 Claude Code / Codex / pi 的历史会话，单文件 Python 脚本，零第三方依赖（仅需 [ripgrep](https://github.com/BurntSushi/ripgrep)）。

[English](README.md)

解决的痛点：CLI agent 的 resume 只检索当前目录的会话，换个目录打开就"找不到之前的对话"。实际上对话全量存在本地磁盘，缺的只是一个跨路径的检索入口。

## 安装

```bash
cp sessions ~/.local/bin/ && chmod +x ~/.local/bin/sessions
# 依赖：python3（仅标准库）、ripgrep（rg）
```

## 用法

```bash
sessions list -n 30              # 最近会话，跨全路径、三工具混排
sessions list claude             # 只看某个工具（claude / codex / pi）
sessions find "关键词"            # rg 全文搜索全部历史
sessions star 48e17d64 备注       # 按 id 前缀标记重要会话
sessions unstar 48e17d64         # 取消标记
sessions stars                   # 列出已标记
sessions dash                    # 打开 dashboard（localhost 常驻服务）
sessions dash --stop             # 停止 dashboard 服务
```

每条结果带可直接复制的恢复命令（`claude -r` / `codex resume` / `pi --session`，Claude 与 pi 的 resume 需在原目录执行，命令里已带 `cd`）。

## Dashboard

![dashboard](docs/dashboard.png)

`sessions dash` 在 `localhost:7867` 起一个常驻微服务（python stdlib `http.server`）：

- 名称列：Claude 的 `/rename` 手动命名 > AI 自动标题；pi 的 `--name`
- 页内点 ★ 标记 / 点备注列编辑（两者互相独立），POST 回写 `stars.json`，与命令行共用数据
- 页内改名：Claude 往 jsonl 追加 `custom-title` 记录（与 `/rename` 同机制，Claude Code 本体可见）；pi 改写首行 `name`；Codex 上游无 thread name 存储，改名仅本工具可见
- 垃圾 session 可归档（默认所有视图不再出现，“已归档”视图可查看并解除归档）
- 每个 session 可设状态（todo / in progress / blocked / done，默认无），支持按状态筛选
- 筛选可叠加：关键词、工具、路径（带计数下拉）、更新/创建时间范围、大小范围
- 模型列：从会话文件尾部提取最后使用的模型，恢复命令自动带上（`claude -r <id> --model <m>` / `codex resume <id> -m <m>` / `pi --session <id> --model <m>`）
- 点击行复制恢复命令；列宽可拖拽（localStorage 记忆）；深浅主题切换
- 数据 30 秒缓存，"刷新"按钮强制重扫

样式基于 [refero styles](https://styles.refero.design/) 的 Linear（midnight precision instrument）DESIGN.md。

## 数据源

| 工具 | 路径 | 说明 |
|---|---|---|
| Claude Code | `~/.claude/projects/<路径slug>/*.jsonl` | 名称取 jsonl 内 `custom-title` / `ai-title` 记录 |
| Codex | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` | 首行 `session_meta` |
| pi | `~/.pi/agent/sessions/<路径slug>/*.jsonl` | 首行 `type=session` |

扫描只读；唯一写入会话文件的操作是改名（Claude 追加 jsonl 记录 / pi 改写首行）。标记与备注数据写在 `~/.local/share/session-snapshots/stars.json`。

注意：Claude Code 默认 30 天清理会话（`cleanupPeriodDays`），想长期保留需在 `~/.claude/settings.json` 调大。

## 跨平台

Linux / WSL / macOS。打开浏览器自动探测（WSL 用 `explorer.exe`，macOS 用 `open`，其余 `xdg-open`）。

已知坑：`~/.claude/.gitignore` 会让 rg 静默跳过整个子树，脚本内所有 rg 调用都带了 `--no-ignore --hidden`。
