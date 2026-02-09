# IFlow for VS Code

将 `iflow` CLI 带到 VS Code：在侧边栏打开 IFlow 面板，快速呼出常用命令，并提供“锁定编辑器分组”能力，便于专注在一个固定区域进行对话与操作。

## 预览

### 1) Activity Bar 侧边栏入口
![IFlow Activity Bar Sidebar](https://raw.githubusercontent.com/xsw632/iflow-for-vscode/main/media/image-1.png)

### 2) Secondary Side Bar 侧边栏入口
![IFlow Secondary Sidebar](https://raw.githubusercontent.com/xsw632/iflow-for-vscode/main/media/image-2.png)

### 3) Edit File 以及 Bash 等 tool 渲染
![Tool Call](https://raw.githubusercontent.com/xsw632/iflow-for-vscode/main/media/image-3.png)


## 功能

- **IFlow 面板**：在 Activity Bar / Secondary Side Bar 中打开 IFlow（Webview）面板。
- **命令面板集成**：
  - `IFlow: Open Panel`
  - `IFlow: Lock Editor Group`
- **可配置连接参数**：端口、超时、日志等。

## 依赖

- 已安装并可用的 `iflow` CLI（本扩展通过 `@iflow-ai/iflow-cli-sdk` 与本地/CLI 服务交互）。
- Node.js：支持常见安装方式（如 nvm / 系统 Node）。如需指定路径可使用 `iflow.nodePath`。

## 配置项

在 VS Code 设置中搜索 `IFlow` 或 `iflow.`：

- `iflow.nodePath`：Node.js 可执行文件路径（可选）。
- `iflow.baseUrl`：OpenAI-compatible API base URL（可选，仅在需要覆盖 CLI 端点时设置）。
- `iflow.port`：IFlow CLI WebSocket 端口（默认 `8090`）。
- `iflow.timeout`：连接超时（毫秒，默认 `60000`）。
- `iflow.maxFileBytes`：附件最大文件大小（字节，默认 `80000`）。
- `iflow.debugLogging`：开启调试日志（默认 `false`）。

## 使用

1. 安装并完成 `iflow` CLI 的基础配置。
2. 在 VS Code 侧边栏点击 **IFlow** 图标打开面板，或使用命令面板执行 `IFlow: Open Panel`。
3. 如遇连接问题，检查 `iflow.port` 是否与 CLI 侧一致，并可临时开启 `iflow.debugLogging` 查看输出。
