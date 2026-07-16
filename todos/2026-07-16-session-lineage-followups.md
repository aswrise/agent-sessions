# Session 关系链识别与入口体验待办

- **日期**：2026-07-16
- **类型**：bug / 调研 / 需求
- **模块**：agent-sessions / lineage
- **状态**：未解决
- **环境**：本地 Dashboard，`http://127.0.0.1:7867/`

## 描述

Session 关系链功能还有三项未实施事项，统一在本文件跟踪：

1. 修正 Codex Goal 作为 user consumer 时的漏链。
2. 讨论并设计首页 Session 列表中的“有关系链”状态表示。
3. 讨论并设计从单个 Session 悬浮预览整条关系链的入口与展现形式。

后两项先完成设计讨论，不预设具体 UI，不在设计确认前实施。

## TODO 1：Codex Goal 漏链

### 现象

以下两个 Session 应通过同一个 PRD Artifact 建立上游到下游的关系，但当前查询只返回上游自身和 0 条边：

- 上游：`019f6903-cdfe-7801-9a02-fa22bcd8b209`
- 下游：`019f6a53-24ad-7fa0-b96d-6e457d8df307`
- Artifact：`/home/aquas/project1/.claude/scratch/ops-instance-failure-context/PRD.md`

### 根因

上游 assistant 在最后 3 个有效轮次内成功更新了该 PRD，路径和时间条件均满足。下游的首个任务输入只存在于 `thread_goal_updated.goal.objective`：

```text
$implement /home/aquas/project1/.claude/scratch/ops-instance-failure-context/PRD.md , $implementation-notes
```

当前索引版本 2 将 Codex Goal 整体排除，导致下游没有写入 `lineage_references`。Goal objective 明确是 user-provided task input，应当作为 user consumer，而不是作为 assistant 或系统输入排除。

### 实施方案

- 在 `src/lineage.ts` 的 Codex 轮次提取中，将 `thread_goal_updated.goal.objective` 作为一个 user 输入计入消费者前 2 轮。
- 生成的边继续统一使用 `reference_source=user`，不要恢复独立的 `goal` 来源类型。
- 同一个 objective 的重复 Goal 状态更新不能重复计轮。
- `<codex_internal_context source="goal">` 是 objective 的内部回显，不能再计一个 user 轮次。
- assistant、developer、system、tool result 和第 3 个及后续 user 轮次仍不得作为 consumer。
- 提取规则变化后将 `INDEX_VERSION` 从 2 升到 3，触发派生缓存重建。
- 用最小测试固定“Goal objective 能连边、Goal 回显不重复、assistant 引用不连边、第三轮 user 引用不连边”。

### 验证方式

- `bun test tests/lineage.test.ts`
- `bun run typecheck`
- `./sessions index --rebuild --json`
- `./sessions lineage 019f6903 --json` 必须包含下游 `019f6a53-24ad-7fa0-b96d-6e457d8df307`。
- 目标边必须使用上述 PRD 路径，且 `reference_source=user`、`reference_turn=0`。

## TODO 2：首页列表显示关系链状态（待讨论设计）

### 需求

首页 Session 列表中，如果某个 Session 属于任意关系链，应在该 Session 行内直接看出“有链”。没有关系链的 Session 不显示该状态。

### 待讨论问题

- 状态是只表达“有链”，还是同时表达起点/中游/下游、直接上下游数量或整链 Session 数量。
- 使用独立列、名称旁图标、徽标还是其他形式，如何避免进一步增加当前表格的信息密度。
- 是否支持按“有链”筛选或排序；如果支持，入口放在哪里。
- 深色/浅色主题下如何保持辨识度，同时不能只依赖颜色表达状态。
- 点击状态后是打开 Session 详情、定位全局 DAG，还是直接展开链预览。

### 实施方案

先产出一个最小交互方案并确认，再修改代码。优先复用已有 `/api/lineages` 缓存结果和当前列表数据，不为每一行单独请求关系链，也不在列表加载时重新分析索引。

### 验证方式

- 有链 Session 与无链 Session 在列表中可稳定区分。
- 状态对鼠标、键盘和屏幕阅读器都可理解，不能只靠颜色。
- 1900+ Session 数据量下不产生逐行网络请求或明显列表性能回退。
- 与现有星标、状态、名称、备注、详情入口不冲突。

## TODO 3：悬浮预览 Session 所在整条链（待讨论设计）

### 需求

每个有链 Session 都应提供一个可悬浮的入口，快速预览该 Session 所在的完整连通关系链，而不是只看直接上游或下游一层。预览中需要明确当前 Session 的位置。

### 待讨论问题

- 悬浮入口复用 TODO 2 的链状态，还是整行/名称区域；避免和现有首条消息 Transcript 悬浮预览抢占同一个浮层。
- 小链可否直接显示紧凑 DAG；大链如何处理缩放、滚动、摘要或分层，不能把 58 个节点压成不可读缩略图。
- 预览是 hover card、popover、侧边浮层还是其他形式；鼠标离开时如何保持可进入和可操作。
- 键盘 focus、触屏和 reduced-motion 下使用什么等价入口。
- 点击节点后是打开 Session 详情、定位全局 DAG，还是固定预览状态。

### 实施方案

设计确认前不实施。方案应复用持久缓存和完整连通分量查询，不触发重新分析；优先复用 `src/LineageGraph.vue` 的稳定布局数据，但预览尺寸和大链降级策略需要单独定义。动效只服务于浮层来源和状态变化，不使用持续力导向运动。

### 验证方式

- 悬浮或键盘 focus 有链 Session 时能看到整条链，并突出当前 Session。
- 无链 Session 不触发空预览。
- 大链不会溢出视口、遮死页面或出现不可读的节点/边重叠。
- 快速移入移出不会闪烁、重复请求或重启动画。
- 关闭 motion 后仍保留必要的显隐反馈和完整操作能力。

## 相关代码

- `src/lineage.ts`：Codex Goal、user 轮次和写入事实提取。
- `src/catalog.ts`：全局及单 Session 关系链查询边界。
- `src/App.vue`：首页 Session 列表、现有 Transcript 悬浮预览和关系图入口。
- `src/LineageGraph.vue`：完整关系链 DAG 布局与节点交互。
- `tests/lineage.test.ts`：关系识别规则回归测试。
- `tests/App.vitest.ts`：列表及关系链 UI 回归测试。

## 完成后

任务完成后执行以下操作标记为已解决：
1. 将本文件 `**状态**` 改为 `已完成（YYYY-MM-DD）`
2. 重命名：`2026-07-16-session-lineage-followups.md` → `2026-07-16-session-lineage-followups_done-YYYY-MM-DD.md`
3. 移动到 `todos/solved/`。
