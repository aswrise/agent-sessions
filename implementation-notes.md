# Implementation Notes: Python Dashboard Parity in Vue

## 2026-07-16: Session 文件传递关系索引

### Objective

- 自动识别跨 Session 的 Markdown/HTML 文件传递关系：上游最后 3 个真实用户轮次内成功写入，下游最前 3 个有效任务输入内按绝对路径引用。
- 有效任务输入包含直接用户消息和用户提供的 Codex Goal；排除 AGENTS、skills、memory、compact history 等注入内容。
- 全局刷新与单 Session 完整上下游查询共用一份持久索引；页面第一版只提供最小可验证入口，最终交互后续再定。

### Confirmed Test Seams

- 事件提取：Claude、Codex、pi 的真实用户轮次、Goal、成功 Write/Edit、Codex patch 结果与路径标准化。
- 关系判定：消费者窗口为前 3 个有效输入，生产者窗口为后 3 个用户轮次；同 Session 不连边，引用只连接到此前最近一次写入。
- 持久索引：未变化 Session 不重解析，变化/删除 Session 只更新受影响事实和边。
- 查询：从指定 Session 双向遍历到完整连通关系，而非只返回一层。

### Progress

- [x] 关系提取与判定测试
- [x] 持久索引与增量刷新
- [x] CLI/HTTP 最小入口
- [x] 页面最小入口
- [x] 全量验证与 review

### Deviations

- Session 事实按变化文件增量提取，但关系边当前只有约 170 条，因此每次刷新统一重建全部边；只有全量重建变成可测瓶颈时再按受影响路径局部更新。
- 裸 `bun run typecheck` 原先缺少 Vue 模块声明，新增最小 `vue-shim.d.ts`，不改变运行时行为。

### Verification Log

- `bun test tests/lineage.test.ts`：3 个测试通过；覆盖 Claude/Codex/pi、前后 3 轮窗口、Goal、注入过滤、最近写入者、增量刷新和完整连通分量。
- `bun run typecheck`：通过。
- `bun run test:ui`：13 个 Vue DOM/交互测试通过，包含全局索引和详情关系链入口。
- `bun run test`：30 个 Bun 后端测试、13 个 Vue DOM/交互测试全部通过；当前 snap Bun 会清洗 PATH，验证时只用临时 preload 将 shell 已存在的 `rg` 绝对路径注入 `Bun.which`，未改产品代码或测试。
- `bun run build`：通过，Vite 页面成功内嵌。
- 双轴 review：修复空/注入 Codex task 挤占三段窗口、delete patch 误判为写入、等时写入被视为“此前”以及索引规则无版本失效四个准确性问题；新增 ADR 0002 和 Lineage 领域词汇。
- 复审：Spec 无剩余问题；Standards 无 hard violation。保留一项 judgement call：Lineage 的注入过滤比 Transcript 展示过滤更严格，当前分别维护；若格式规则继续增长，再提取共享 JSONL 原语和结构化事件 seam。
- 真实数据全量重建：1957 个 Session，解析出 1044 次写入、1667 次引用和 170 条去重关系；两次索引核心耗时 4.8–6.3 秒。
- 真实数据增量刷新：只重扫当前变化的 1 个 Session，索引核心耗时 24–34ms。
- 示例链验证：`019f6525` → `019f68a9` → `019f68cf` 成功识别，并继续发现下游 `019f6a3c`；`019f6466` 在当前规则下无边。

## 2026-07-15: Agent CLI and Deep Search

### Objective

- 为 terminal agent 提供稳定的 JSON 输出：`sessions list --json`、`sessions find <keyword> --json`、`sessions show <id-prefix> --json`。
- 保留现有人类可读输出，并让 `show` 可以直接读取完整 Transcript。
- 页面保留当前普通检索，新增显式触发的深度检索；深度检索覆盖普通字段与全部可读 user/assistant Transcript。
- 深度检索继续复用 `SessionCatalog` 和 `rg`，只使用进程内 Session 索引，不增加磁盘缓存或外部服务。

### Confirmed Test Seams

- `SessionCatalog`：固定文本、忽略大小写、普通字段与 Transcript 合并命中、缓存索引复用。
- CLI 进程：JSON list/find/show 契约及人类可读 show。
- localhost HTTP：深度检索路由的输入校验和响应契约。
- Vue DOM：普通/深度模式切换、显式提交、加载及错误恢复。

### Progress

- [x] Catalog 深度检索
- [x] CLI JSON 与 show
- [x] HTTP 深度检索路由
- [x] Vue 普通/深度模式
- [x] 完整验证与双轴 review

### Deviations

- 深度检索请求期间修改关键词会让旧响应变成过期结果；保守处理为立即失效旧请求并保留未筛选列表，不尝试缓存或合并旧结果。
- `code-review` 要求以已提交的 `HEAD` 做三点 diff；因此先创建仅含本功能的 scoped commit，再执行双轴 review，发现问题后追加修复提交。

### Review

- Standards：0 个 hard violation；恢复命令包装重复与 Vue 深搜状态组为 2 个 judgement call。前者已合并到 `resume.ts`，后者维持 Vue refs，等状态继续增长时再收敛。
- Spec：发现 JSONL 转义查询漏检与页面 500 条截断两项。已增加原文/JSON 转义双候选并在解析后的 Transcript 上复核；页面深搜不再设置固定结果上限。

### Verification Log

- `bun test tests/catalog.test.ts`：通过；新增普通字段、大小写、固定文本及可读 Transcript 搜索覆盖。
- `bun test tests/cli.test.ts`：通过；新增 list/find/show JSON 与人类可读 show 覆盖。
- `bun test tests/http.test.ts`：通过；新增深度检索路由及 limit 输入校验覆盖。
- `bun run test:ui`：通过；12 个 Vue DOM/交互测试，包含过期深度检索响应保护。
- `bun run typecheck`：通过。
- `bun run test`：通过；26 个 Bun 后端测试、12 个 Vue DOM/交互测试。
- `bun run build`：通过；Vite 产物已内嵌。
- staged-tree 独立验证：精确暂存树测试、构建、类型检查均通过，未依赖工作区中的源文件路径改动。
- 真实 6196 文件 / 1.9GB 数据：常驻进程首次深度检索 1.218 秒，后续 0.204–0.222 秒；未新增磁盘缓存。

## Objective

把 `master:sessions` 中 Python dashboard 的视觉与交互完整迁移到当前 Vue 版本，同时保留 Bun 后端、现有 API 契约及当前工作树中的 Markdown Transcript 渲染。

## Authoritative Baseline

- 视觉与交互：`git show master:sessions` 中的 `DASH_TEMPLATE`。
- 数据与写入行为：当前 `SessionCatalog`、HTTP API 与 `SessionView` / `TranscriptView` 契约。
- 当前用户改动：保留 `markdown-it` 依赖及详情、悬浮预览中的 Markdown 安全渲染。

## Parity Checklist

- [x] 默认深色主题、原色板、背景、字体与响应式布局
- [x] 品牌头、说明文案、Session 总数与更新时间
- [x] sticky chrome、搜索框、来源标签及动态数量
- [x] 自定义路径菜单、状态菜单及键盘导航
- [x] 高级筛选、有效筛选计数与清除筛选
- [x] 13 列表格、原列宽、排序标记与列宽拖拽持久化
- [x] 日期、路径、大小、工具标签和状态胶囊格式
- [x] 点击名称/备注后进入编辑，Enter/失焦保存，Escape 取消
- [x] 行点击复制、星标、状态、详情、归档及原提示文案
- [x] 截断单元格提示和首条消息 Transcript 悬浮预览
- [x] 详情页头、消息气泡、浏览器历史与 Escape 返回
- [x] 分页、footer 文案、`/` 搜索快捷键、主题持久化
- [x] Vue 回归测试、类型检查、生产构建及浏览器实测

## Progress

### 2026-07-14

- 对比确认 Vue 初版只迁移了功能，没有迁移 Python 版 DOM/CSS。
- 将 `src/App.vue` 重构为 Python 版的信息架构和样式体系：品牌头、chrome、13 列表格、状态胶囊、菜单、toast、详情和 preview 均已落入 Vue 模板。
- 搜索语义恢复为 Python 版：只匹配名称、备注与首条消息，不匹配路径、模型、工具或 id。
- 保留当前工作树里的 Markdown 安全渲染，并为旧版 bubble / tip 外观补充最小 Markdown 样式。
- Session 列表 envelope 增加 `home` 并在前端边界校验，恢复 Python 版基于真实 HOME 的 `~` 路径缩写。
- `index.html` 在 Vue 启动前同步主题，恢复 Python 版无主题闪烁的启动方式。
- 恢复 `docs/dashboard.png`、`docs/dashboard-filters.png`、`docs/dashboard-detail.png` 为 Python 视觉基准，README 不再展示错误的迁移界面。
- 将 JSONL 元数据解析改为惰性头部读取，Claude 标题改由 `rg` 提取，并复用 Codex SQLite 的首条消息与模型；真实 1900+ Sessions 首次索引中位数从约 6.5 秒降至 0.93 秒，刷新降至约 0.18 秒。
- Session 索引保存 `id -> file` 定位，详情不再触发全量重建；前端合并同一 Session 的在途预览请求，避免鼠标反复移入导致请求排队。
- Codex 名称优先使用官方 `thread_name`；改名通过 Codex app-server `thread/name/set` 同步，并在成功后移除旧 `stars.json` 本地名称覆盖。

## Deviations

- Python 模板由服务端直接注入 `HOME`；Vue 迁移最初只能猜测用户目录。已在 Session 列表 envelope 增加经过边界校验的 `home`，由 Bun 服务端显式提供，从而保留 Python 版精确的 `~` 缩写行为。
- Python 版刷新通过页面导航 `/?fresh=1`，Vue 版直接请求 `/api/sessions?fresh=1`。两者都会强制重建 Session 索引；保留 SPA 方式以避免无意义的整页重载。
- Python 版将 Codex 改名仅保存在本工具标记中；Vue/Bun 版按新需求调用 Codex 官方 app-server。只读能力仍仅依赖 `rg`，Codex CLI 缺失时只有 Codex 改名不可用。

## Verification Log

- `bun run test`：通过；20 个 Bun 后端测试、7 个 Vue DOM/交互测试全部通过。
- `bun run typecheck`：通过。
- `bun run build`：通过；Vite 产物已内嵌进 standalone HTML。
- `git diff --check`：通过。
- 浏览器实测：在 `http://127.0.0.1:7868/` 使用真实 1900+ Sessions 完成列表渲染；与 `master` 中 Python `docs/dashboard.png` 对照，品牌头、chrome、13 列表格、行高、列宽、色板和信息密度一致。
- 详情直达实测：`/?session=<id>` 成功加载真实 Transcript，深色主题、详情头和左右消息气泡与 Python 基准一致。
- 性能实测：真实 1911 Sessions 冷索引中位数 0.93 秒、缓存命中 5.1 毫秒、显式刷新中位数 0.186 秒；10.7MB Codex Transcript 的详情 HTTP 约 43 毫秒。
- Codex 名称实测：`刷workspace-` 同步写入 `session_index.jsonl` 与 `state_5.sqlite`，`7868` API 返回同名且旧本地覆盖已清理。
