# QuChen 项目交接与发布规则

更新时间：2026-11-11

## 1. 目录（已迁移）

| 模块 | 新路径 | 说明 |
| --- | --- | --- |
| AI 模块（主项目 quchenace/QuChen-AI） | `D:\QuChenDev\QuChen-AI` | 含 `apps/desktop`(Tauri 外壳)、`apps/host`(Node 后端)、`packaging`(打包/feed)、`docs` |
| VPN 模块（quchenace/QuChen-VPN） | `D:\QuChenDev\QuChen-VPN` | 源码仓库，构建产物由 `build.ps1` 生成，仓库内不带 exe |

原路径 `D:\聊天\QuChen-AI`、`D:\聊天\vpn-src\QuChen-VPN-main` 已不存在。历史排查报告仍留在 `D:\聊天`，不随迁移移动。

## 2. 版本号规则（强制）

改动必须随包发布，版本号按改动幅度移动：

| 改动类型 | 判定 | 版本号动作 | 示例 |
| --- | --- | --- | --- |
| 小改小修 | bug 修复、文案/样式、局部逻辑微调，不动接口与数据格式 | 末位 +1 | `0.2.33` → `0.2.34` |
| 中型功能 | 同一大版本内的成块新功能 | 中位 +1，末位归零 | `0.2.33` → `0.3.0` |
| 大改大修 | 新模块、架构/数据格式变更、不兼容变更、跨模块重构 | 首位 +1，其余归零 | `0.2.x` → `1.0.0` |

纯文档、纯注释、纯测试改动不需要动版本号、不需要发版，但仍要提交。

## 3. 版本号唯一真源（四处必须一致）

1. `apps/desktop/src-tauri/Cargo.toml` → `version`
2. `apps/desktop/src-tauri/Cargo.lock` → `name = "quchen-desktop"` 下的 `version`
3. `apps/desktop/package.json` → `version`
4. `apps/host/package.json` → `version`

git tag 固定为 `v<version>`。

## 4. 发版流程

1. 改上面四处版本号并提交到 `main`。
2. 推送 tag：`git tag v<version>` + `git push origin v<version>`。
3. 触发 `.github/workflows/release-windows.yml`（也支持 `workflow_dispatch` 手动跑）。
4. 等 run 成功，验收以下三项：
   - Release 资产含 `QuChen_<version>_x64-setup.exe` 与对应 `.sig`
   - `latest.json` 里 `version` 等于新版本号
   - `quchen-feed.json` 的 `sequence` 递增
5. 发版后回查 QuChen-VPN 的 Release 资产命名与 `apps/host/server/integrations.mjs` 的版本比较逻辑，保证两个仓库对「当前版本」认知一致。

## 5. 当前状态

- **0.2.33 已发布**：run `42951520457` 成功，`QuChen_0.2.33_x64-setup.exe`（约 175 MB）已挂上 Release，`latest.json` 为 0.2.33，`quchen-feed.json` sequence = 3。
- 本版包含：强制更新页「打开下载页」修复（`updates.mjs` 补 `releaseUrl`、`ForceUpdate.tsx` 改用 `openExternal`）、VPN 安装包镜像与 8 路并行下载、网关可用性检查等。
- 版本号规则已写入仓库根 `AGENTS.md` 的 `Release and version-number rules (mandatory)` 一节，并在 `docs/RELEASE_RULES.zh-CN.md` 留中文版。
- 本机已装旧版本由用户自行卸载，与本目录迁移无关。
