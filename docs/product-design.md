# VS Code 本地代码备份插件设计

## 结论

建议做成一款“本地优先、版本化快照、存储后端可替换”的 VS Code 桌面插件。用户只需要完成三个动作：选择备份位置、立即备份、从历史版本恢复；Google Drive 与 QNAP NAS 的协议差异全部留在实现层。

首版建议直接支持：

- Google Drive：使用 Drive API，OAuth 权限只申请 `drive.file`。
- QNAP NAS：优先使用 SFTP + SSH 公钥；WebDAV 作为无法启用 SSH 时的兼容选项。
- 备份格式：每次生成不可变快照，不做双向同步，不删除本地文件，也不让远端状态反向覆盖工作区。
- 恢复策略：先恢复到用户选择的新目录；覆盖当前工作区必须二次确认，并在覆盖前自动生成本地安全快照。

不建议首版直接嵌入或强依赖 rclone。rclone 很适合作为架构参考和后续“高级传输引擎”，但要求用户额外安装、配置 remote，会明显增加插件的首次使用成本；VS Code Web Extension 又不能启动子进程，因此这种方案还会天然排除网页版 VS Code。

## 用户体验

### 首次使用

1. 用户点击侧栏中的“开始备份”。
2. 选择 Google Drive 或 QNAP NAS。
3. 完成 Google 授权，或填写 NAS 地址、用户名并选择 SSH 私钥。
4. 插件自动测试连接，显示目标文件夹与可用空间（协议支持时）。
5. 用户确认默认排除项后，点击“创建首个备份”。

不要让用户选择“适配器、传输模式、manifest、增量算法”等内部概念。设置页只暴露会改变结果的选择：备份位置、备份时机、保留数量、排除规则、是否加密。

### 日常使用

- 状态栏只显示最近结果，例如“已备份 · 3 分钟前”或“备份失败 · 点击重试”。
- 命令面板提供：`立即备份`、`查看备份历史`、`恢复备份`、`检查备份完整性`。
- 资源管理器项目根目录右键提供“立即备份此项目”。
- 自动备份支持“保存后空闲 N 分钟”和固定时间间隔；文件变化只触发防抖，不应每次保存都上传完整快照。
- 关闭 VS Code 时不强行阻塞窗口等待大型上传；未完成任务在下次启动后继续或明确重试。

### 恢复

历史页每条记录显示时间、设备名、项目名、大小、文件数与校验状态。用户可先浏览文件列表，再选择：

- 恢复整个项目到新目录（默认、安全）。
- 恢复选中文件到新目录。
- 覆盖当前工作区（高级动作，必须显示变更预览并二次确认）。

## GitHub 参考项目

| 项目 | 可借鉴内容 | 判断 |
| --- | --- | --- |
| [GustavoASC/google-drive-vscode](https://github.com/GustavoASC/google-drive-vscode) | Google OAuth、Drive 树视图、把工作区压缩为带时间戳 ZIP 后上传 | 最接近需求的 VS Code 样例，MIT；但最近代码推送停在 2023 年，且多根工作区只处理第一个根目录，不适合直接作为产品基座 |
| [Natizyskunk/vscode-sftp](https://github.com/Natizyskunk/vscode-sftp) | VS Code 命令、远端路径配置、忽略规则、SFTP 上传/下载/同步与进度反馈 | 适合参考 QNAP 传输和 VS Code 集成；仓库许可证元数据不明确，宜学习设计，不直接复制代码 |
| [rclone/rclone](https://github.com/rclone/rclone) | Google Drive、SFTP、WebDAV、SMB 等统一后端；校验、重试、复制/同步、加密、压缩 | 最成熟的传输架构参考，MIT；适合后续可选外部引擎，不适合首版作为强依赖 |
| [zokugun/vscode-sync-settings](https://github.com/zokugun/vscode-sync-settings) | 一个 VS Code 产品下切换多种远端存储、WebDAV 配置与凭据管理 | 可参考 provider 抽象和设置迁移；它同步的是设置，不是项目快照 |
| [liximomo/vscode-sftp](https://github.com/liximomo/vscode-sftp) | 原始 SFTP 插件的配置与同步模型 | 已被 VS Code 团队标记为弃用并推荐替代版本，只应作为历史参考 |

仓库活跃度与星标会变化。2026-07-20 通过 GitHub API 核对时，rclone 约 5.8 万星且当天仍有代码活动；Google Drive VS Code 样例 63 星；Natizyskunk SFTP 533 星。选型更应看职责与许可证，而不是仅看星标。

## 产品边界

### 这是备份，不是同步

首版必须坚持单向、追加式、可恢复：

- 本地工作区是源，远端快照库是目标。
- 本地删除文件只意味着新快照不再包含它；旧快照仍可恢复。
- 远端文件被人工修改不应自动写回本地。
- 保留策略只能删除已超过保留期的完整快照，不能对当前工作区做镜像删除。

这一区分能避免 SFTP 插件常见的“同步删除”风险，也让 Google Drive 与 NAS 使用同一套用户心智。

### 不替代 Git

Git 负责代码历史、分支和协作；本插件负责未提交文件、私有项目、工作区辅助文件以及灾难恢复。默认备份 `.git` 之外的项目文件；是否包含 `.git` 作为高级选项，默认关闭，因为它体积大、变化频繁且可能包含敏感远端地址或钩子。

## 备份数据格式

每次备份创建一个不可变快照：

```text
CodeBackups/
  <project-id>/
    project.json
    snapshots/
      2026-07-20T120102Z_<snapshot-id>/
        manifest.json
        payload.tar.zst
```

`project.json` 保存稳定项目 ID、显示名、格式版本和创建时间。`manifest.json` 至少包含：

- 快照 ID、创建时间、插件版本、设备显示名。
- 工作区根目录的逻辑名称；不得保存本机绝对路径。
- 每个文件的相对路径、大小、修改时间、SHA-256。
- 排除规则摘要、压缩与加密参数。
- 整体 payload 的大小与 SHA-256。

首版用完整快照最可靠，也最容易验证和恢复。第二阶段再加入内容寻址分块：按文件哈希复用未变化 blob，用 manifest 组合快照；在完成引用计数与崩溃恢复前，不能上线自动垃圾回收。

### 默认排除

内置排除项：`node_modules`、常见构建目录、缓存、日志、操作系统临时文件。合并顺序建议为：内置规则 → `.gitignore` → 用户的 `.codebackupignore`。密钥文件不要静默排除，因为不同项目需求不同；首次发现 `.env`、私钥或凭据模式时，明确询问用户“包含、排除、启用加密”，并记住该项目的选择。

## 技术架构

```text
VS Code 命令/侧栏/状态栏
          │
     BackupService
  ┌───────┼────────┐
扫描器  快照构建器  恢复/校验器
          │
   StorageProvider 接口
     ├─ GoogleDriveProvider
     ├─ SftpProvider
     └─ WebDavProvider
```

### 模块职责

- `BackupService`：唯一编排入口，管理排队、防抖、取消、重试与结果状态。
- `WorkspaceScanner`：处理多根工作区、排除规则、符号链接策略和文件变化检测。
- `SnapshotBuilder`：流式生成 manifest 与压缩包，避免把整个项目读入内存。
- `SnapshotRepository`：负责快照命名、原子发布、列表、读取与保留策略。
- `RestoreService`：下载、校验、预览冲突、恢复到新目录或受控覆盖。
- `CredentialStore`：只通过 `ExtensionContext.secrets` 保存 refresh token、NAS 密码或私钥口令；普通配置只保存后端类型、目标路径和非敏感参数。VS Code 官方说明该 SecretStorage 在桌面端由 Electron `safeStorage` 加密，且不会跨机器同步。

建议的统一接口：

```ts
interface StorageProvider {
  connect(signal: AbortSignal): Promise<ConnectionInfo>;
  putObject(key: string, body: Readable, options: PutOptions): Promise<ObjectReceipt>;
  getObject(key: string, options?: RangeOptions): Promise<Readable>;
  list(prefix: string): Promise<RemoteObject[]>;
  stat(key: string): Promise<RemoteObject | undefined>;
  move(source: string, destination: string): Promise<void>;
  delete(key: string): Promise<void>;
}
```

发布一个快照时先上传到 `staging/<snapshot-id>`，全部校验成功后再移动/标记为 committed。历史页只展示 committed 快照；中断留下的 staging 对象下次启动时可继续或清理。

## 后端实现

### Google Drive

- 使用系统浏览器 OAuth + PKCE，回调到 VS Code URI handler。
- 权限使用 `https://www.googleapis.com/auth/drive.file`，只访问插件创建或由用户明确交给插件的文件；不要申请完整 `drive` 权限。
- 首次连接时创建 `CodeBackups` 文件夹并保存 folder ID，后续按父级 ID 查询，避免依赖同名路径。
- 大于 5 MB 或网络可能中断时使用 resumable upload；Google 官方建议可续传上传也适用于小文件，上传分块除最后一块外应为 256 KiB 的倍数。
- 保存 resumable session URI 与已上传偏移到 workspace storage，重启后继续；session 过期或返回 404 时重新创建上传会话。
- 利用 Drive 文件 ID 与 `appProperties` 保存 project ID、snapshot ID、format version，避免依赖文件名解析。

### QNAP NAS

首选 SFTP：

- 用户输入主机、端口、用户名、远端共享目录；首次连接必须展示并固定服务器 host key 指纹，指纹变化时阻止上传并明确告警。
- 优先 SSH agent 或私钥认证，密码只作为兼容方案。
- 上传到临时文件名，完成校验后原子 rename；连接断开后支持重试。
- NAS 端不需要安装专用应用，只需 QTS 启用 SSH/SFTP 并授予目标共享目录权限。

WebDAV 兼容模式：

- 使用 HTTPS，拒绝默认接受无效证书；自签名证书必须由用户显式信任证书指纹。
- 通过 `MKCOL`、`PUT`、`PROPFIND`、`MOVE` 实现目录、上传、列表和提交。
- QTS 5.2 官方用户指南包含 WebDAV 配置入口，因此可作为不开放 SSH 时的后备方案；性能、断点续传和服务端校验能力通常弱于 SFTP，UI 中可标为“兼容模式”，但不要要求用户理解协议细节。

SMB 不建议首版在插件中原生实现。若用户已经把 QNAP 共享目录挂载为本地磁盘，可直接提供“本地文件夹”后端，这比在 Node 扩展内维护 SMB 客户端更简单可靠。

## 一致性、安全与失败处理

- 扫描开始时记录文件元数据；读取结束后再次核对。备份期间仍在变化的文件重新读取一次，仍变化则标记本轮跳过并提示，而不是产生表面成功的损坏快照。
- 每个文件与整个 payload 使用 SHA-256；上传后能服务端读取校验时执行远端校验，不能服务端计算时至少随机回读和校验 manifest/payload 元数据。
- 可选端到端加密使用成熟的 AEAD 流式格式（例如基于 XChaCha20-Poly1305 的分块封装），密钥由用户口令通过 Argon2id 派生；恢复密钥不上传到 Drive/NAS。
- 默认并发 2–4 个传输，自动退避 429、5xx 和短暂网络错误；认证失败、磁盘满、权限不足不做无休止重试。
- 插件日志不得输出 token、密码、私钥内容、本机绝对路径或文件正文。
- 在 Restricted Mode 下可允许只读浏览历史，但创建备份与恢复覆盖必须检查 Workspace Trust。
- 保留策略先保证至少一个已校验快照，再删除旧快照；删除失败只影响空间回收，不能把本次成功备份标成失败。

## 实施顺序

### 第一阶段：可用首版

- VS Code 桌面扩展骨架、单根/多根工作区扫描、排除规则。
- 完整快照、manifest、SHA-256、恢复到新目录。
- Google Drive `drive.file` + resumable upload。
- QNAP SFTP + host key 固定。
- 手动备份、空闲自动备份、历史列表、连接测试、取消与重试。

验收标准：在 Windows、macOS、Linux 各完成一次 1 GB 项目的中断续传；从 Google Drive 和 QNAP 各恢复到空目录，逐文件哈希与原工作区一致；多根工作区均被包含；凭据不出现在设置 JSON、日志和备份内容中。

### 第二阶段：可靠性与空间效率

- 选择性恢复、覆盖前差异预览与安全快照。
- WebDAV、本地挂载目录后端。
- 内容寻址增量、保留策略、完整性定期巡检。
- 客户端加密与离线恢复工具。

### 第三阶段：高级能力

- 可选 rclone 外部引擎，用于更多云存储；插件负责探测版本、生成临时最小配置、解析 JSON 日志与隐藏敏感参数。
- 设备间项目发现、带宽计划、备份健康通知。

## 测试策略

- 单元测试：排除规则、路径规范化、manifest 稳定性、重试分类、保留策略、冲突预览。
- 契约测试：同一套 provider contract 对 Drive、SFTP、WebDAV、本地目录执行上传、列举、读取、原子提交和删除测试。
- 故障测试：上传中断、token 过期、host key 变化、NAS 空间不足、Drive 429/5xx、VS Code 强制退出、文件在扫描时变化。
- 恢复验收：生成包含大小写冲突、Unicode、长路径、空文件、符号链接、多根目录的样本项目；恢复后逐文件 SHA-256 对比。
- 最终产物测试：打包 VSIX 后安装到干净 VS Code Profile，确认首次连接、备份、历史、恢复链路，而不只测试源码模块。

## 关键决策摘要

1. 产品定义为“版本化备份”，不是“远程同步”。
2. UI 只有一套备份心智，Drive/SFTP/WebDAV 是实现细节。
3. 首版自带两个原生 provider，不强依赖 rclone。
4. Google 只申请 `drive.file`；QNAP 默认 SFTP + host key 固定。
5. 恢复到新目录是默认路径；覆盖当前工作区必须有差异预览和安全快照。
6. 首版先做完整不可变快照；增量去重在引用与回收机制验证后再上线。

## 主要证据来源

- [Google Drive API：文件上传与可续传上传](https://developers.google.com/workspace/drive/api/guides/manage-uploads)
- [Google Drive API：files.create 与 OAuth scopes](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/create)
- [VS Code Extension API：存储与 SecretStorage](https://code.visualstudio.com/api/extension-capabilities/common-capabilities)
- [VS Code Extension API：FileSystemWatcher](https://code.visualstudio.com/api/references/vscode-api)
- [VS Code：Workspace Trust](https://code.visualstudio.com/api/extension-guides/workspace-trust)
- [QTS 5.2 User Guide：WebDAV 与服务配置](https://docs.qnap.com/operating-system/qts/5.2.x/qts5.2.x-ug-en-us.pdf)
- [rclone GitHub 仓库](https://github.com/rclone/rclone)

