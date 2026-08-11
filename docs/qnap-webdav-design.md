# SoloSync QNAP 原生备份设计

## 目标

SoloSync 直接连接用户通过 HTTPS 地址提供的 QNAP 共享文件夹，完成代码项目的版本化备份、历史浏览、完整性校验和恢复。用户只需要理解“连接 QNAP NAS”，不需要选择或理解 WebDAV、HDP、SFTP、适配器或远端对象模型。

本设计的完成标准不是“文件能够上传”，而是：原电脑和原项目目录都不存在时，用户仍能从 QNAP 找到项目、选择快照、校验内容并恢复到新目录。

## 已确认边界

- QNAP 官方 HDP for PC/VM 面向 Windows 整机、磁盘和文件恢复，不提供 SoloSync 所需的通用存储接口，因此不接入 HDP。
- 原生 QNAP 连接使用 QTS/QuTS hero 提供的 WebDAV 文件服务，通过 HTTPS 域名访问。
- SFTP 不作为默认入口。QTS 5.2 的 SSH/SFTP 官方入口只允许管理员账户，不符合插件的最小权限要求。
- 当前本地目录、外接磁盘、操作系统挂载 NAS 和同步目录继续工作，不改变既有路径。
- 首个版本保持现有 `formatVersion: 1` 快照目录结构，不同时引入压缩包、去重、保留策略或客户端加密。
- 插件不配置 QNAP、不修改反向代理，也不管理 QNAP 用户。它只验证用户提供的入口是否具备所需能力。
- 第一版只保存一个默认 QNAP 连接，多个项目可以共享该连接。
- 第一版不自动删除历史快照。取消或失败时，只清理本轮创建的 staging。

## 用户动作

### 连接 QNAP

用户在“设置备份位置”中选择 **QNAP NAS**，然后输入：

1. QNAP 共享文件夹的 HTTPS 地址，例如 `https://backup.example.com/Backups`。
2. 对该共享文件夹具有读写权限的 NAS 用户名。
3. 密码。

插件立即执行连接测试。测试成功后只显示 NAS 地址和当前项目，不显示协议细节。密码只写入 VS Code SecretStorage；地址与用户名写入扩展全局状态，不进入项目设置或日志。

### 创建备份

用户仍然执行“立即备份”，或由 Git 提交和空闲计时触发。SoloSync：

1. 扫描用户明确选择的项目目录。
2. 在扩展临时目录生成只属于本轮的完整 staging，并计算文件 SHA-256。
3. 将 staging 上传到远端 `SoloSync/<project-id>/staging/<snapshot-id>`。
4. 回读远端 manifest，并校验所有远端文件的 SHA-256。
5. 用一次远端移动把 staging 发布到 `snapshots/<snapshot-id>`。
6. 重新列举并确认快照可见后，才显示“已保护”。

临时目录和远端 staging 都只按本轮精确路径清理。不能用清空共享文件夹或删除未知目录作为恢复手段。

### 灾难恢复

“浏览备份”不依赖当前项目目录。用户只要先连接备份位置，就可以：

1. 浏览 `SoloSync/` 下所有具有有效 `project.json` 或有效快照 manifest 的项目。
2. 选择项目和快照。
3. 校验远端内容。
4. 恢复到用户选择的新目录。

恢复得到的项目目录会在本机与原远端 project ID 建立关联，后续备份继续进入同一个项目历史。现有由绝对路径哈希生成的 project ID 保持可读，避免已有备份失效。

## 存储模型

```text
<QNAP WebDAV 共享文件夹>/
  SoloSync/
    <project-id>/
      project.json
      staging/
        <snapshot-id>/
      snapshots/
        <snapshot-id>/
          manifest.json
          files/
            <workspace-root>/...
```

`project.json` 保存：

- 格式版本。
- 稳定 project ID。
- 用户可识别的项目名称。
- 创建时间和最近更新时间。

它不保存本机绝对路径、NAS 凭据或 Git 远端 URL。

新项目使用随机稳定 ID，并在扩展全局状态中记录本机项目路径到 project ID 的关联。若目标位置已经存在当前路径旧算法生成的项目，则沿用旧 project ID。恢复成功后记录恢复目录到原 project ID 的关联。

## 存储接口

快照仓库只依赖统一存储接口，不直接区分 QNAP 和本地目录：

```ts
interface StorageProvider {
  readonly displayName: string;
  readonly localRoot?: string;
  validate(signal?: AbortSignal): Promise<void>;
  exists(key: string, signal?: AbortSignal): Promise<boolean>;
  list(key: string, signal?: AbortSignal): Promise<StorageEntry[]>;
  createDirectory(key: string, signal?: AbortSignal): Promise<void>;
  writeFile(key: string, source: string | Buffer, signal?: AbortSignal): Promise<void>;
  readFile(key: string, signal?: AbortSignal): Promise<Buffer>;
  downloadFile(key: string, destination: string, signal?: AbortSignal): Promise<void>;
  move(source: string, destination: string, signal?: AbortSignal): Promise<void>;
  delete(key: string, signal?: AbortSignal): Promise<void>;
}
```

- `LocalFileSystemProvider` 保留现有目录行为。
- `QnapWebDavProvider` 把 key 映射为共享文件夹内的 URL，禁止 `..`、绝对路径和越出根目录的编码。
- 快照仓库负责业务目录、manifest、校验和发布；provider 只负责存储动作。
- 所有 provider 使用 `/` 作为逻辑 key 分隔符，避免把 Windows 路径规则带到远端。

## WebDAV 能力契约

连接测试必须证明以下动作可用：

- `PROPFIND`：读取根目录与目录内容。
- `MKCOL`：创建目录。
- `PUT`：上传文件。
- `GET`：回读文件。
- `MOVE`：发布快照。
- `DELETE`：清理本轮测试目录和失败 staging。

测试只操作 `SoloSync/.connection-test-<id>` 随机目录，并在同一流程内清理。若 `MOVE` 不可用或测试目录无法清理，连接测试失败；不降级成会暴露半成品快照的非原子流程。

仅接受 `https://`。TLS 证书必须通过系统信任链和域名校验，插件不提供“忽略证书错误”。普通 HTTPS Basic/Digest 用户认证属于第一版范围；浏览器 Cookie、交互式 SSO、Cloudflare Access 页面和自定义代理令牌不属于第一版范围。

## 一致性与失败语义

- 本地 staging 完成后才开始网络上传，避免源文件在长时间上传期间变化而产生不一致快照。
- 远端上传完成后逐文件回读 SHA-256；只验证请求成功或文件大小不足以判定备份成功。
- 历史列表只读取 `snapshots/`，绝不展示 `staging/`。
- 认证失败、权限不足、证书错误、空间不足和不支持 MOVE 都直接给出可定位错误，不做无休止重试。
- 暂时性网络错误允许有限重试；取消信号优先于重试。
- 发布完成但最终确认前发生断线时，下次刷新可以通过已发布 manifest 发现快照，不重复覆盖。
- 日志和错误消息不得包含密码、Authorization header、本机绝对路径或文件正文。

## 安全边界

- 推荐使用专用非管理员 NAS 账户，只授予 SoloSync 共享文件夹读写权限。
- 推荐通过 VPN 私有域名访问；若使用反向代理，只暴露 WebDAV 入口，不暴露 QTS、SSH 或 SMB。
- HTTPS 保护传输，但第一版快照在 NAS 上仍是明文。界面与文档必须明确这一点。
- `.env`、私钥和凭据文件不自动排除；用户必须根据项目需要维护排除规则。第一版不声称提供端到端加密。
- 插件只拥有共享文件夹内 `SoloSync/` 前缀，不读取或修改其他路径。

## 兼容与迁移

- 现有 `solosync.backupDirectory` 设置继续驱动本地或挂载目录 provider。
- 现有 `backupLocationKind` 值继续识别。
- 已有 `formatVersion: 1` manifest 不变。
- 已有路径哈希 project ID 不改名、不迁移；首次发现后写入新的本机项目关联。
- 切换存储位置不删除旧目标，也不复制旧历史。

## 验证计划

### 自动化验证

- 本地 provider 执行现有创建、列举、校验、恢复和取消测试。
- 模拟 WebDAV 服务执行连接能力测试。
- 模拟 WebDAV 服务完成一次完整上传、远端回读校验、MOVE 发布、历史列举和恢复。
- 注入上传取消与校验失败，确认只清理本轮 staging。
- 验证无源项目目录时仍能列举项目并恢复。
- 验证 URL 路径编码、Unicode、空文件、嵌套目录和非法 key 拒绝。
- 验证 package、编译、测试和高危依赖审计。

### 下一轮真实 QNAP 验收

- 确认实际 QTS/QuTS hero WebDAV 认证方式。
- 确认域名反向代理放行所有必需方法和 `Destination` header。
- 完成真实代码仓备份、取消、重试和恢复。
- 恢复目录逐文件 SHA-256 与 manifest 一致。
- 断开原项目后，仅凭 QNAP 连接完成项目发现和恢复。
- 检查 QNAP 上没有残留连接测试目录或失败 staging。

真实 QNAP 尚未执行前，只能声明“本地协议闭环通过”，不能声明“QNAP 生产验收完成”。
