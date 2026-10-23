# SoloSync 原生 Google Drive 连接与登录设计

## 目标

用户选择 **Google Drive** 后，只完成一个动作：登录 Google 并授权 SoloSync 保存备份。SoloSync 自动创建并使用 `SoloSync Backups` 文件夹，不再要求用户选择电脑上的同步目录，也不要求理解 OAuth、文件 ID 或上传会话。

连接完成后，备份、历史、校验和恢复继续使用现有 SoloSync 入口；Google Drive 只是备份位置，不形成第二套操作方式。

## 当前实现与目标状态

当前 `googleDrive` 选项仍然调用本地文件夹选择器，实际依赖 Google Drive for desktop。它没有 Google 登录、Drive API 或云端连接状态。

目标状态：

| 用户动作 | 系统结果 |
| --- | --- |
| 选择 Google Drive | 打开系统浏览器完成 Google 授权 |
| 授权成功 | 自动创建或找回 `SoloSync Backups`，完成读写测试 |
| 开始备份 | 直接上传到 Drive，不依赖桌面同步软件 |
| 浏览与恢复 | 从同一 Drive 文件夹发现、校验并下载快照 |
| 断开此设备 | 只清除本机令牌和待上传会话，不影响其他设备，不删除备份 |
| 撤销全部授权 | 经二次确认后撤销 SoloSync 的 Google 授权；所有设备都需要重新登录 |

## 用户体验

### 首次连接

1. 用户在“备份位置”选择 **Google Drive**。
2. SoloSync 显示一句必要说明：将只能管理 SoloSync 创建或用户明确交给它的 Drive 文件。
3. 用户点击 **使用 Google 登录**，系统浏览器打开 Google 授权页；禁止在 webview 内嵌登录页。
4. 授权返回后，SoloSync 自动创建或找回 `SoloSync Backups` 文件夹，执行创建、上传、读取、重命名和删除临时对象的连接测试。
5. 成功状态显示 Google 账号、`SoloSync Backups` 和“已连接”。不再弹出本地文件夹选择器。

首个可发布版本只承诺本地桌面 VS Code 的原生登录。Remote SSH、Dev Container 与 code-server 不把桌面的 loopback 回调或自定义 URI scheme 硬套到远端，也不在 Google 尚未确认适用性时把 Limited Input Device Flow 当成正式方案。界面仍保持同一个“使用 Google 登录”入口；运行环境不受支持时，直接说明“当前环境暂不支持 Google Drive 登录”，不退回本地文件夹选择器，也不让用户选择 OAuth 类型。

### 设置页

Google Drive 连接后，设置页增加一项：

```text
Google Drive 连接
name@example.com · SoloSync Backups · 已连接
```

可执行动作只有：

- 打开备份文件夹
- 测试连接
- 重新登录
- 断开此设备
- 撤销全部授权

令牌失效时显示“需要重新登录”，自动备份暂停并保留待备份状态；不得反复弹出授权窗口或把认证失败显示成备份损坏。

## 数据安全边界

- HTTPS 保护上传和下载过程，但首版不提供客户端加密。Drive 中的备份可由所登录账号以及该文件夹的协作者读取。
- 原生云端备份新增敏感文件检查：每次冻结备份内容前扫描 `.env`、`.env.*`、`*.pem`、`*.key`、`id_rsa*` 等高风险文件。尚无持久决策的新命中必须让用户选择“排除这些路径（推荐）”“始终包含这些路径”或“取消备份”；选择按项目和精确相对路径持久保存，后续新增路径仍会再次询问，并可在设置页撤销。当前代码只有风险提示，这项检查属于实现范围，不能写成已有能力。
- 根文件夹默认创建在用户 My Drive，文件归用户所有并占用其 Drive 配额。若用户后来把根文件夹移动到共享位置或扩大权限，设置页显示“此备份文件夹已共享”，但不擅自修改用户的 Drive 权限。
- `drive.file` 限制 SoloSync 的 API 访问范围，不等于对备份内容进行加密。

## 授权设计

### 权限

只申请：

```text
https://www.googleapis.com/auth/drive.file
```

该权限允许 SoloSync 管理自己创建的文件，以及用户明确交给它的文件；不申请可读取整个云盘的 `drive` 或 `drive.readonly`。账号显示名和邮箱通过 Drive `about.get(fields=user)` 获取，不额外申请全盘权限。

### 本地桌面环境

- Google Cloud OAuth 客户端类型：Desktop app。
- 使用系统浏览器、Authorization Code、PKCE `S256`、随机 `state` 和随机 loopback 端口。
- 回调只监听 `127.0.0.1`，校验 `state` 后立即停止监听。
- 桌面客户端属于 public client；不得把客户端密钥当作可保密凭据。

### 远程与 code-server 环境

Google 的 Device Authorization Flow 文档面向电视、游戏机、打印机等受限输入设备；不能只因为它技术上允许 `drive.file`，就推断 Remote SSH、Dev Container 或 code-server 可以合规发布。VS Code 的 `asExternalUri` 也可能产生动态回调地址，而 Google 的 installed-app 流程已不支持自定义 URI scheme，因此首版采用明确的发布门槛：

- 认证层先抽象为 `GoogleAuthTransport`，本地桌面只实现并发布 `DesktopLoopbackTransport`。
- `DeviceCodeTransport` 可用于开发验证，但在取得 Google 对目标环境和 OAuth client 类型的书面确认、完成应用验证并通过真实远程环境验收前，不进入生产包。
- 若后续获准启用 Device Flow，必须遵守服务端返回的轮询 `interval`、`slow_down` 与过期时间；取消连接立即停止轮询。
- 不建设保存用户 Google 令牌的中转服务，也不使用已停止支持的自定义 URI scheme。

这个限制只影响可登录的宿主环境，不改变备份位置的统一心智，也不允许重新暴露“请选择同步文件夹”。

### 令牌生命周期

- refresh token 只存入 VS Code `SecretStorage`；access token 只保存在内存中。
- 普通配置只保存账号显示信息、授权方式和 Drive 文件夹 ID，不保存任何令牌。
- 刷新返回 `invalid_grant` 时删除失效的 access token 和 refresh token，将连接状态改为“需要重新登录”，但保留账号、文件夹 ID 和远端备份。
- “断开此设备”只清除本机 refresh token、access token 和上传 session URI，保留非敏感账号/根目录信息用于重新连接；不调用 revoke endpoint，也不影响其他设备。
- “撤销全部授权”必须二次确认并明确说明同一 Google Cloud 项目下的其他 SoloSync 设备也会失去授权；调用 revoke endpoint 后清除本机令牌。无论撤销请求是否成功，都不删除远端备份，但必须如实显示撤销结果。
- 日志不得记录授权码、device code、access token、refresh token、上传 session URI 或文件正文。

## Drive 存储模型

### 根目录

首次连接在用户的 My Drive 中创建可见文件夹。现有仓库传给 provider 的逻辑 key 都以 `SoloSync/` 开头；Google provider 把这一前缀直接挂载到根文件夹 ID，不再在根目录内重复创建第二层 `SoloSync`。

Drive 的物理布局不复制文件系统 backend 的中间目录。项目目录下直接放快照目录，`lifecycle` 属性区分未发布与已提交状态：

```text
SoloSync Backups/
  <project-name>/                   role=project, projectId=...
    <snapshot-time-and-id>/         role=snapshot, lifecycle=staging|committed
      manifest.json
      files/...
```

根文件夹 ID 存入 `globalState`。即使用户在 Drive 中重命名或移动文件夹，SoloSync 仍按稳定 ID 访问。若 ID 不可用，则按 app-private `appProperties` 搜索；找不到时提示用户重新创建，不静默改用同名陌生文件夹。

创建后必须重新分页查询根标记，处理两台设备同时首次连接的竞争：按 `createdTime`、file ID 选择唯一 canonical root。每次连接都重新对账；若重复根含有 SoloSync 标记的项目目录，则先按下面的项目合并规则逐项移动到 canonical root 并回读验证，只移除已经为空且确由 SoloSync 创建的重复根。发现未知对象、ID 冲突或内容冲突时停止合并并进入“需要修复”，禁止自动删除或覆盖数据。

项目目录使用同一套“创建后重新查询并选主”规则，canonical 顺序同样是 `createdTime`、file ID。每次列出、创建或发布快照前都重新对账项目目录：若出现含数据的重复项目目录，把其中由 SoloSync 标记、ID 不冲突的 snapshot 子目录逐一移动到 canonical 项目目录；移动后逐项按 snapshot ID 回读验证，再移除已经为空且确由 SoloSync 创建的重复目录。发现同 snapshot ID 但 file ID 或内容不一致时停止合并并进入“需要修复”，绝不覆盖或删除。这样两台设备并发备份同一项目会产生两个有效 snapshot，而不会各自长期依赖不同项目目录。

每个由 SoloSync 创建的对象写入最小 `appProperties`：

```json
{
  "product": "solosync",
  "role": "root|project|snapshot|file",
  "format": "1",
  "projectId": "...",
  "snapshotId": "...",
  "logicalKeyHash": "...",
  "lifecycle": "staging|committed"
}
```

字段按角色填写：root 不需要 project/snapshot/lifecycle，project 不需要 snapshot/lifecycle；snapshot 和其子文件必须填写完整的 project ID、snapshot ID、logical key hash，snapshot 还必须填写 lifecycle。

文件和文件夹始终以 Drive file ID 为身份，名称只用于用户可读展示，不作为唯一定位依据。

### 逻辑 key 与唯一对象

Drive 允许同一父目录下存在重名文件，所以每个逻辑 key 必须映射到唯一、可重试的 file ID，禁止按名称取查询结果中的“第一个”：

- provider 只接受 `SoloSync/` 下的逻辑 key；去掉此前缀后从根 folder ID 开始解析。
- `appProperties` 增加不可逆的 `logicalKeyHash`，并同时校验父 folder ID、`role`、`projectId` 与 `snapshotId`。算法固定为：将仓库产生的 logical key 规范为 `/` 分隔的 POSIX 相对 key，拒绝 `.`、`..`、空段和反斜杠，对其原始 Unicode code point 与大小写不做宿主相关转换，再计算 UTF-8 字节的 SHA-256 小写十六进制；Windows、macOS、Linux 对同一 key 必须得到相同值。
- 创建对象前调用 `files.generateIds` 预留 ID，将 ID 写入持久任务记录，再用该 ID 创建。请求响应丢失时先 `files.get(id)`；若对象存在且属性一致，视为创建已完成；不存在才重试创建。
- 对不可变快照文件，一个逻辑 key 在任务生命周期内始终使用同一个预留 ID。若重试返回冲突，只接受属性完全匹配的该 ID，不能另建同名对象。
- Google Drive backend 不创建共享可变的 `project.json`。项目列表、最近备份时间和历史始终从 canonical 项目目录下 `lifecycle=committed` 的 snapshot 与 manifest 派生，避免两个设备的读后写覆盖竞态。现有仓库读取 `project.json` 的快速路径对该 backend 关闭，使用已有的快照发现回退能力。
- 如果任务私有对象查询出多个相同 `logicalKeyHash`，只能使用任务账本记录的 ID；没有可证明的 canonical ID 时，将连接标记为“需要修复”并阻止发布新快照。root/project 的共享对象使用前述确定性选主与验证后合并规则。禁止任意选一个、覆盖冲突对象或删除未经验证的数据。

### Provider 映射

新增 `GoogleDriveProvider`，继续实现现有 `StorageProvider`，不改变快照仓库的用户心智：

- `createDirectory("SoloSync/<project>")`：以父 ID、role 和 logical key hash 幂等创建物理 project folder，并执行确定性选主。
- `createDirectory("SoloSync/<project>/staging")` 与 `createDirectory("SoloSync/<project>/snapshots")`：先幂等确保 canonical project folder 已存在（覆盖当前仓库首次备份不会单独创建 project key 的调用顺序），再成功返回；对中间容器本身是虚拟 no-op，绝不创建这两个物理 folder。
- `createDirectory("SoloSync/<project>/staging/<snapshot-id>")`：使用任务账本中的预留 ID，在 project folder 下直接创建 `lifecycle=staging` 的物理 snapshot folder。
- `createDirectory("SoloSync/<project>/staging/<snapshot-id>/files/.../<directory>")`：为 snapshot 内的每一级物理目录预生成 Drive ID 并在请求前写入任务账本；以父 ID、logical key hash 和预留 ID 幂等创建。响应丢失时按预留 ID 回读并核对父级/属性，规则与文件创建一致。committed snapshot 下不允许再创建目录。
- `exists/list(".../staging")`：只投影 canonical project folder 下 `lifecycle=staging` 的直接 snapshot 子目录；`exists/list(".../snapshots")` 只投影 `lifecycle=committed` 的直接 snapshot 子目录，并消费全部分页。
- `exists/list`、文件读写以及更深层的 `files/...` key 都先通过 project ID、snapshot ID、lifecycle 和任务账本解析到稳定 Drive ID，不能按显示名遍历猜测。
- `writeFile`：创建 blob 文件；使用 resumable upload，避免网络中断后整文件重传。
- `openReadStream` / `downloadFile`：通过 `files.get?alt=media` 流式读取；仓库的远端 SHA-256 校验和恢复写盘都消费流，不能把大文件完整装入 `Buffer`。
- `readSmallFile`：只用于 manifest 等有 1 MiB 上限的元数据；通用仓库在其他 backend 也可用它读取 `project.json`，Google backend 自身不创建该文件。超限立即报出可定位错误。
- `list` / `exists`：限定父文件夹、`trashed=false` 和 app properties 查询，并消费全部 `nextPageToken`。
- `move`：对稳定 snapshot folder ID 更新名称、canonical project parent 和 `lifecycle=committed`，把虚拟 staging key 发布为虚拟 snapshots key。
- `delete`：只允许删除已解析到 SoloSync 根目录以内的对象；禁止删除根目录。

所有请求显式选择必要 `fields`。首版只支持 **My Drive**；Shared Drives 需要额外的文件夹选择、capabilities 和 `supportsAllDrives` 契约，不能在未验证前假装支持。

### 可跨重启的备份任务

当前仓库每次备份都会生成新 snapshot ID，把源文件复制到系统临时目录，并在 `finally` 中删除本地副本；仅保存上传 URI 无法在扩展重启后真正续传。实现原生 Drive 时必须同时引入持久备份任务：

```text
globalStorage/pending/<snapshot-id>/
  job.json
  manifest.json
  files/...
```

- snapshot ID 只在任务创建时生成一次。工作区文件复制到上述稳定目录后冻结；后续重试和恢复都使用同一份副本，避免用户修改工作区导致同一个快照内容漂移。
- 创建冻结副本前检查 `globalStorageUri` 所在卷的可用空间；至少满足预计副本大小加固定安全余量，否则在复制前提示所需和可用空间，不留下半份任务。估算后若仍因 `ENOSPC` 或其他本地写入错误中断，精确清理由本次创建且尚未进入上传阶段的 pending 目录并核对无残留。pending 目录使用宿主可提供的最小权限（POSIX 目录 `0700`、文件 `0600`；其他平台继承 VS Code 用户数据目录 ACL）。
- `job.json` 记录 project ID、snapshot ID、manifest hash、远端 snapshot folder ID、每个逻辑 key 的预留 Drive ID、大小、源指纹、状态和重试次数；上传 session URI 单独按任务和文件保存在 `SecretStorage`。
- 扩展启动时扫描 pending 任务，先验证本地副本与 manifest，再查询服务端上传状态，按 Google 返回的 `Range` 继续；本地记录的 offset 只能辅助展示，不能作为服务端已接收字节数的事实来源。
- resumable session 可能在约一周后过期。收到 `404`/`410` 或任务年龄超过安全窗口时，先按预留 file ID 查询：对象已完整存在则核验并继续；否则用同一预留 ID 建立新会话并从服务端确认的起点上传。
- 发布是显式状态机：`uploading -> verified -> publishing -> committed`。`files.update` 响应丢失或扩展在发布中退出时，恢复流程按稳定 snapshot folder ID 执行 `files.get`，校验 canonical project parent、名称和 `lifecycle`；已经是 `committed` 就视为发布成功并进入最终清理，仍是 `staging` 才重试发布，ID 丢失或属性不一致则进入“需要修复”。
- 只有快照完整校验并确认已发布后才删除本地 pending 目录、任务记录和 session secret。用户主动取消或确认放弃不可恢复任务时，只清理本地 pending、session secret 和仍为 `staging` 且属于本任务的远端对象；按稳定 ID 确认已处于 `committed` 的对象永不进入取消清理。暂时性网络、限流或扩展退出必须保留任务以便恢复。
- 设置页显示 pending 任务占用空间、创建时间和状态，提供“继续”和经确认的“放弃待上传备份”；成功、取消或放弃后都必须核对本地空间已释放。
- 启动恢复、手动重试和新建备份必须按 project ID 加锁；已有 pending 任务时继续该任务，不得生成另一个 snapshot ID。

### 上传与恢复

- 所有备份文件使用 resumable upload；分块除最后一块外使用 256 KiB 的倍数。
- 初始化上传只把 `Location` session URI 视为结果，不能假定此时已经得到文件资源；文件 ID 必须在初始化前预留并持久化。
- `401` 只刷新一次令牌；`403 rateLimitExceeded`、`403 userRateLimitExceeded`、`429` 和 `5xx` 使用带抖动的指数退避，并尊重 `Retry-After`。
- 上传完成后核对 Drive 返回的 file ID、大小与 `md5Checksum`；快照发布前通过流式读取继续执行 manifest/SHA-256 完整性检查。
- Drive API 调用全部接受 `AbortSignal`。取消只清理本轮 staging 和持久任务，不影响任何 committed 快照。

## 模块边界

建议新增：

```text
src/googleAuth.ts           OAuth、刷新、撤销与账号状态
src/googleDriveClient.ts    Drive REST、分页、重试、可续传上传
src/googleDriveProvider.ts  StorageProvider 适配
src/backupJobStore.ts       持久任务、本地冻结副本与启动恢复
src/sensitiveFileReview.ts  云端备份前的敏感文件扫描与排除决策
```

现有模块只做最小接线：

- `extension.ts`：把 Google Drive 选项从本地目录选择改为登录连接；解析 provider。
- `backupSettings.ts`：显示账号、文件夹与重连/断开动作。
- `storageProvider.ts`：增加流式读取和受限元数据读取契约，不塞入 Google 专用授权逻辑。
- `snapshotRepository.ts`：snapshot ID 与本地冻结副本跨重试复用；远端校验和恢复改为流式处理，并按失败类型决定保留或清理 pending 任务。
- `package.json`：增加 Google Drive 连接与断开命令；OAuth client ID 作为非秘密构建配置注入。

## Google Cloud 上线准备

1. 分别建立开发与生产 Google Cloud 项目。
2. 启用 Google Drive API。
3. 配置 External OAuth consent screen，仅声明 `drive.file`。
4. 创建 Desktop app OAuth client。Limited Input Device client 只用于非生产验证，是否进入发布包取决于 Google 对 Remote SSH、Dev Container 与 code-server 场景的确认。
5. 在自有且已验证域名提供产品主页、隐私政策和服务条款；隐私政策明确 Drive 数据用途、令牌保存和断开行为。
6. 测试阶段只允许登记的测试账号；公开发布前完成品牌/应用验证并切换到 In production。

## 验收标准

- Windows、macOS、Linux 本地 VS Code 均能通过系统浏览器完成登录并自动返回；回调只能来自 `127.0.0.1` 且错误 `state` 必须被拒绝。
- Remote SSH、Dev Container 与 code-server 在 Google 未批准对应授权拓扑时明确显示“不支持”，不出现本地目录选择器；获批启用后，每种宿主都必须完成真实设备授权、取消、过期和 `slow_down` 验收。
- 登录后不再出现本地文件夹选择器；Drive 中只创建一个可识别的 `SoloSync Backups` 根目录。
- provider 将逻辑 `SoloSync/` 直接挂载到根 folder ID，不生成 `SoloSync Backups/SoloSync/...` 重复目录。
- `staging`/`snapshots` 只作为 provider 的虚拟 key 存在；Drive 中没有这两个物理容器，列表按 snapshot 的 `lifecycle` 正确投影。
- refresh token 不出现在设置、日志、错误、备份内容或崩溃信息中。
- “断开此设备”不影响另一台已登录设备；“撤销全部授权”经确认后让所有设备在下次访问时进入“需要重新登录”，两者都不删除备份。
- 令牌刷新、`invalid_grant`、Workspace 管理员拒绝、403 两类限流、429、5xx、上传响应丢失、上传 session 过期、扩展重启和主动取消均有自动化测试。
- 模拟同名对象、两台设备同时创建根/项目目录和同时为同一项目备份：不能任意选择重复对象，项目目录最终收敛到 canonical ID，两个有效 snapshot 都可发现，冲突对象不能被覆盖或删除。
- 全新账号第一次备份时，即使仓库只调用虚拟 `staging`/`snapshots` 容器，也会自动建立唯一 canonical project folder；包含多层源码目录的项目，其每一级 folder 都有持久预留 ID，并能从创建响应丢失中恢复。
- Drive backend 不创建或依赖 `project.json`；项目列表、最近时间、历史与新设备恢复全部从 committed snapshots 派生。
- 在上传第一个分块、中间分块、服务端已接收但客户端未收到响应、上传完成但发布前、发布成功但客户端未收到响应五个位置分别强制退出；重启后复用同一 snapshot ID 和稳定本地副本，从服务端 `Range` 或 snapshot folder ID 的实际状态恢复。
- 发布响应丢失后，已经标记 `committed` 的 snapshot 被识别为成功；随后点击取消也不能删除它。
- 1 GB 单文件与 1 GB 项目均在受限内存环境完成上传、远端 SHA-256 校验和恢复；内存占用不得随单文件大小线性增长。预检发现磁盘不足或复制途中触发 `ENOSPC` 时都不得留下半份 pending；保留 pending 时设置页显示实际占用，继续/放弃后空间变化可核对。
- 完成备份后，从一台没有原项目的新设备登录同一账号并恢复，逐文件 SHA-256 一致。
- 每次云端备份都检查尚无决策的敏感路径；默认推荐排除，用户明确选择包含后才可上传。已有精确路径决策持续生效，新出现的敏感路径必须再次询问。
- 连接测试产生的临时对象全部清理；任何失败都不能发布不完整快照。

## 明确不做

- 不申请整个 Google Drive 的读写权限。
- 不把 `appDataFolder` 作为备份主目录，因为用户无法在 Drive 中直接看到和管理它。
- 不把 Google Drive for desktop 同步目录继续包装成“原生连接”。
- 不通过 SoloSync 服务端代理备份文件，也不在服务端保存 Google 用户令牌。
- 不在 Google 未确认适用性前，把 Limited Input Device Flow 作为远程环境的生产登录方式。
- 首版不支持 Shared Drives、多账号同时连接、客户端加密或 Google Picker 自选目录。

## 官方依据

- [Google：OAuth 2.0 for Desktop Apps](https://developers.google.com/identity/protocols/oauth2/native-app)
- [Google：OAuth 2.0 for TV and Limited-Input Device Applications](https://developers.google.com/identity/protocols/oauth2/limited-input-device)
- [Google Drive：Choose Google Drive API scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth)
- [Google Drive：Upload file data](https://developers.google.com/workspace/drive/api/guides/manage-uploads)
- [Google Drive：Create and populate folders](https://developers.google.com/workspace/drive/api/guides/folder)
- [Google Drive：Add custom file properties](https://developers.google.com/workspace/drive/api/guides/properties)
- [Google Drive：Resolve errors](https://developers.google.com/workspace/drive/api/guides/handle-errors)
- [Google：OAuth 2.0 Policies](https://developers.google.com/identity/protocols/oauth2/policies)
- [Google：OAuth 2.0 Best Practices](https://developers.google.com/identity/protocols/oauth2/resources/best-practices)
- [VS Code：Supporting Remote Development](https://code.visualstudio.com/api/advanced-topics/remote-extensions)
