# Session 关系链识别与入口体验待办

- **日期**：2026-07-16
- **类型**：bug / 调研 / 需求
- **模块**：agent-sessions / lineage
- **状态**：已完成（2026-07-16）
- **环境**：本地 Dashboard，`http://127.0.0.1:7867/`

## 描述

Session 关系链功能原有三项事项，现已全部实施并在本文件归档：

1. 修正 Codex Goal 作为 user consumer 时的漏链。
2. 实施已确认的首页 Session 列表“有关系链”状态。
3. 实施已确认的单 Session 整链悬浮预览。

后两项设计已经确认，统一按 `plans/2026-07-16-lineage-entry-ui.md` 实施。

## TODO 1：Codex Goal 漏链（已完成）

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
- 与 `plans/004-filter-ambient-artifacts.md` 在同一个 extraction batch 中实施；两项规则变更共享一次缓存失效，将 `INDEX_VERSION` 从 2 升到 3，禁止分别递增或触发两次全量重建。
- 用最小测试固定“Goal objective 能连边、Goal 回显不重复、assistant 引用不连边、第三轮 user 引用不连边”。

### 验证方式

- `bun test tests/lineage.test.ts`
- `bun run typecheck`
- `./sessions index --rebuild --json`
- `./sessions lineage 019f6903 --json` 必须包含下游 `019f6a53-24ad-7fa0-b96d-6e457d8df307`。
- 目标边必须使用上述 PRD 路径，且 `reference_source=user`、`reference_turn=0`。

## TODO 2：首页列表显示关系链状态（已完成）

### 需求

首页 Session 列表中，如果某个 Session 属于任意关系链，应在该 Session 行内直接看出“有链”。没有关系链的 Session 不显示该状态。

### 设计结论（2026-07-16 已确认）

- 采用名称旁链徽标：链形 glyph + 整链 Session 数，不加独立列；无链行不渲染任何元素。
- 补充「⛓ 有链」筛选 tab（位于「★ 标记」与「归档」之间），承担批量发现职责；关系缓存为空时不显示。
- 点击徽标 = 固定链预览浮层（见 TODO 3），不直接跳转。
- 完整交互规格与视觉基准见 `plans/2026-07-16-lineage-entry-ui.md` 及其引用的设计稿。

### 实施方案

按 `plans/2026-07-16-lineage-entry-ui.md` 实施。复用已有 `/api/lineages` 缓存结果和当前列表数据，不为每一行单独请求关系链，也不在列表加载时重新分析索引。

### 验证方式

- 有链 Session 与无链 Session 在列表中可稳定区分。
- 状态对鼠标、键盘和屏幕阅读器都可理解，不能只靠颜色。
- 1900+ Session 数据量下不产生逐行网络请求或明显列表性能回退。
- 与现有星标、状态、名称、备注、详情入口不冲突。

## TODO 3：悬浮预览 Session 所在整条链（已完成）

### 需求

每个有链 Session 都应提供一个可悬浮的入口，快速预览该 Session 所在的完整连通关系链，而不是只看直接上游或下游一层。预览中需要明确当前 Session 的位置。

### 设计结论（2026-07-16 已确认）

- 悬浮入口复用 TODO 2 的链徽标，浮层为新的独立浮层，与首条消息 Transcript 预览互斥（同一时刻只显示其一）。
- 浮层内容为迷你 DAG：复用 LineageGraph 分层布局（抽共享模块参数化尺寸），节点 150×46，有向边（箭头指向下游），文件名标签放在列间 80px 空隙内不遮节点，当前 Session 高亮 +「当前」badge。
- 大链降级：连通分量 >12 节点只画当前 ±1 层，每侧邻居最多 4 个；隐藏节点按全部 ancestors、全部 descendants 和兄弟旁支三类互斥计数，按需显示折叠节点并可点击跳关系图定位。
- 交互：hover 180ms 显示 / 100ms 延迟隐藏；点击徽标固定，Esc/点外部关闭；键盘 focus 即预览，键盘固定后焦点进入浮层并在固定态内循环，Esc 归还焦点且不得重新触发预览；触屏 tap 即固定；reduced-motion 仅保留 opacity。
- 点击节点打开 Session 详情；footer「在关系图中定位」切换关系图视图并聚焦当前链。
- 完整规格见 `plans/2026-07-16-lineage-entry-ui.md`。

### 实施方案

按 `plans/2026-07-16-lineage-entry-ui.md` 实施。复用持久缓存和完整连通分量查询，不触发重新分析；动效只服务于浮层来源和状态变化，不使用持续力导向运动。

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
