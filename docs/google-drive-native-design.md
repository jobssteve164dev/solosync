# SoloSync 原生 Google Drive 连接与登录设计

## 目标

用户选择 **Google Drive** 后，只完成一个动作：登录 Google 并授权 SoloSync 保存备份。SoloSync 自动创建并使用 `SoloSync Backups` 文件夹，不再要求用户选择电脑上的同步目录，也不要求理解 OAuth、文件 ID 或上传会话。

连接完成后，备份、历史、校验和恢复继续使用现有 SoloSync 入口；Google Drive 只是备份位置，不形成第二套操作方式。

## 当前实现

`googleDrive` 已使用 Google 登录与 Drive API，不再调用本地文件夹选择器，也不依赖 Google Drive for desktop。系统会根据宿主环境自动选择本地 loopback 或 HTTPS 回调，用户始终只看到同一个 Google Drive 连接动作。

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

本地桌面 VS Code 使用 loopback 回调。Remote SSH、Dev Container、Coder、code-server 与 Web Extension 宿主使用 `https://solosync.szlk.uk/oauth/google/callback`：授权页返回一个短时、一次性使用的 SoloSync 回调码，用户将它粘贴回同一个连接提示。该码绑定当前连接请求的 PKCE verifier，不是 Google 已停用的 OOB 授权码。

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
- 原生云端备份会在冻结内容前扫描 `.env`、`.env.*`、`*.pem`、`*.key`、`id_rsa*` 等高风险文件。尚无持久决策的新命中会让用户选择“排除这些路径（推荐）”“始终包含这些路径”或“取消备份”；选择按项目和精确相对路径保存，后续新增路径仍会再次询问，并可在设置页撤销。
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

- 使用 Web application OAuth client、Authorization Code 与 PKCE `S256`，回调地址固定为 `https://solosync.szlk.uk/oauth/google/callback`。
- 无状态 Cloudflare Worker 校验并封装短时 state/callback code；callback code 绑定 PKCE challenge 且十分钟过期。
- Worker 仅在换取、刷新或撤销令牌时短暂解封 refresh token，返回给扩展的是 AES-GCM 封装的 opaque credential；服务端不持久化用户令牌，不使用 KV/D1。
- 备份上传、校验与恢复由扩展直接访问 Drive API，不经过 Worker。
- 不使用 Google 已停用的 OOB 流程、自定义 URI scheme 或面向受限输入设备的 Device Authorization Flow。

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

Drive 的物理布局使用内容寻址，并把所有项目的小型快照记录集中到唯一历史目录。`lifecycle` 属性区分未发布与已提交状态：

```text
SoloSync Backups/
  Backup History/                   role=history, format=2（全局唯一）
    <snapshot-time-and-id>.json     role=snapshot, format=2, lifecycle=staging|committed
    Previous File Versions/         role=version-history, format=2（全局唯一）
      <name>.<hash-prefix>.<ext>    role=object（不可变恢复内容）
  <project-name>/                   role=project, projectId=...
    <relative-path>/                role=current-directory（单根项目直接从相对路径开始）
      <original-file-name.ext>      role=current, contentSha256=..., sourcePathHash=...（当前内容）
    <workspace-root>/               role=current-directory（仅多根项目保留根名称）
      <relative-path>/              role=current-directory
```

`objects/<sha256>`、`staging/<snapshot-id>/manifest.json` 与 `snapshots/<snapshot-id>/manifest.json` 都是 provider 的虚拟 key。不可变 object 从创建起就位于 `Backup History/Previous File Versions`，相同内容只保存一份并供所有历史快照恢复。project folder 里的 `current` 是独立的用户可读副本：单根项目直接镜像根内相对路径，多根项目才保留各 workspace root 名称，所以既不重复单一根目录，也不会让不同根的同名路径冲突。来源身份仍由完整 root + 相对路径计算，布局迁移不会改变稳定 Drive ID。内容变化在 snapshot 发布后通过 `files.update` 原位替换，不新增同名当前文件。新快照 manifest 直接映射成 `Backup History` 下带时间与 ID 的单个 JSON record，不再为每次自动备份创建目录，也不再反复出现同名 `manifest.json`。0.0.13 的冗余单根目录在下次备份时整体移动到 `Backup History` 并标记为旧布局，目录中任何额外内容都会原样保留，不根据当前权限范围内的“空目录”判断执行删除。0.0.12 留在 project folder 的 object 会在下次备份迁移进文件历史。旧 format-1 snapshot 目录保持可读、可校验和可恢复。

根文件夹 ID 存入 `globalState`。即使用户在 Drive 中重命名或移动文件夹，SoloSync 仍按稳定 ID 访问。若 ID 不可用，则按 app-private `appProperties` 搜索；找不到时提示用户重新创建，不静默改用同名陌生文件夹。

连接时分页查询根标记，按 `createdTime`、file ID 选择唯一 canonical root。历史目录也参与确定性归并：若重复根或并发窗口产生多个 `Backup History`，先把记录按 project ID、snapshot ID、正文哈希和 lifecycle 收敛到 canonical root；相同正文但状态不同的记录保留 committed 版本。随后才归档重复历史目录和重复根。若重复根含有 SoloSync 标记的项目目录，则按下面的项目合并规则逐项移动到 canonical root 并回读验证。发现未知对象、ID 冲突或内容冲突时停止合并并进入“需要修复”，禁止自动删除或覆盖数据。

项目目录按实际访问惰性解析并在扩展会话内缓存稳定 ID，避免同一备份反复逐层查询。若查询发现重复项目目录，再按 `createdTime`、file ID 确定 canonical 对象并进入归并流程；正常单项目路径不扫描无关历史。

每个由 SoloSync 创建的对象写入最小 `appProperties`：

```json
{
  "product": "solosync",
  "role": "root|history|version-history|project|snapshot|object|current-directory|current|file",
  "format": "1|2",
  "projectId": "...",
  "snapshotId": "...",
  "logicalKeyHash": "...",
  "contentSha256": "...",
  "sourcePathHash": "...",
  "lifecycle": "staging|committed"
}
```

字段按角色填写：root/history/version-history 不需要 project/snapshot/lifecycle，project 不需要 snapshot/lifecycle；不可变 object 填写 project ID、logical key hash 和 content SHA-256，但不绑定单个 snapshot；current 额外填写 sourcePathHash、content SHA-256 和最近 snapshot ID；snapshot record 与旧格式子文件填写完整的 project ID、snapshot ID、logical key hash，snapshot 还必须填写 lifecycle。根、项目、内容对象和旧快照使用既有 format 1；集中历史目录、文件历史目录与直接 manifest record 使用 format 2。

文件和文件夹始终以 Drive file ID 为身份，名称只用于用户可读展示，不作为唯一定位依据。

### 逻辑 key 与唯一对象

Drive 允许同一父目录下存在重名文件，所以每个逻辑 key 必须映射到唯一、可重试的 file ID，禁止按名称取查询结果中的“第一个”：

- provider 只接受 `SoloSync/` 下的逻辑 key；去掉此前缀后从根 folder ID 开始解析。
- `appProperties` 增加不可逆的 `logicalKeyHash`，并同时校验父 folder ID、`role`、`projectId` 与 `snapshotId`。算法固定为：将仓库产生的 logical key 规范为 `/` 分隔的 POSIX 相对 key，拒绝 `.`、`..`、空段和反斜杠，对其原始 Unicode code point 与大小写不做宿主相关转换，再计算 UTF-8 字节的 SHA-256 小写十六进制；Windows、macOS、Linux 对同一 key 必须得到相同值。
- 创建对象前通过一次 `files.generateIds(count=100)` 批量预留 ID；每个实际使用的 ID 分配后立即写入持久任务记录，再用该 ID 创建。请求响应丢失时先 `files.get(id)`；若对象存在且属性一致，视为创建已完成；不存在才重试创建。未使用的内存预留 ID 可在进程结束时自然丢弃，不对应任何远端文件。
- 对不可变快照文件，一个逻辑 key 在任务生命周期内始终使用同一个预留 ID。若重试返回冲突，只接受属性完全匹配的该 ID，不能另建同名对象。
- Google Drive backend 不创建共享可变的 `project.json`。项目列表、最近备份时间和历史始终从唯一 `Backup History` 下 `lifecycle=committed` 的 record 以及旧版项目快照目录共同派生，避免两个设备的读后写覆盖竞态。现有仓库读取 `project.json` 的快速路径对该 backend 关闭，使用已有的快照发现回退能力。
- 如果任务私有对象查询出多个相同 `logicalKeyHash`，只能使用任务账本记录的 ID；没有可证明的 canonical ID 时，将连接标记为“需要修复”并阻止发布新快照。root/project 的共享对象使用前述确定性选主与验证后合并规则。禁止任意选一个、覆盖冲突对象或删除未经验证的数据。

### Provider 映射

新增 `GoogleDriveProvider`，继续实现现有 `StorageProvider`，不改变快照仓库的用户心智：

- `createDirectory("SoloSync/<project>")`：以父 ID、role 和 logical key hash 幂等创建物理 project folder，并执行确定性选主。
- `createDirectory("SoloSync/<project>/staging")` 与 `createDirectory("SoloSync/<project>/snapshots")`：先幂等确保 canonical project folder 已存在（覆盖当前仓库首次备份不会单独创建 project key 的调用顺序），再成功返回；对中间容器本身是虚拟 no-op，绝不创建这两个物理 folder。
- `createDirectory("SoloSync/<project>/objects")`：确保 project folder 已存在后返回；objects 同样是虚拟容器。
- `createDirectory("SoloSync/<project>/staging/<snapshot-id>")`：确保唯一 `Backup History` 存在并为 manifest record 预留稳定 ID；该逻辑目录本身不创建物理 snapshot folder。
- `writeFile("SoloSync/<project>/objects/<sha256>")`：只在对象不存在时上传到 `Previous File Versions`，显示名附加哈希前缀，上传响应和后续批量列表返回服务端 SHA-256，后续 snapshot 直接复用该稳定对象。
- `reconcileFiles`：一次分页按 app properties 列出该项目全部不可变内容对象，按 logical key hash 与 Drive 返回的 SHA-256 校验当前快照引用；新上传对象再执行一次同类列表确认。校验不再为每个未变化文件分别查询和下载正文。
- `syncVisibleFiles`：仅在 snapshot 成为 committed 后运行，先确认它仍是最新 committed snapshot，再按完整来源相对路径建立目录和 current 身份；首次创建后复查并收敛并发重复项，后续变化在写入前重读稳定 ID，并对同一 ID 执行内容 `PATCH`。写入结束后再次读取最新 committed snapshot；若另一个客户端在本次写入期间发布了更新快照，则从不可变历史重建最新 current，确保交错完成的替换最终收敛到最新内容。删除的来源路径只移除 current，不影响历史快照引用的 object。
- `writeFile(".../staging/<snapshot-id>/manifest.json")`：直接在唯一 `Backup History` 下写入 `<snapshot-id>.json` record，保留同一预留 ID 用于响应丢失后的幂等恢复。
- `exists/list(".../staging")`：把历史目录中 `lifecycle=staging` 的 format-2 records 与项目目录下旧版 staging snapshot folders 投影为统一逻辑目录；`exists/list(".../snapshots")` 同样合并 committed record 与旧目录，并消费全部分页。
- `exists/list`、对象读写以及旧格式 `files/...` key 都通过 project ID、snapshot ID、lifecycle、logical key hash 和任务账本解析到稳定 Drive ID，不能按显示名遍历猜测。
- `writeFile`：5 MiB 内使用单请求 multipart upload；更大文件使用 resumable upload，避免网络中断后整文件重传。
- `openReadStream` / `downloadFile`：通过 `files.get?alt=media` 流式读取；仓库的远端 SHA-256 校验和恢复写盘都消费流，不能把大文件完整装入 `Buffer`。
- `readSmallFile`：只用于 manifest 等有 1 MiB 上限的元数据；通用仓库在其他 backend 也可用它读取 `project.json`，Google backend 自身不创建该文件。超限立即报出可定位错误。
- `list` / `exists`：限定父文件夹、`trashed=false` 和 app properties 查询，并消费全部 `nextPageToken`。
- `move`：对稳定 manifest record（或旧版 snapshot folder）更新 `lifecycle=committed` 和 logical key hash，把虚拟 staging key 原子发布为虚拟 snapshots key。
- `delete`：只允许删除已解析到 SoloSync 根目录以内的对象；禁止删除根目录。

所有请求显式选择必要 `fields`。首版只支持 **My Drive**；Shared Drives 需要额外的文件夹选择、capabilities 和 `supportsAllDrives` 契约，不能在未验证前假装支持。

### 可跨重启的备份任务

Google Drive 备份使用可跨重启恢复的持久任务：

```text
globalStorage/pending/<project-id>/
  job.json
  manifest.json
  files/...
```

- snapshot ID 只在任务创建时生成一次。工作区文件复制到上述稳定目录后冻结；后续重试和恢复都使用同一份副本，避免用户修改工作区导致同一个快照内容漂移。
- 创建冻结副本前检查 `globalStorageUri` 所在卷的可用空间；至少满足预计副本大小加固定安全余量，否则在复制前提示所需和可用空间，不留下半份任务。估算后若仍因 `ENOSPC` 或其他本地写入错误中断，精确清理由本次创建且尚未进入上传阶段的 pending 目录并核对无残留。pending 目录使用宿主可提供的最小权限（POSIX 目录 `0700`、文件 `0600`；其他平台继承 VS Code 用户数据目录 ACL）。
- `job.json` 记录 project ID、snapshot ID、项目名、创建时间、总大小、状态，以及由稳定 Google 账号身份和 canonical root ID 组成的目标身份；上传 session URI 与每个逻辑 key 的预留 Drive ID 分别保存在 `SecretStorage` 和扩展全局状态中。
- 用户继续备份或同一项目再次触发备份时，先验证本地副本与 manifest，再查询服务端上传状态，按 Google 返回的 `Range` 继续；本地不把缓存 offset 当作服务端已接收字节数的事实来源。
- resumable session 可能在约一周后过期。收到 `404`/`410` 或任务年龄超过安全窗口时，先按预留 file ID 查询：对象已完整存在则核验并继续；否则用同一预留 ID 建立新会话并从服务端确认的起点上传。
- 发布是显式状态机：`uploading -> verified -> publishing -> committed`。`files.update` 响应丢失或扩展在发布中退出时，恢复流程按 snapshot ID 和 app properties 解析稳定 folder，校验 manifest 与全部文件哈希；已经是 `committed` 就视为发布成功并进入最终清理，仍是 `staging` 才重试发布，属性不一致则停止并保留冻结副本。
- 只有快照完整校验并确认已发布后才删除本地 pending 目录、任务记录和 session secret。用户主动取消或确认放弃不可恢复任务时，只清理本地 pending、session secret 和仍为 `staging` 且属于本任务的远端对象；按稳定 ID 确认已处于 `committed` 的对象永不进入取消清理。暂时性网络、限流或扩展退出必须保留任务以便恢复。
- 设置页显示 pending 任务占用空间、创建时间和状态，提供“继续”和经确认的“放弃待上传备份”；成功、取消或放弃后都必须核对本地空间已释放。
- 启动恢复、手动重试和新建备份必须按 project ID 加锁；已有 pending 任务时继续该任务，不得生成另一个 snapshot ID。

### 上传与恢复

- 5 MiB 内的对象和 manifest 使用一次 multipart upload；更大的对象使用 resumable upload，分块为 8 MiB（仍是 Google 要求的 256 KiB 倍数）。
- 初始化上传只把 `Location` session URI 视为结果，不能假定此时已经得到文件资源；文件 ID 必须在初始化前预留并持久化。
- `401` 只刷新一次令牌；`403 rateLimitExceeded`、`403 userRateLimitExceeded`、`429` 和 `5xx` 使用带抖动的指数退避，并尊重 `Retry-After`。
- 上传完成后核对 Drive 返回的 file ID 和大小；新内容对象在 snapshot 发布前通过流式读取执行 SHA-256 完整性检查。已经由既有已发布 snapshot 引用的同哈希对象直接复用，显式“验证快照”仍会逐对象重新校验。
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
- `objects`/`staging`/`snapshots` 只作为 provider 的虚拟 key 存在；Drive 中没有这三个物理容器，列表按 snapshot 的 `lifecycle` 正确投影。
- refresh token 不出现在设置、日志、错误、备份内容或崩溃信息中。
- “断开此设备”不影响另一台已登录设备；“撤销全部授权”经确认后让所有设备在下次访问时进入“需要重新登录”，两者都不删除备份。
- 令牌刷新、`invalid_grant`、Workspace 管理员拒绝、403 两类限流、429、5xx、上传响应丢失、上传 session 过期、扩展重启和主动取消均有自动化测试。
- 模拟同名对象、两台设备同时创建根/项目目录和同时为同一项目备份：不能任意选择重复对象，项目目录最终收敛到 canonical ID，两个有效 snapshot 都可发现，冲突对象不能被覆盖或删除。
- 全新账号第一次备份时，即使仓库只调用虚拟 `objects`/`staging`/`snapshots` 容器，也会自动建立唯一 canonical project folder 与唯一历史目录；单页且无节流时，包含首次连接、目录创建和一次性布局标记的全新空项目最多使用 26 个远端请求，活跃连接上的一个变化小文件最多 23 个，重复未修改快照最多 12 个，重连后执行未修改快照最多 22 个。
- 更新既有 current 最多使用 15 个远端请求；变化回历史中已有内容时最多 12 个，仍低于 30 次链路预算。
- Drive 项目目录里的 current 显示原文件名与扩展名；不可变历史 object 使用文件名加短哈希避免历史目录里的同名混淆。
- Drive backend 不创建或依赖 `project.json`；项目列表、最近时间、历史与新设备恢复从 committed history records 与旧版 committed snapshot folders 合并派生。
- 在上传第一个分块、中间分块、服务端已接收但客户端未收到响应、上传完成但发布前、发布成功但客户端未收到响应五个位置分别强制退出；重启后复用同一 snapshot ID、manifest record ID 和稳定本地副本，从服务端 `Range` 或稳定 Drive ID 的实际状态恢复。
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
