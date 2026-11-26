---
name: find-recall
description: 校验 `SessionCatalog.find` 的召回承诺：含全部词的 Session 不漏，看不了的文件计入 coverage。Use when 改动 src/catalog.ts 的 find/children/childIndex/适配器 project/events/history、src/search.ts 的 tally/verdicts，或 Codex/Claude/pi 的会话格式解析之后。
---

# find 召回校验

**性质。** 对任意会话目录和任意词组，`find` 返回的恰好是可读事件里含全部词的 Session；原文命中但没成为结果的文件，全部落进 coverage 的某个桶（orphan、injected_only、partial、unclassified、unreadable），并且 `candidate_files` 等于这些桶与结果文件之和。

**破了会怎样。** agent 用 `sessions find` 判断「以前做过没有」。漏掉一个 Session 不报错也不计数，agent 就会断言一件做过的事没做过。

## 工具与边界

这是对真实代码的生成输入检查，不是模型检查：TypeScript/Bun 没有能直接跑在源码上的验证器，所以 `tests/recall.test.ts` 用带 seed 的伪随机生成器造会话目录，跑真实的 `SessionCatalog.find`，再和逐文件子串扫描得到的 oracle 比较。

每个 seed 生成 10 个 Session（claude、codex、pi 随机），每个 Session 2–7 条记录，记录类型随机取 user、assistant、thinking、工具调用、工具输出、注入文本、噪音记录；附带 0–2 个子线程（Claude subagent、Claude tool-results 文件、Codex 子线程，30% 父不存在成为孤儿），30% 的 Codex Session 带一个 `history_base` 旧分段（旧分段自身也是 Session），15% 的子线程文件不可读（chmod 0）。词表含引号、反斜杠、中文和大小写变体。每个 seed 查 6 组词，每组 1–3 个词。

不覆盖：`--since/--until/--cwd/--tool/--self` 过滤、归档来源（sources.json）、超过 128 个文件的分批、子线程链成环、排序与 tier、`excerpt` 窗口、`.jsonl.zst` 压缩会话（含 `rg -z` 的 broken pipe 与缺少 zstd 程序时的进程内回退）。这些由 `tests/catalog.test.ts` 的定点用例负责。

## 运行

```sh
bun test tests/recall.test.ts                                        # 6 个 seed，约 0.3 秒，每次相关改动都跑
RECALL_SEEDS=300 bun test --timeout 600000 tests/recall.test.ts      # 深度运行，约 50 秒，改动 find 主流程或适配器格式时跑
RECALL_FROM=292 RECALL_SEEDS=292 bun test tests/recall.test.ts       # 复现单个 seed
```

Bun 版本以 `package.json` 的 `packageManager` 为准。

## 读结果

失败信息形如 `seed 4 terms ["zeta7"]`，后面是期望与实际的 coverage/results 差异。把它翻译成代码的话，再判断谁错：

- **代码错（真 bug）**：生成器写进去的记录按设计应该被看到或被计数，`find` 却没有。用 `RECALL_FROM` 复现，再把那个 seed 的目录结构打印出来（生成器 `generate(seed)` 返回 home 路径），定位是哪类文件。不要为了让它通过去改 oracle。
- **oracle 错（建模错误）**：设计本身变了，比如新增一个 coverage 桶、改了判定单位。先改 `plans/2026-11-16-cli-recall.md` 的设计，再让 oracle 按设计推出期望，最后才看代码。oracle 的期望必须从设计推出，不能抄 `verdicts()` 的实现。
- **环境错**：`EBADF`、超时这类和断言无关的失败，先查资源（`/dev/fd` 数量）和超时参数。深度运行曾经因为 `readHeadLines(...).next()` 不关文件句柄而在约 1750 次 find 后 `EBADF`，那是真 bug，已由 `headLine()` 修复。

## 已证明它能失败

在当时的代码上，下列破坏各自让检查失败，恢复后通过：

| 破坏 | 失败位置 |
|---|---|
| 不投影 Claude `tool_result` | seed 1 `["zeta7","Kappa3"]`，结果缺 Session |
| 不投影 Codex `CommandExecution` | seed 3 `["quux9"]` |
| 注入文本当作真实命中 | seed 1 |
| 不扫子线程 | seed 1 |
| 不可读的 Codex 子线程既不计入结果也不计入 coverage（修复前的真实代码） | seed 4 `["zeta7"]`，`unreadable_files` 期望 1 实际 0 |
| `segments()` 用 `.next()` 读首行（修复前的真实代码） | 深度运行约 seed 292 后 `EBADF` |
| `find` 里 unreadable 判定的线程不计数 | seed 1 `["召回词"]`，`unreadable_files` 期望 1 实际 0 |

## 覆盖记录

同步 commit：`c49c243`。校验描述的是这个 commit 上的下列代码：

- `src/catalog.ts`：`SessionCatalog.find`、`childIndex`、`mainFiles`、`mainEvents`、`grepTerms`、`headLine`、`readHeadLines`、各适配器的 `project`、`events`、`childEvents`、`children`、`history`/`segments`。
- `src/search.ts`：`parseTerms`、`rgPatterns`、`tally`、`verdicts`、`metaHits`。

改动上面任何一处后：跑默认检查；改动涉及判定规则或文件归属时跑深度检查。确认生成器和 oracle 仍然描述新代码（新的记录类型、新的子线程形态、新的 coverage 桶都要加进生成器），之后才把同步 commit 改成新的 commit。生成器没跟上的新格式，就是这项检查覆盖不到的盲区。
