# SoloMap Project Data

这个目录由 SoloMap 自动创建，用来保存当前项目的路线图、Agent 对话记录、执行日志和环节交接总结。

## 为什么数据放在项目里

- 项目数据跟随项目文件夹走，不依赖插件后端服务。
- 换一台机器、换一个 IDE、重新安装插件后，只要项目文件还在，SoloMap 就能重新加载这些数据。
- 这个目录可以交给 Git/GitHub 管理，让路线图、交接总结和执行记录成为项目历史的一部分。

## 主要文件

- `roadmap.csv`：路线图主数据，包括环节、依赖、状态和 Agent prompt。
- `step-memory/`：每个路线图环节的 JSON 完成标准和交接总结。下一轮 Agent 对话会读取这里的结构化上下文。
- `step-sessions/`：每个路线图环节按 Agent 保存原生会话 ID。后续对话会把这些会话 ID 作为可选参考交给 Agent，而不是强制续接。
- `documentation.json`：项目解释性文档的索引与审计状态。它由 SoloMap 维护，用来帮助 Agent 优先更新正确文档并识别文档噪音。
- `project_journal.db`：本地 SQLite 执行日志，保存更完整的 Agent 对话和历史记录。
- `project_growth.db`：项目生长快照与生长分析轨迹的独立本地数据库，避免路线图同步覆盖历史。
- `agent-runs/`：每次 Agent 调用的输出、文件变更摘要和完成判断。
- `run-digests/`：每次 Agent 调用结束后的结构化执行摘要和跨 Agent 交接信号。下一轮相关任务会读取少量摘要来减少重复探索。
- `execution-graph.json`：由 run digest 自动生成的轻量索引，按环节、Agent、文件、状态、失败和命令组织最近执行信号。
- `.agent_status.json`：临时运行状态文件，通常会被插件自动清理。

## 请不要随意删除

删除这个目录会导致 SoloMap 无法恢复该项目的路线图、状态、对话历史和环节交接总结。需要清理体积时，优先只清理 `agent-runs/` 中很旧的运行记录，并保留 `roadmap.csv` 和 `step-memory/`。

## Git 建议

如果你希望项目在多台机器或多个 IDE 间保持一致，可以把 `.solopreneur/` 提交到 Git。这样 SoloMap 的项目上下文会跟项目代码一起迁移。