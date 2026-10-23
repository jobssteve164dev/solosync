# VS Code 本地代码备份插件设计

## 结论

建议做成一款“本地优先、版本化快照、存储后端可替换”的 VS Code 桌面插件。用户只需要完成三个动作：选择备份位置、立即备份、从历史版本恢复；Google Drive 与 QNAP NAS 的协议差异全部留在实现层。

首版建议直接支持：

- Google Drive：使用 Drive API，OAuth 权限只申请 `drive.file`。
- QNAP NAS：使用 QTS/QuTS hero 官方 WebDAV，通过 HTTPS 域名连接专用共享文件夹和最小权限账户。
- 备份格式：每次生成不可变快照，不做双向同步，不删除本地文件，也不让远端状态反向覆盖工作区。
- 恢复策略：先恢复到用户选择的新目录；覆盖当前工作区必须二次确认，并在覆盖前自动生成本地安全快照。

不建议首版直接嵌入或强依赖 rclone。rclone 很适合作为架构参考和后续“高级传输引擎”，但要求用户额外安装、配置 remote，会明显增加插件的首次使用成本；VS Code Web Extension 又不能启动子进程，因此这种方案还会天然排除网页版 VS Code。

## 用户体验

### 首次使用

1. 用户点击侧栏中的“设置”。
2. 明确选择要保护的项目文件夹；插件不得用更宽的 VS Code 工作区静默替代。
3. 选择 Google Drive、QNAP NAS 或本地目录作为备份位置。
4. 插件自动测试源目录与目标位置，显示当前选择。
5. 用户点击“创建首个备份”；扫描和复制阶段显示文件进度并可随时取消，取消后不保留未完成快照。

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

每次备份创建一个不可变的逻辑完整快照，物理文件内容按 SHA-256 复用：

```text
SoloSync/
  <project-id>/
    project.json
    objects/
      <sha256>
    snapshots/
      <snapshot-id>/
        manifest.json
```

`project.json` 保存稳定项目 ID、显示名、格式版本和创建时间。`manifest.json` 至少包含：

- 快照 ID、创建时间、插件版本、设备显示名。
- 工作区根目录的逻辑名称；不得保存本机绝对路径。
- 每个文件的相对路径、大小、修改时间、SHA-256。
- Git 状态和触发来源等恢复上下文。

manifest 按文件哈希引用 `objects/` 中的稳定内容对象。每个快照都能独立恢复完整目录，但未变化内容不会再次上传。旧版把文件放在 snapshot 目录内的 format-1 快照继续可读、可校验和可恢复；在完成引用计数与崩溃恢复前，不上线自动垃圾回收。

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
     ├─ LocalFileSystemProvider
     └─ QnapWebDavProvider
```

### 模块职责

- `BackupService`：唯一编排入口，管理排队、防抖、取消、重试与结果状态。
- `WorkspaceScanner`：只扫描用户明确选择的项目文件夹，并处理排除规则、符号链接策略和文件变化检测。
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

- 本地桌面使用系统浏览器、Desktop OAuth、PKCE 与 loopback 回调。Remote SSH、Dev Container、Coder、code-server 与 Web Extension 宿主使用固定 HTTPS Web OAuth 回调，并让用户把绑定 PKCE 的短时 SoloSync 回调码粘贴回连接提示；不使用 Google 已停止支持的 OOB 流程、自定义 URI scheme或 Device Authorization Flow。
- 权限使用 `https://www.googleapis.com/auth/drive.file`，只访问插件创建或由用户明确交给插件的文件；不要申请完整 `drive` 权限。
- 首次连接时自动创建 `SoloSync Backups` 文件夹并保存 folder ID，不再要求用户选择本地同步目录；后续按父级 ID 查询，避免依赖同名路径。
- 5 MB 以内且可整体重传的文件使用单请求 multipart upload；更大文件使用 resumable upload，并采用 8 MiB 分块以减少往返（分块仍为 Google 要求的 256 KiB 倍数）。
- 将 resumable session URI 作为敏感凭据保存到 SecretStorage；snapshot ID、冻结后的本地副本、预留 Drive file ID 与任务状态持久保存。重启后查询服务端 `Range` 再继续，不能只相信本地偏移。
- 利用预生成的 Drive file ID 与 `appProperties` 保存 project ID、snapshot ID、format version、logical key hash 和发布状态；Drive 允许重名，不能按名称任取一个对象。Google backend 不创建共享可变的 `project.json`，项目状态从 committed snapshots 派生。
- 完整连接、存储、失败恢复与验收设计见 [`google-drive-native-design.md`](google-drive-native-design.md)。

### QNAP NAS

默认使用 WebDAV：

- 使用 HTTPS，并要求证书通过操作系统信任链与域名校验；插件不提供忽略证书错误或单独信任指纹的旁路。
- 通过 `MKCOL`、`PUT`、`PROPFIND`、`MOVE` 实现目录、上传、列表和提交。
- QTS 5.2 官方用户指南提供 WebDAV 配置和共享文件夹权限入口，可用非管理员专用账户把权限限制在 SoloSync 共享文件夹。
- QTS 5.2 官方 SSH/SFTP 入口只允许管理员账户，因此 SFTP 不作为本产品的默认 QNAP 接入方式。
- 域名入口必须通过完整连接测试，证明 `PROPFIND`、`MKCOL`、`PUT`、`GET`、`MOVE` 和 `DELETE` 都能穿过反向代理。

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

- VS Code 桌面扩展骨架、用户选择的单项目目录扫描、排除规则。
- 逻辑完整、物理增量的内容寻址快照、manifest、SHA-256、恢复到新目录。
- Google Drive `drive.file` + resumable upload。
- QNAP HTTPS WebDAV + SecretStorage 凭据。
- 手动备份、空闲自动备份、历史列表、连接测试、取消与重试。

验收标准：在 Windows、macOS、Linux 各完成一次 1 GB 项目的中断续传；从 Google Drive 和 QNAP 各恢复到空目录，逐文件哈希与原项目一致；宽工作区下只包含用户选择的项目目录；取消后不发布快照且不残留本次 staging；凭据不出现在设置 JSON、日志和备份内容中。

### 第二阶段：可靠性与空间效率

- 选择性恢复、覆盖前差异预览与安全快照。
- 本地挂载目录后端、QNAP 性能与兼容性增强。
- 保留策略、内容对象安全回收、完整性定期巡检。
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
4. Google 只申请 `drive.file`；QNAP 默认 HTTPS WebDAV + 最小权限账户。
5. 恢复到新目录是默认路径；覆盖当前工作区必须有差异预览和安全快照。
6. 每个快照保持完整不可变的恢复语义；底层按文件哈希增量复用，自动垃圾回收要等引用与崩溃恢复机制验证后再上线。

## 主要证据来源

- [Google Drive API：文件上传与可续传上传](https://developers.google.com/workspace/drive/api/guides/manage-uploads)
- [Google Drive API：files.create 与 OAuth scopes](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/create)
- [VS Code Extension API：存储与 SecretStorage](https://code.visualstudio.com/api/extension-capabilities/common-capabilities)
- [VS Code Extension API：FileSystemWatcher](https://code.visualstudio.com/api/references/vscode-api)
- [VS Code：Workspace Trust](https://code.visualstudio.com/api/extension-guides/workspace-trust)
- [QTS 5.2 User Guide：WebDAV 与服务配置](https://docs.qnap.com/operating-system/qts/5.2.x/qts5.2.x-ug-en-us.pdf)
- [QTS 5.2：配置 WebDAV](https://docs.qnap.com/operating-system/qts/5.2.x/en-us/configuring-webdav-settings-CDDF133D.html)
- [QTS 5.2：配置 SSH/SFTP（仅管理员账户）](https://docs.qnap.com/operating-system/qts/5.2.x/en-us/configuring-ssh-connections-928DF42B.html)
- [rclone GitHub 仓库](https://github.com/rclone/rclone)
