# Issue tracker: GitHub

本仓库的 issues 和 PRD 使用 GitHub Issues，通过 `gh` CLI 操作。

## Conventions

- 创建：`gh issue create`
- 读取：`gh issue view <number> --comments`
- 评论：`gh issue comment <number>`
- 标签：`gh issue edit <number> --add-label/--remove-label`
- 关闭：`gh issue close <number>`

外部 PR 不作为需求分流入口。

## Wayfinding operations

- 地图：带 `wayfinder:map` 标签的单个 issue。
- 子票：优先使用 GitHub sub-issues；不可用时使用任务列表和 `Part of #<map>`。
- 类型：`wayfinder:research`、`wayfinder:prototype`、`wayfinder:grilling`、`wayfinder:task`。
- 阻塞：优先使用 GitHub native issue dependencies；不可用时使用 `Blocked by:`。
- 认领：开始工作前通过 `gh issue edit <number> --add-assignee @me` 认领。
- 完成：发布 resolution comment、关闭子票，再向地图的 Decisions so far 添加链接摘要。
