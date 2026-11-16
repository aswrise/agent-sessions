# CLI 会话召回：find 不漏、show 只读命中窗口

agent 在终端参考过去的 Session 时，用 `sessions find` 一次拿到排好序、不漏的候选，再用 `sessions show <id> <词>` 只读命中附近的窗口。
目标是在速度、召回和主线程 token 上对标或超过 pstack `/recall`。

## 问题

`SessionCatalog.find()` 的第 3 步要求 rg 命中的关键词也出现在 `transcript()` 的 user/assistant 文本里。
工具调用、工具输出、路径都不算，子会话文件（Claude `subagents/`、Codex 子线程）根本不扫。
2026-11-16 实测：`launchctl` 原文命中 10 个 live 文件，`find` 返回 0；`ModuleNotFoundError` 14 对 1。
命中行的记录类型直方图里，user/assistant 文本只占少数，其余是 Claude `tool_use`/`tool_result`、Codex `custom_tool_call(_output)` 与 `event_msg` 的 `item_completed`（`CommandExecution`、`McpToolCall`）。
另外 `show` 只能整段输出（中等 Session 22K 字符起），每次调用还往 stderr 打约 4–7K 字符的来源统计。

## 设计

### 核心数据：每个线程文件一条事件流

```ts
// src/contracts.ts（只增不改）
export const EVENT_KINDS = ["user", "assistant", "thinking", "tool_call", "tool_output"] as const;
export type EventKind = (typeof EVENT_KINDS)[number];
export type MatchKind = EventKind | "meta";

export interface SessionEvent {
  ordinal: number;   // 在所属线程完整事件流中的序号，0 起，工具事件也占序号
  kind: EventKind;
  text: string;      // excerpt 输出时已裁剪
  tool?: string;     // tool_call / tool_output 的工具名
  timestamp: string;
}
```

适配器内部（不导出）：

```ts
type RawEvent = { kind: EventKind; text: string; tool?: string; timestamp: string; injected?: true };
interface Adapter {
  // transcript(id, path) 删除，由下面两个替代
  /** 单条 JSONL 记录 → 0..n 个事件。纯函数，是唯一了解各工具线上格式的地方。 */
  project(record: Json): Omit<RawEvent, "timestamp">[];
  /** 一个线程文件的有序事件。Codex 保留 history_base 拼接。 */
  events(id: string, path?: string): RawEvent[];
  /** 本 root 下的子线程文件及其直接父 id。不受 MIN_SIZE 限制。 */
  children(): ChildFile[];
}
type ChildFile =
  | { kind: "agent"; path: string; thread: string; label: string; parentOriginalId?: string }
  | { kind: "tool_result_file"; path: string; thread: string; parentOriginalId: string }; // 纯文本，序号是行号
const transcriptOf = (events: RawEvent[]): TranscriptMessage[] => /* kind user|assistant 且非 injected */;
```

`detail()` 改为 `transcriptOf(events)`，输出必须与现在逐字节一致（现有 Python oracle 测试守护）。

各来源的投影规则：

| 来源 | user / assistant | thinking | tool_call | tool_output | 子线程文件 |
|---|---|---|---|---|---|
| Claude | 现有规则（`message.content` 文本块，无 `toolUseResult` 的记录） | `thinking` 块可读文本 | `tool_use` 块：`<name>: <输入的字符串叶子，逐行 key: value>` | user 记录里的 `tool_result` 块（字符串或文本 part） | `<proj>/<uuid>/subagents/**/agent-*.jsonl`（label 取同名 `.meta.json` 的 `description`，退回 `agentType`）；`<proj>/<uuid>/tool-results/*.txt`；归档里的旧式 `<proj>/agent-*.jsonl`（父 = 首条记录 `sessionId`） |
| Codex | 现有规则（`response_item` message） | 无（reasoning 加密） | `function_call` / `custom_tool_call` / `local_shell_call` | 对应的 `*_output`；`event_msg` 的 `item_completed` 里 `CommandExecution`（command + aggregated_output）、`McpToolCall`、`FileChange` | 首行 payload 有 `parent_thread_id` 的文件，label 取 `agent_nickname` 或 `agent_path` |
| pi | `message` user/assistant | `thinking` part | assistant `toolCall` part | `role: "toolResult"` | 无 |

刻意不投影（只在这里命中的文件计入 `unclassified_files`）：Claude `api-request-blob`、`attachment`、`queue-operation`；Codex `world_state`、`compacted`、`event_msg` 的 `AgentMessage`（重复 `response_item`）、加密 reasoning。
`skipTranscript` 判定的注入类 user 记录以 `injected: true` 产出，不参与 AND 与排序，单独计数。

### Catalog 公共面：`find` 换参数，新增 `excerpt`

```ts
export interface SessionQuery {
  terms: string[];        // AND；每项是不区分大小写的字面子串
  since?: number;         // epoch 秒；Session 的 [birth, mtime] 与 [since, until] 有交集即通过
  until?: number;
  tools?: Tool[];
  cwd?: string;           // 绝对路径；row.cwd 等于它或在它之下
  exclude?: string[];     // 排除的 Session id（调用者自身）
}

export type SearchHit =
  | { kind: "meta"; field: "name" | "star_note" | "first_msg" | "id" | "session_id" | "source_path"; snippet: string }
  | { kind: EventKind; thread: string; ordinal: number; tool?: string; snippet: string }; // thread "main" 或子线程 id

export interface MatchSummary {
  tier: 1 | 2 | 3;                    // 1: name/star_note/first_msg/非注入 user 命中；2: 仅 assistant；3: 其余（thinking、工具、子线程、id/path 字段）
  counts: Record<MatchKind, number>;  // 主线程 + meta
  threads: { thread: string; label: string; hits: number }[]; // 有命中的子线程
  best: SearchHit[];                  // 至多 3 条，最佳在前
}

export interface SearchCoverage {
  scanned_files: number;
  candidate_files: number;            // 通过逐词 rg 交集、被解析的文件
  unclassified_files: number;         // 解析后没有任何事件命中
  injected_only_files: number;
  orphan_files: number;               // 子线程命中但追溯不到任何 row
  orphans: { path: string; label: string; hits: number }[]; // 前 5 个
}

class SessionCatalog {
  find(query: SessionQuery, limit = 20): Promise<{ total: number; results: (Session & { snippet: string; match: MatchSummary })[]; coverage: SearchCoverage }>;
  excerpt(id: string, spec:
    | { around: string[]; context?: number; chars?: number; windows?: number }   // 任一词命中即为 hit
    | { at: { thread?: string; from: number; to: number }; context?: number; chars?: number }
  ): Promise<Session & { threads: { thread: string; label: string; events: number; hits: number[] }[]; windows: { thread: string; label: string; from: number; to: number; hits: number[]; events: SessionEvent[] }[]; omitted_windows: number }>;
}
```

`find` 的召回不变量：扫描范围内每个 rg 命中的文件，要么归到某个结果，要么计入 `unclassified_files`、`injected_only_files` 或 `orphan_files`。不存在静默丢弃。

`find` 流程：
1. `rows = list({ fresh: true })` 按 since/until/tools/cwd/exclude 过滤。
2. `files = rows 的 source_path ∪ 这些 row 的子线程文件 ∪ 孤儿子线程文件`（孤儿按自身 mtime 与首行 cwd 过滤）。子线程链（子的父仍是子）向上追溯到 row，带环保护。
3. 每个词并行跑 `rg -i -F -l`（每批 128 路径，最多 8 个进程），pattern 为词本身与其 JSON 转义。按 row 求 AND（meta 字段命中也算）。
4. 只解析幸存 row 的命中文件：`events()` → 逐事件统计 kind 计数、命中词集合、最佳片段。
5. 在已分类命中上复核 AND，得到 `MatchSummary`。
6. 按 `(tier, compareSessions)` 排序，截断到 limit，统计 coverage。

HTTP `/api/search` 调用 `find({ terms: [q] }, limit)`，dash 的短语语义不变；响应只增加 `match`、`coverage` 字段，`parseSearchEnvelope` 与 `App.vue` 不改。

### CLI

```
sessions find <词>... [--since 7d|24h|2026-11-01] [--until ...] [--tool claude,codex,pi] [--cwd <path>] [--self] [-n 20] [--json]
sessions show <id前缀> [--json]                                   整段 Transcript（不变）
sessions show <id前缀> <词>... [-C 2] [--chars 300] [-n 8] [--json] 命中窗口
sessions show <id前缀> --at [<thread>:]<n>[-<m>] [-C 0] [--chars 300] [--json]
全局：-v  打印全部来源诊断（默认只打 level=error）；任意位置的 -h/--help 打印帮助
```

- 默认排除调用者自身：读环境变量 `CLAUDE_CODE_SESSION_ID`，`--self` 关闭排除。
- `find` 文本输出每个 Session 两行：最短唯一 id 前缀（至少 8 位）、工具、时间、cwd、标题；第二行是按 kind 的命中计数（`u a th call out sub`）和最佳命中（`#ordinal kind [thread]` + 片段）。tier 1 行首标 `★`。头部一行带 coverage 摘要；`orphan_files > 0` 时列出孤儿路径。不打印 resume 命令（`--json` 与 `show` 里有）。
- `show` 窗口：每个窗口一行 `── <thread> #from-to`，每个事件一行 `#n kind [tool]` 加裁剪后的文本（以第一个命中为中心，`--chars 0` 不裁剪），超长时标注原长度。末尾报告未显示的窗口数。

### Agent 指南

`~/.agents/skills/sessions-recall/SKILL.md`，软链到 `~/.claude/skills/sessions-recall`：
1. 先窄后宽地搜：`sessions find <词>... --since 14d --cwd .`；0 命中依次去掉 `--cwd`、`--since`。无过滤仍为 0 且没有孤儿命中，才能说「没讨论过」。
2. 读排序结果，从 `★` 开始。
3. 只读窗口：`sessions show <id> <词>`，需要时 `--at` 扩窗口或进子线程。
4. 写简报：目标、决策、未结事项、用户纠正、产出路径，每条引用 `<id>#<ordinal>`；涉及现状先用 git 核对。
5. 超过 3 个 Session 要读时，每个 Session 交给一个便宜子 agent 执行第 3–4 步，主线程只收简报。
6. `--json` 只给脚本用，文本输出更省。

### 不做的

不建持久索引（rg 并行扫 live 库 0.42s，索引的陈旧就是静默漏召回）；不支持 OR 与正则；子线程不成为 row（`list`、lineage、dash 表格不变）；HTTP 不加过滤参数。

## 合成说明

- 两个候选（opus、fable）收敛到同一骨架：事件流投影、以类型化命中位置替换第 3 步、子线程按文件汇总到父 Session、`excerpt` 窗口读取、`sessions-recall` 指南、stderr 默认静默。按 arena 规则直接采用一致骨架。
- 基底取 opus：完整的 coverage 计数、三档 tier、`injected` 标记、Codex `item_completed` 与 Claude `tool-results/*.txt` 的投影事实（直方图实测）。
- 嫁接自 fable：`find` 保留名字只换参数（CLI 命令本来就叫 find）；catalog 接收 `terms[]`，HTTP 传 `[q]` 保住 dash 的短语语义；`--until`；`project(record)` 纯函数作为适配器唯一的格式知识；`CLAUDE_CODE_SESSION_ID` 排除调用者自身；`--chars` 与窗口数上限。
- 未采纳：fable 的「rg --json 只解析命中行」（要流式处理上百 MB 输出，并且 find 结果给不出 ordinal）；opus 的 HTTP 过滤参数（dash 不用）。
- cross-judge 未派：候选高度一致，且超出用户批准的 agent 数。

## 验收

- 现有测试全部通过；`detail()` 在夹具上逐字节不变。
- 新夹具：Claude `subagents/agent-*.jsonl` + `.meta.json`、`tool-results/*.txt`、带 `parent_thread_id` 的 Codex 子线程、各工具一个仅工具命中的 Session、父子分摊的双词 AND、注入文本命中。
- 召回性质测试：对随机生成的夹具 HOME 与随机词，`find` 结果 ∪ coverage 计数覆盖朴素扫描（逐文件子串）找到的全部文件，且每个结果确实含全部词。
- CLI：stderr 默认无来源统计；`find --help` 打印帮助；`show <id> <词>` 与 `--at` 输出窗口。
- 真实数据：`launchctl`、`ModuleNotFoundError`、`installed.json`、`herdr_task` 的结果数加 coverage 计数与原文命中文件数对得上；记录耗时与输出字符数。

## 实现对账

与上面设计不一致或设计没写到的地方：

- 适配器接口多了三处。`childEvents(path)` 读子线程文件：Claude 子 agent 文件每条记录都带 `isSidechain`，只有主文件才丢弃这类记录。`childLabel(file)` 按需读 `.meta.json`，只给要显示的子线程读，2000 多个归档子 agent 不再逐个打开。`children(rows)` 接收已知主文件路径，Codex 不再读主文件的头部；子线程归属在真实数据上从约 500ms 降到约 170ms。
- `ChildFile` 的 `tool_result_file` 也带 `label`（文件名）。它的事件序号是 0 起的行下标，不是 1 起的行号。
- `SessionEvent` 多了可选的 `length`：被裁剪时记原长，CLI 用它标「原长 N」。
- coverage 按 owner（row 或孤儿文件）的结果计文件。owner 的逐词 rg 求交成立，但已分类事件凑不齐全部词时：加上注入事件能凑齐，它的全部候选文件计入 `injected_only_files`，否则计入 `unclassified_files`。所以 `unclassified_files` 也包含有部分事件命中的文件。恒等式 `candidate_files = 归入结果的候选文件 + orphan_files + injected_only_files + unclassified_files` 由性质测试守护。
- Codex `item_completed` 里的 `UserMessage` 与 `AgentMessage` 一样重复 `response_item`，不投影。`Extension`、`SubAgentActivity`、`CollabAgentToolCall`、`ImageView`、`Reasoning` 也不投影，命中只在这些地方的文件计入 `unclassified_files`。
- `project()` 逐条记录，没有 call_id 配对，所以 Claude `tool_result`、Codex `*_output` 的事件没有工具名。`CommandExecution` 记为 `command`，`FileChange` 记为 `file_change`，MCP 记为 `server.tool`。Codex `function_call` 保留原始 arguments 字符串，不拆成叶子，带 JSON 标点的词也能分类。Claude 与 pi 的工具输入拆成 `key: value` 叶子，数字和布尔值也算。
- `find` 解析单个文件失败时（例如 Codex history_base 的基线文件缺失），这个文件按 owner 结果计数，整次搜索不报错。
- `excerpt` 里命中外的上下文事件裁到 `min(chars, 120)`；`--at` 的线程名接受唯一前缀。`ExcerptSpec`、`Excerpt`、`SessionQuery` 从 `src/catalog.ts` 导出，不在 `contracts.ts`。纯匹配逻辑（词解析、片段、窗口合并、裁剪、最佳命中）放在新文件 `src/search.ts`。
- 设了 `--cwd` 时孤儿按头部 `cwd` 过滤。没有 `cwd` 的孤儿（Claude `tool-results/*.txt`）会被过滤掉。
- 归档 Codex 里只靠 SQLite 判定为子线程、头部没有 `parent_thread_id` 的文件，计为孤儿。
- 候选文件整文件读入再投影，内存上限按单个文件算，没有流式解析。rg 只输出 `-l` 路径，按批收集。
- 工具调用多的 Session，`show <id> <词>` 可能比整段 `show` 还大：实测 `01a1cc0e` 的 `launchctl` 窗口 9.0K 字符，整段 Transcript 6.4K。窗口里有 Transcript 不含的工具证据（14 处命中）。

真实数据（2026-11-16，编译后的 `build/sessions`，真实 HOME，第二次运行计时；默认结果排除了调用者自己的 Session，`--self` 一列包含它）：

| 词 | find 结果数（默认 / --self） | coverage：扫描 / 候选 / 未归类 / 仅注入 / 孤儿 | 耗时 | stdout / stderr 字节 | 旧 find：结果数、耗时、stdout / stderr 字节 |
|---|---|---|---|---|---|
| launchctl | 10 / 11 | 7683 / 11 / 0 / 0 / 1 | 1.95s | 2856 / 0 | 1，1.84s，387 / 3809 |
| ModuleNotFoundError | 39 / 40 | 7683 / 41 / 0 / 0 / 0 | 2.24s | 4734 / 0 | 1，2.14s，499 / 3809 |
| installed.json | 5 / 6 | 7683 / 5 / 0 / 0 / 0 | 2.01s | 1252 / 0 | 1，1.79s，468 / 3809 |
| herdr_task | 3 / 4 | 7683 / 3 / 0 / 0 / 0 | 1.78s | 958 / 0 | 2，1.96s，917 / 3809 |

`find launchctl --since 14d` 耗时 0.68s。`show 0cfeba3f launchctl` 输出 1136 字符，整段 `show` 7588 字符。
