# 外部接入：免费网关、Harness 同步、QuChen VPN

这份文档说明 QuChen 的三个"外部"能力怎么工作、数据放在哪、出问题先看什么。

## 1. 免费网关

- **位置**：左侧导航「网关」（在 监控 与 模型 之间）。
- **安装**：第一次点「安装」。QuChen 用自带的 Python 在 `%LOCALAPPDATA%\QuChen\gateway` 建虚拟环境，从清华源装 LiteLLM（实测约 2 分钟），不下载大文件。
- **启动**：点「启动」，约 1–2 秒后 `127.0.0.1:4000` 就绪。网关是 QuChen 的子进程，**没有命令行窗口**，退出 QuChen 时一起结束。
- **模型**：每个上游一个名字，另加四个别名组。

  | 模型名 | 上游 | 需要 key |
  |---|---|---|
  | `nemotron-3-ultra` | OpenRouter · Nemotron-3 Ultra 550B | 是 |
  | `cohere-north` | OpenRouter · Cohere North Mini Code | 是 |
  | `nemotron-3-5-super-vl` | OpenRouter · Nemotron-3.5 Super VL | 是 |
  | `flint` | OpenRouter · Flint v1.0 | 是 |
  | `nemotron-nano-reasoning` | OpenRouter · Nemotron-3 Nano 推理 | 是 |
  | `gemma-4-31b` | OpenRouter · Gemma-4 31B | 是 |
  | `pollinations-fast` | Pollinations | 否 |
  | `deepseek-v4.1-flash` / `-think` / `fast` / `zero` | 组（组内自动挑可用的） | 视组内条目 |

- **key**：安装时从发布资产 `quchen-gateway-key.txt` 取一次，写进 `...\gateway\.env`；如果本机已有 `.env`，优先用它。`pollinations-fast` 不需要 key。
- **在 QuChen 里聊天**：没有本地模型时，QuChen 会自动选用网关模型；模型菜单里也能手动挑。等价的命令行验证：

  ```powershell
  curl http://127.0.0.1:4000/v1/models -H "Authorization: Bearer Quchennb1"
  ```

## 2. DeepSeek Harness 同步

- 页面上的「立即同步」把**本地模型**和**网关模型**写进 `%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml` 的 `llm-pi-ai` 段，其它条目保持不动。
- 地址固定：
  - QuChen 本地 → `http://127.0.0.1:18080/v1`（固定代理，引擎换端口无影响）
  - 免费网关 → `http://127.0.0.1:4000/v1`
- 「自动保持同步」打开后，模型或端口一变就重写配置；**Harness 需要重启一次**才会重新读取。
- 凭据引用：`QUCHEN_API_KEY`、`QUCHEN_GATEWAY_KEY`，写在 `%USERPROFILE%\.dsh\.credentials.yaml` 的 `refs` 下。

## 3. QuChen VPN（可选）

- 「网关」页 → 网络工具 → 下载安装：下载 `QuChenVPN-Setup.exe`，**静默安装**，面板里显示下载进度。
- 下载走系统代理（`Invoke-WebRequest`），所以 VPN 已经连着的时候能下得动；纯直连到不了 github.com 时，用「从本地文件…」。
- **更新/卸载 QuChen 会一起处理 VPN**：先 `taskkill /IM QuChenVPN.exe`，再静默运行它的卸载程序，最后删目录。
- VPN 自己带强制更新：启动检查，有新版弹不可关闭的提示。

## 4. 数据放哪

| 内容 | 位置 | 更新时 |
|---|---|---|
| 程序本体 | `D:\QuChen`（安装目录，可改） | 整个删除后重装 |
| 引擎组件 | `%LOCALAPPDATA%\QuChen\components` | **保留** |
| 网关 | `%LOCALAPPDATA%\QuChen\gateway` | 删除（下次点安装重建） |
| 运行期/缓存/日志 | `%LOCALAPPDATA%\QuChen\{runtime,procs,logs,cache}` | 删除 |
| 配置与指针 | `%LOCALAPPDATA%\QuChen\app-settings.json` | **保留**（记着模型目录） |
| 聊天/档案 | `%APPDATA%\QuChen` | 删除（重置） |
| 模型文件 | 你选的模型目录 | **保留** |

## 5. 排查顺序

1. 网关页：状态点是否绿色、模型数是否 11。
2. `http://127.0.0.1:4000/v1/models` 能否返回列表（带上 Bearer）。
3. 设置 → 关于 →「下载并安装更新」是否报错：报 github.com 连不上就先用 VPN。
4. Harness 菜单里有没有 `QuChen (本地大模型)` / `免费网关 (LiteLLM)`；没有就重启 Harness。
5. 网关日志：`%LOCALAPPDATA%\QuChen\gateway\gateway.log`（或面板里的「日志」）。
