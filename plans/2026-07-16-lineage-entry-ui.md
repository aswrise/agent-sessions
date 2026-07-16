# Plan: 首页关系链徽标与整链悬浮预览

> **Priority:** This plan overrides conflicting lineage UI plans, including Plan 003. Artifact filenames stay visible on lineage edges.

- **日期**：2026-07-16
- **状态**：已实施（2026-07-16）
- **来源**：`todos/solved/2026-07-16-session-lineage-followups_done-2026-07-16.md` 的 TODO 2 / TODO 3
- **前置计划**：`001`、`002`、`003`、`005`、`006`、`007` 全部完成后实施，避免提前抽取 `LineageGraph` 布局导致旧计划漂移
- **设计稿**（可交互 mockup，含最终视觉基准）：`plans/2026-07-16-lineage-entry-ui-mockup.html`，浏览器直接打开即可（徽标可 hover / 点击 / 键盘 focus）
- **已确认组合**：TODO 2 方案 A（名称旁链徽标）+ TODO 3 方案 1（迷你 DAG 悬浮卡）+ 大链邻域裁剪 + 「⛓ 有链」tab 筛选补充

## 目标

首页 Session 列表中，属于任意关系链的 Session 在行内直接可见「有链」及整链规模；悬浮/聚焦该状态可预览完整关系链并突出当前 Session；支持按「有链」筛选。全程只读 `/api/lineages` 持久缓存，1900+ 行无性能回退。

## 已确认设计（实施时不再更改交互语义）

### 1. 名称旁链徽标（TODO 2）

- 位置：名称单元格内、名称文本之后。名称文本收进独立 `span` 参与截断；徽标 `flex: none` 不参与截断，长名称被省略号截断时徽标仍完整可见。
- 内容：链形 SVG glyph + **整链 Session 数**（连通分量大小），如 `⛓ 5`。
- 元素：独立 `<button>`，所有事件 `stopPropagation`，不影响点击名称进入改名、点击行复制恢复命令。名称处于编辑态（input）时不渲染徽标。
- 无链 Session 不渲染任何元素；归档行徽标随行淡化，不特殊处理。
- 可访问性：`aria-label="所在关系链，共 N 个 Session，查看整条链"`，同文案作 `title`。glyph + 数字表意，不依赖颜色。按钮使用 `aria-haspopup="dialog"`、动态 `aria-expanded`，并以 `aria-controls` 指向当前浮层的稳定 id。
- 样式（深浅主题均基于现有 tokens，视觉基准见设计稿方案 A）：
  - 高 20px、圆角 999、水平 padding 7px、`font: 600 10.5px ui-monospace`；
  - 底色 `color-mix(in srgb, var(--lime) 9%, transparent)`，边框 26% lime，文字 `var(--lime)`；
  - hover（`@media (hover:hover) and (pointer:fine)`）底色 15%、边框 45%；`:active` `scale(.95)`；`:focus-visible` 2px lime outline。

### 2. 「⛓ 有链」筛选 tab（TODO 2 补充）

- 在来源 tabs 中新增 `{ value: "__chain__", label: "⛓ 有链" }`，位于「★ 标记」和「归档」之间。
- 计数与过滤：非归档且有链的 Session；语义与 `__star__` 完全一致（排除 archived，可与关键词、路径、状态、高级筛选叠加）。
- 关系缓存为空（从未分析 / 0 条边 / 加载失败）时**不显示**该 tab。
- `clearFilters` 现有逻辑已重置 `tab`，无需额外处理。

### 3. 链徽标悬浮预览：迷你 DAG（TODO 3）

浮层是新的独立浮层（不复用 `#tip`、不复用 `.menu`），与现有浮层互斥并存：

- 触发节奏沿用现有 tip：mouseenter 徽标 **180ms** 延迟显示，mouseleave **100ms** 延迟隐藏；浮层自身 mouseenter 取消隐藏计时、mouseleave 重新计时。
- 显示链预览时立即关闭 Transcript 预览（调用 `hidePreview()`）；打开任何 menu 时关闭链预览；页面滚动关闭（挂进 `closeFloatingOnScroll`）；同一时刻最多一个链预览。
- **点击徽标 = 固定（pinned）**：pinned 后鼠标移出不关闭；再次点击徽标、点击浮层外、按 Esc 关闭；Esc 关闭后焦点回到徽标。头部出现「已固定 · Esc 关闭」提示。
- 键盘焦点规则：Tab 聚焦徽标只显示未固定预览，不移动焦点；Enter / Space 固定后，`nextTick` 将焦点移到浮层中的当前 Session 节点。固定态内 Tab / Shift+Tab 在浮层可操作元素间循环，Esc 从任意子元素关闭并把焦点还给原徽标。
- 鼠标或触屏固定时不主动抢焦点；若焦点仍在徽标上，下一次 Tab 直接进入浮层的当前 Session 节点。
- Esc 归还焦点时必须抑制这一次程序化 `focus` 触发的预览打开（例如一次性 `suppressFocusOpen` 标记，在消费该 focus 后立即清除），避免关闭后立刻重开。浮层使用稳定 id、`role="dialog"` 和可读名称，并与徽标的 `aria-controls` / `aria-expanded` 同步。
- 触屏：无 hover，tap 徽标直接等于固定；tap 浮层外关闭。
- 定位：`position: fixed`，参照现有 `placePreview` 逻辑 — 锚点徽标 rect，下方优先、空间不足翻转到上方，`transform-origin` 对准徽标一侧。
- 动效：140ms `cubic-bezier(.23,1,.32,1)` 的 opacity + `scale(.97→1)`；`prefers-reduced-motion` 下只保留 ≤140ms opacity，节点不做入场 stagger。
- 浮层结构：
  - 头部：`关系链 · N Sessions · M 关系`；
  - 主体：迷你 DAG（下述）；
  - footer：左侧操作说明，右侧「在关系图中定位 →」。

迷你 DAG 渲染规则（视觉基准见设计稿方案 A 浮层）：

- 复用 LineageGraph 的分层布局算法（拓扑分层 + 同列按 birth 排序），**抽取为共享模块** `src/lineageLayout.ts`，以参数区分尺寸：LineageGraph 保持 220×64、列距 280、行距 96；预览用节点 **150×46**、**列距 230（即列间空隙 80px）**、行距 68。
- **边为有向边**：`marker-end` 箭头指向下游（与 LineageGraph 相同的 `context-stroke` marker；marker id 需带组件实例前缀防止与全局图冲突）。
- **边上文件名标签放在列间 80px 空隙内**（gap 中点，`y = min(两端点y) - 10`），永不压到节点块上；同一 gap 内同名文件只标一次；每条边保留 `<title>` 完整路径。
- 节点：tool 彩色标签（沿用 codex/claude/pi 三色）+ 角色（起点/中游/下游）+ 名称单行截断，不显示 id；当前 Session 节点 lime 边框 + 光晕 + 右上「当前」badge。
- 节点点击 → `openDetail(id)`（与关系图页一致）。
- 浮层 `max-width: min(700px, calc(100vw - 24px))`，画布超宽时浮层内部横向滚动。
- 数据：从已加载的全局 lineage 缓存取当前 Session 所在连通分量，**不发起新请求**。

### 4. 大链降级：邻域裁剪

- 连通分量 **>12 个节点**时不整链渲染，只画：当前节点 + 直接上游 + 直接下游。
- 每侧直接邻居最多显示 **4 个**，按 `birth`、再按 `id` 稳定排序后截取。
- 从当前节点沿反向边递归得到全部 ancestors，沿正向边递归得到全部 descendants。`上游还有 N 个` = ancestors 减去已显示的直接上游；`下游还有 N 个` = descendants 减去已显示的直接下游。未显示的直接邻居和所有更远节点都计入对应方向。
- 弱连通分量中可能存在既非 ancestor 也非 descendant 的兄弟分支；这些节点单独计为 `旁支还有 N 个`，不能硬塞进上游或下游。仅当对应计数大于 0 时渲染虚线折叠节点：`⋯ 上游还有 N 个`、`⋯ 下游还有 N 个`、`⋯ 旁支还有 N 个`。
- 三类集合必须互斥，且满足：当前节点 + 已显示真实邻居 + 三类折叠计数 = 整链 Session 数。所有折叠节点点击行为均等于「在关系图中定位」。
- 裁剪时头部文案改为 `关系链 · N Sessions · 仅显示相邻一层`。
- footer 右侧文案改为 `查看全部 N 个节点 →`。

### 5. 「在关系图中定位」

- 行为：切换到关系图视图（`showLineages()`），并向全局 `LineageGraph` 传入 `focusId`（组件已支持高亮）。
- 自动滚动**不与 focusId 绑定**：详情页内嵌的 LineageGraph 也一直传 focusId，不能因此滚动。定位滚动作为独立的 opt-in（如 `scrollToFocus` prop 或由 App 在切换视图后自行 `scrollIntoView` 对应链卡片），**仅在通过「在关系图中定位」入口进入全局关系图时启用一次**；详情页与常规打开关系图的行为不变。

## 数据与性能约束

- 列表首次加载完成后，**懒加载一次** `GET /api/lineages`（服务端 `catalog.lineages()` 只读持久缓存，不触发重建）；失败静默降级：无徽标、无 tab，不弹 toast。
- 客户端由 `edges` 计算连通分量，得到 `Map<sessionId, { chainKey, size }>`；BFS 逻辑与 `lineageLayout.ts` 共享。
- 「重新分析」（`indexLineage`）成功后重新拉取 `/api/lineages`，徽标与 tab 计数同步刷新。
- 禁止：逐行请求、列表加载时重建索引、hover 时发请求。

## 实施步骤建议

1. `src/lineageLayout.ts`：从 `src/LineageGraph.vue` 抽取连通分量 + 分层布局，参数化节点尺寸/列距/行距/边距；LineageGraph 改用共享模块（行为不变，现有 UI 测试回归）。
2. `src/App.vue` 数据层：`globalLineage` 懒加载 + `chainInfo` computed（Map）；`indexLineage` 成功后失效重取。
3. 徽标：名称单元格改 flex（文本 span + chip），渲染/aria/样式。
4. `__chain__` tab：tabs 条目、计数、过滤分支、无数据时隐藏。
5. `src/LineagePreview.vue`：迷你 DAG（含有向边、gap 标签、三类裁剪计数与折叠节点）+ 浮层状态机（show/hide 计时、pin、键盘固定后的焦点进入、固定态 Tab 循环、Esc 抑制重开并归还焦点），挂入 App.vue 浮层互斥与滚动关闭。
6. 「在关系图中定位」：viewMode 切换 + focusId 透传 + 仅该入口启用一次的定位滚动（见「已确认设计」第 5 节，勿绑定到 focusId 本身）。
7. 测试与验证（下节）。

## 验证方式

自动化（`tests/App.vitest.ts` 扩展，`/api/lineages` 加入 fetch mock fixture；布局函数可加独立单测）：

- 有链行渲染徽标且数字 = 整链 Session 数；无链行无任何徽标元素。
- 重新分析前 `/api/lineages` 只请求一次（100 行列表下断言 fetch 调用数）；触发「重新分析」成功后允许且仅允许第二次请求，徽标与 tab 计数随之刷新。hover 徽标不产生任何请求。
- hover 徽标 181ms 出现浮层，节点/边数正确，当前节点带高亮 class；mouseleave 101ms 关闭。
- 点击徽标固定，mouseleave 不关闭；键盘固定后焦点进入当前节点，Tab / Shift+Tab 不离开固定浮层；Esc 关闭、焦点回徽标且浮层不会因该 focus 重新打开。
- 徽标的 `aria-expanded` 与显隐同步，`aria-controls` 指向带 `role="dialog"` 和可读名称的浮层。
- hover 徽标时 Transcript `#tip` 不出现/被关闭（两浮层不并存）。
- 键盘 focus 徽标可打开预览。
- 「⛓ 有链」tab 计数正确、过滤正确；无边 fixture 下 tab 不渲染。
- >12 节点 fixture：只渲染邻域，分别断言 ancestor、descendant 与兄弟旁支的折叠计数；已显示真实节点数加三类隐藏计数必须等于整链 Session 数。
- 预览内点击节点进入详情（`location.search` 变化）。
- 与现有行为不冲突：行点击复制、名称编辑、星标、状态菜单原测试全绿。

命令：`bun run test:ui`、`bun run test`、`bun run typecheck`、`bun run build`。

手测（真实 1900+ 数据）：列表滚动无卡顿；徽标 hover 快速移入移出不闪烁、不重复请求；58 节点大链预览不溢出视口；深浅主题、reduced-motion 下均可用。

## 边界（本 plan 不做）

- 不改服务端 API、不改 `src/lineage.ts` 提取规则（TODO 1 Codex Goal 漏链独立实施，先后顺序无依赖）。
- 不加独立「链」列、不做链排序。
- Session 详情页不加徽标（详情页已有完整链图）。

## 完成后

- 已按 `todos/solved/2026-07-16-session-lineage-followups_done-2026-07-16.md` 的「完成后」流程归档 TODO 1/2/3。
- 在 `implementation-notes.md` 记录 seams、deviations 与验证日志。
