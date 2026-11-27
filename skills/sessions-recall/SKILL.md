---
name: sessions-recall
description: 用 agent-sessions 的 `sessions` CLI 回忆过去的 Claude Code、Codex、pi、Antigravity 会话内容并引用。Use when 用户提到之前/上次/那个会话、问某事以前怎么做或决定过什么、要接着之前的工作，或你准备断言「以前没做过/没讨论过」。
---

# Sessions recall

`sessions` CLI 覆盖 `--tool` 列出的全部工具、所有项目和已登记的归档，正文、工具调用与输出、子 agent 都在检索范围内。参数以 `sessions --help` 为准。

0. **确认可用**。`command -v sessions` 找不到时，告诉用户按 agent-sessions 仓库 README 的「Build from source」安装，不要改用零散 grep 下「没讨论过」的结论。结果和预期不符（比如某种会话格式搜不到）时，先比对二进制的修改时间和仓库最新提交，本机二进制可能过旧；重装用 README 里的 `install -m 755`，不要 `cp` 覆盖正在使用的文件。

1. **搜**。每个参数是一个词，全部命中才算（AND）；短语加引号。先窄后宽：

       sessions find <词>... --since 14d --cwd .

   0 命中依次去掉 `--cwd`、`--since`，再换同义词。完成标准：要么拿到候选，要么无过滤搜索仍为 0 且头部 coverage 的孤儿数为 0。只有后者才能说「没讨论过」；孤儿数非 0 时用 `rg -n <词> <列出的路径>` 看完再下结论。在 shell 循环里传多个词时逐个传参，zsh 不会拆分未加引号的 `$q`，整串会被当成一个短语。

2. **挑**。结果已按相关度分档，`★` 是标题或用户消息提到过的会话，从它开始。命中计数 `u a th call out sub` 分别是用户、助手、思考、工具调用、工具输出、子 agent；只有 `call/out` 的会话多半只是跑过相关命令。

3. **读窗口**。只读命中附近，整段 `show <id>` 留给真的需要通读的情况：

       sessions show <id> <词>...            命中窗口
       sessions show <id> --at <n>-<m>       按序号扩窗口
       sessions show <id> --at <子线程>:<n>   进子 agent

   完成标准：简报里每条结论都落在读过的窗口上。

4. **写简报**。目标、决策、未结事项、用户纠正、产出路径，每条引用 `<id>#<序号>`。涉及「现在是什么状态」的结论，用 git 或文件现场核对后再写。

要读的会话超过 3 个时，每个会话交给一个便宜子 agent 执行第 3–4 步，主线程只收简报。`--json` 给脚本用，文本输出更省 token。调用方会话（能从环境变量识别时）默认被排除，需要时加 `--self`。
