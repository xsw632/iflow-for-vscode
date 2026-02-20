# API.md — iFlow CLI SDK 交互参考

## 1. SDK 概述

本项目使用 `@iflow-ai/iflow-cli-sdk`（版本 ^0.1.9）与 iFlow CLI 通信。SDK 通过 ACP（Agent Communication Protocol）协议基于 WebSocket 与 CLI 进程交互。

### 动态导入模式

SDK 采用**懒加载**方式导入，避免扩展启动时阻塞：

```typescript
// src/iflowClient.ts
let sdkModule: SDKModule | null = null;

async function getSDK(): Promise<SDKModule> {
  if (!sdkModule) {
    sdkModule = await import('@iflow-ai/iflow-cli-sdk');
  }
  return sdkModule;
}
```

测试环境可通过 `__setSDKModuleForTests(mod)` 注入 mock SDK。

### SDK 导出一览

| 导出名 | 类型 | 说明 |
|--------|------|------|
| `IFlowClient` | class | 核心客户端，管理连接、发消息、接收流式响应 |
| `RawDataClient` | class | 继承 IFlowClient，额外支持原始消息流 |
| `MessageType` | enum | 消息类型枚举 |
| `ApprovalMode` | enum | 审批模式 |
| `PermissionMode` | enum | 权限模式 |
| `StopReason` | enum | 任务结束原因 |
| `ToolCallStatus` | enum | 工具调用状态 |
| `ToolCallConfirmationOutcome` | enum | 工具确认结果 |
| `ToolCallContentType` | enum | 工具内容类型 |
| `ToolCallIconType` | enum | 工具图标类型 |
| `ToolCallType` | enum | 工具调用分类 |
| `LogLevel` | enum | 日志级别 |
| `PlanPriority` | enum | 计划优先级 |
| `PlanStatus` | enum | 计划条目状态 |
| `HookEventType` | enum | Hook 事件类型 |
| `query()` | function | 一次性发送消息并返回完整文本响应 |
| `queryStream()` | function | 一次性发送消息并以 async generator 返回流式文本 |
| 错误类 | class | IFlowError, TimeoutError, ConnectionError 等 |

---

## 2. 模块职责链

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Extension Host                              │
│                                                                     │
│  cliDiscovery.ts ──→ processManager.ts ──→ iflowClient.ts          │
│  (发现 CLI 路径)      (管理子进程生命周期)    (SDK 封装层)              │
│                                              │                      │
│                                   ┌──────────┴──────────┐           │
│                                   │                     │           │
│                            chunkMapper.ts        settings.json      │
│                         (SDK 消息 → StreamChunk) (~/.iflow/ 旁路)   │
│                                   │                                 │
│                          webviewHandler.ts                          │
│                       (消息调度 + 状态管理)                           │
│                                   │                                 │
└───────────────────────────────────┼─────────────────────────────────┘
                                    │ postMessage
                                    ▼
                            media/main.ts (Webview)
```

### 数据流

```
用户输入 → Webview postMessage({type:'sendMessage'})
  → webviewHandler.handleSendMessage()
    → iflowClient.run(options, onChunk, onEnd, onError)
      → processManager.resolveStartMode() / startManagedProcess()
      → sdk.IFlowClient.connect() / loadSession() / sendMessage()
      → sdk.IFlowClient.receiveMessages() → chunkMapper.mapMessageToChunks()
        → onChunk(StreamChunk) → postMessage({type:'streamChunk'})
          → Webview 渲染
```

---

## 3. SDK 导出 API 参考

### 3.1 IFlowClient

核心客户端类，管理与 iFlow CLI 的完整生命周期。

#### 构造函数

```typescript
new IFlowClient(options?: IFlowOptions)
```

#### 公开方法

| 方法 | 签名 | 说明 |
|------|------|------|
| `connect()` | `() => Promise<void>` | 建立 WebSocket 连接，完成 initialize + authenticate + createSession |
| `disconnect()` | `() => Promise<void>` | 断开连接，停止托管进程（如有） |
| `sendMessage()` | `(text: string, files?: string[]) => Promise<void>` | 发送用户消息。支持附加文件（图片/音频/资源链接） |
| `loadSession()` | `(sessionId: string) => Promise<void>` | 加载已有会话以恢复上下文 |
| `receiveMessages()` | `() => AsyncGenerator<Message>` | 异步生成器，逐条产出 AI 响应消息 |
| `interrupt()` | `() => Promise<void>` | 发送中断信号取消当前任务 |
| `approveToolCall()` | `(id: string, outcome?: ToolCallConfirmationOutcome) => Promise<void>` | 批准工具调用权限请求 |
| `rejectToolCall()` | `(id: string) => Promise<void>` | 拒绝工具调用权限请求 |

#### 内部字段（本项目通过 `as any` 访问）

| 字段 | 类型 | 用途 |
|------|------|------|
| `sessionId` | `string` | 当前会话 ID |
| `transport` | `Transport` | WebSocket 传输层（用于 monkey-patch 和发送原始 JSON-RPC） |
| `protocol` | `Protocol` | JSON-RPC 协议层（用于 monkey-patch 拦截请求） |
| `messageQueue` | `Message[]` | 消息队列（用于注入合成消息） |

### 3.2 RawDataClient

继承 `IFlowClient`，增加原始消息捕获能力。

| 方法 | 说明 |
|------|------|
| `receiveRawMessages()` | 异步生成器，产出原始 JSON-RPC 消息 |
| `receiveDualStream()` | 异步生成器，同时产出 `[rawMessage, parsedMessage]` 元组 |
| `getRawHistory()` | 返回所有已捕获的原始消息数组 |
| `getProtocolStats()` | 返回协议统计信息（消息数量、类型分布等） |
| `sendRaw()` | 发送原始数据到传输层 |

### 3.3 MessageType 枚举

```typescript
enum MessageType {
  PLAN         = 'plan',          // 计划/Todo 条目
  USER         = 'user',          // 用户消息回显
  ASSISTANT    = 'assistant',     // AI 文本/思考响应
  TOOL_CALL    = 'tool_call',     // 工具调用事件
  ERROR        = 'error',         // 错误消息
  TASK_FINISH  = 'task_finish',   // 任务完成信号
}
```

### 3.4 ApprovalMode 枚举

```typescript
enum ApprovalMode {
  DEFAULT   = 'default',    // 需要用户确认危险操作
  AUTO_EDIT = 'autoEdit',   // 自动批准编辑操作
  YOLO      = 'yolo',       // 自动批准所有操作
  PLAN      = 'plan',       // 计划模式，只读不执行
}
```

### 3.5 PermissionMode 枚举

```typescript
enum PermissionMode {
  AUTO      = 'auto',       // 自动批准读取/获取/列表操作
  MANUAL    = 'manual',     // 所有操作需手动批准
  SELECTIVE = 'selective',  // 按类型选择性批准
}
```

### 3.6 StopReason 枚举

```typescript
enum StopReason {
  END_TURN   = 'end_turn',    // 正常结束
  MAX_TOKENS = 'max_tokens',  // 达到 token 上限
  REFUSAL    = 'refusal',     // 模型拒绝
  CANCELLED  = 'cancelled',   // 用户取消
}
```

### 3.7 ToolCallStatus 枚举

```typescript
enum ToolCallStatus {
  PENDING     = 'pending',
  IN_PROGRESS = 'in_progress',
  COMPLETED   = 'completed',
  FAILED      = 'failed',
}
```

### 3.8 ToolCallConfirmationOutcome 枚举

```typescript
enum ToolCallConfirmationOutcome {
  ALLOW              = 'allow',             // 允许一次
  ALWAYS_ALLOW       = 'alwaysAllow',       // 总是允许
  ALWAYS_ALLOW_TOOL  = 'alwaysAllowTool',   // 总是允许该工具
  ALWAYS_ALLOW_MCP_SERVER = 'alwaysAllowMcpServer',
  REJECT             = 'reject',            // 拒绝
}
```

### 3.9 其他枚举

```typescript
enum ToolCallType {
  EDIT    = 'edit',     // 文件编辑
  EXECUTE = 'execute',  // 命令执行
  MCP     = 'mcp',      // MCP 工具
  FETCH   = 'fetch',    // 网络请求
  OTHER   = 'other',    // 其他
}

enum PlanStatus {
  PENDING     = 'pending',
  IN_PROGRESS = 'in_progress',
  COMPLETED   = 'completed',
}

enum PlanPriority {
  HIGH   = 'high',
  MEDIUM = 'medium',
  LOW    = 'low',
}

enum LogLevel {
  DEBUG = 0,
  INFO  = 1,
  WARN  = 2,
  ERROR = 3,
}

enum HookEventType {
  PRE_TOOL_USE      = 'PreToolUse',
  POST_TOOL_USE     = 'PostToolUse',
  STOP              = 'Stop',
  SUBAGENT_STOP     = 'SubagentStop',
  SET_UP_ENVIRONMENT = 'SetUpEnvironment',
}
```

### 3.10 错误类层次

```
IFlowError (基类)
├── TimeoutError          // 连接或操作超时
├── JSONDecodeError       // JSON 解析失败
├── IFlowNotInstalledError // iFlow CLI 未安装
├── IFlowProcessError     // 进程启动/运行失败
├── PortNotAvailableError // 端口被占用
├── ConnectionError       // WebSocket 连接失败
├── TransportError        // 传输层错误
├── PermissionError       // 文件权限被拒绝
├── ValidationError       // 输入验证失败
├── ProtocolError         // JSON-RPC 协议错误
└── AuthenticationError   // 认证失败
```

### 3.11 工具函数

```typescript
// 一次性查询，返回完整文本
async function query(
  prompt: string,
  files?: string[],
  options?: IFlowOptions
): Promise<string>

// 流式查询，逐字产出文本
async function* queryStream(
  prompt: string,
  files?: string[],
  options?: IFlowOptions
): AsyncGenerator<string>
```

---

## 4. IFlowClient 构造选项

| 选项 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `url` | `string` | `'ws://localhost:8090/acp'` | WebSocket 服务器地址 |
| `cwd` | `string` | `process.cwd()` | 工作目录 |
| `timeout` | `number` | `30000` | 连接超时（毫秒） |
| `logLevel` | `'DEBUG'\|'INFO'\|'WARN'\|'ERROR'` | `'INFO'` | 日志级别 |
| `fileAccess` | `boolean` | `false` | 是否启用文件系统访问 |
| `fileReadOnly` | `boolean` | `false` | 文件系统是否只读 |
| `fileMaxSize` | `number` | `10485760` (10MB) | 文件大小上限 |
| `fileAllowedDirs` | `string[]` | `[cwd]` | 允许访问的目录列表 |
| `permissionMode` | `PermissionMode` | `AUTO` | 工具权限模式 |
| `autoApproveTypes` | `string[]` | `['read','fetch','list']` | 自动批准的操作类型 |
| `authMethodId` | `string` | `'iflow'` | 认证方法 ID |
| `authMethodInfo` | `object` | `undefined` | 认证附加信息 |
| `autoStartProcess` | `boolean` | `true` | 是否自动启动 CLI 进程 |
| `processStartPort` | `number` | `8090` | 自动启动时的起始端口 |
| `sessionSettings` | `object` | `undefined` | 会话级设置 |
| `mcpServers` | `object[]` | `[]` | MCP 服务器配置 |
| `hooks` | `object` | `undefined` | Hook 配置 |
| `commands` | `object[]` | `undefined` | 自定义命令 |
| `agents` | `object[]` | `undefined` | Agent 配置 |

### 本项目使用的选项

```typescript
// src/iflowClient.ts → getSDKOptions()
{
  timeout: config.timeout,       // 来自 iflow.timeout 配置
  logLevel: 'DEBUG' | 'WARN',   // 取决于 iflow.debugLogging
  cwd: workspaceFolderPath,
  fileAccess: true,
  fileAllowedDirs: [...allWorkspaceFolders], // 多工作区时传入

  // 手动启动模式
  autoStartProcess: false,
  url: `ws://localhost:${port}/acp`,

  // 或 SDK 自动启动模式
  autoStartProcess: true,
  processStartPort: config.port,

  // 会话级设置
  sessionSettings: {
    permission_mode: 'default' | 'yolo' | 'plan' | 'smart',
    append_system_prompt: PLAN_MODE_INSTRUCTIONS  // 仅 plan 模式
  }
}
```

---

## 5. 连接生命周期

SDK 内部连接流程（通过 `ensureConnected()` 管理，跨 run() 复用）：

```
connect()
  │
  ├─ 1. 检测已有进程（尝试 WebSocket 连接）
  │    ├─ 已运行 → 直接使用 url
  │    └─ 未运行且 autoStartProcess=true → ProcessManager.start()
  │
  ├─ 2. 创建 Transport（WebSocket 连接）
  │    └─ new Transport({ url, timeout }) → transport.connect()
  │
  ├─ 3. 创建 Protocol
  │    └─ new Protocol({ transport, fileHandler, permissionMode })
  │
  ├─ 4. 协议初始化
  │    ├─ 等待 //ready 信号
  │    ├─ 发送 initialize 请求
  │    └─ 接收 initialize 响应 { protocolVersion, isAuthenticated }
  │
  ├─ 5. 认证（如果未认证）
  │    ├─ 发送 authenticate 请求 { methodId: 'iflow' }
  │    └─ 接收 authenticate 响应
  │
  ├─ 6. 创建会话
  │    ├─ 发送 session/new 请求 { cwd, settings, mcpServers }
  │    └─ 接收响应 { sessionId }
  │
  └─ 7. 启动消息处理循环
       └─ handleMessages() → protocol.handleMessages() → messageQueue
```

### JSON-RPC 方法

| 客户端 → 服务端 | 说明 |
|-----------------|------|
| `initialize` | 协议初始化 |
| `authenticate` | 客户端认证 |
| `session/new` | 创建新会话 |
| `session/load` | 加载已有会话 |
| `session/prompt` | 发送用户消息 |
| `session/cancel` | 取消当前任务 |
| `session/set_think` | 启用/禁用思考模式（本项目自行发送） |

| 服务端 → 客户端 | 说明 |
|-----------------|------|
| `session/update` | 会话状态更新（文本、工具调用、计划等） |
| `session/request_permission` | 工具权限请求 |
| `fs/read_text_file` | 读取文件 |
| `fs/write_text_file` | 写入文件 |

---

## 6. 消息类型详解

### 6.1 ASSISTANT 消息

```typescript
{
  type: 'assistant',
  chunk: {
    text?: string,    // AI 文本输出
    thought?: string, // AI 思考内容（需开启 thinking）
  },
  agentId?: string,   // 子 agent ID（如有）
  agentInfo?: { taskId, agentIndex, timestamp }
}
```

### 6.2 TOOL_CALL 消息

```typescript
{
  type: 'tool_call',
  id: string,              // 工具调用 ID
  label: string,           // 显示标题
  icon: { type, value },   // 图标
  status: ToolCallStatus,  // pending | in_progress | completed | failed
  toolName: string,        // 工具名称
  args?: object,           // 工具参数
  output?: string,         // 工具输出（仅 completed/failed）
  agentId?: string,
  agentInfo?: object,

  // 本项目注入的额外字段（由 monkey-patch 添加）
  confirmation?: { type, description },  // 权限确认
  _requestId?: number,                   // JSON-RPC 请求 ID
  _questionRequest?: boolean,            // 用户问题标记
  _questions?: Question[],               // 问题列表
  _planApproval?: boolean,               // 计划审批标记
  _plan?: string,                        // 计划内容
}
```

### 6.3 PLAN 消息

```typescript
{
  type: 'plan',
  entries: Array<{
    content: string,   // Todo 内容
    status: PlanStatus, // pending | in_progress | completed
    priority: PlanPriority,
  }>
}
```

### 6.4 ERROR 消息

```typescript
{
  type: 'error',
  code: number,     // 错误码
  message: string,  // 错误信息
}
```

### 6.5 TASK_FINISH 消息

```typescript
{
  type: 'task_finish',
  stopReason: StopReason,  // end_turn | max_tokens | refusal | cancelled
}
```

### 6.6 USER 消息

```typescript
{
  type: 'user',
  chunks: Array<{ text: string }>,
}
```

---

## 7. 本项目的 SDK 使用方式

### 7.1 src/iflowClient.ts — 核心封装

`IFlowClient` 类是本项目的 SDK 封装层，提供以下能力：

#### 公开 API

| 方法 | 说明 |
|------|------|
| `checkAvailability()` | 创建临时 SDK 客户端，connect+disconnect 测试可用性，返回版本和诊断信息 |
| `run(options, onChunk, onEnd, onError)` | 完整对话轮次：确保连接 → 发送 → 接收流。返回 `sessionId` |
| `cancel()` | 发送 interrupt() 中断当前任务（不断开连接） |
| `dispose()` | 完全清理：断开 + 停止子进程 + 清除缓存 |
| `isRunning()` | 检查连接状态 |
| `approveToolCall(requestId, outcome)` | 批准工具权限请求 |
| `rejectToolCall(requestId)` | 拒绝工具权限请求 |
| `answerQuestions(requestId, answers)` | 回答用户问题 |
| `approvePlan(requestId, approved)` | 审批计划 |
| `clearAutoDetectCache()` | 清除 CLI 路径自动检测缓存 |

#### 持久连接模式

iflowClient 使用 `ensureConnected(mode, cwd, fileAllowedDirs)` 在多次 `run()` 调用间复用 SDK 连接。仅在以下情况重新连接：
- mode 变化（如 plan → default）
- cwd 变化（多工作区切换）
- 前一连接已断开或出错

连接建立时安装的三个 monkey-patch（patchTransport、patchQuestions、patchPermission）均为正交的，无论 mode 如何都会安装。

#### RunOptions

```typescript
interface RunOptions {
  prompt: string;
  attachedFiles: AttachedFile[];
  mode: ConversationMode;   // 'default' | 'yolo' | 'plan' | 'smart'
  think: boolean;
  model: ModelType;
  workspaceFiles?: string[];
  sessionId?: string;
  ideContext?: IDEContext;
  cwd?: string;
  fileAllowedDirs?: string[];
}
```

#### run() 完整流程

```
1. chunkMapper.reset()
2. updateIFlowCliModel(model)         ← 写入 ~/.iflow/settings.json
3. updateIFlowCliApiConfig()          ← 写入 baseUrl/apiKey 到 settings.json
4. ensureConnected(mode, cwd, fileAllowedDirs):
   a. 若已连接且 mode/cwd 未变 → 复用现有连接
   b. 否则 → disconnect() + resolveStartMode() + startManagedProcess()
   c. new sdk.IFlowClient(sdkOptions)
   d. client.connect()
   e. patchTransport(client)             ← 修复消息丢失
   f. patchQuestions(client)             ← 拦截问题/计划（所有模式）
   g. patchPermission(client)            ← 拦截权限请求（所有模式）
5. 清空 messageQueue 中的陈旧消息
6. client.loadSession(sessionId)     ← 恢复上下文（仅当 sessionId 与已加载不同）
7. sendSetThink(client, sessionId, think) ← 启用/禁用思考
8. chunkMapper.buildPrompt(options)  ← 构建完整提示词
9. plan 模式 → 注入 <system-reminder> 包装
10. client.sendMessage(finalPrompt)
11. for await (message of client.receiveMessages()):
      chunkMapper.mapMessageToChunks(message) → StreamChunk[]
      onChunk(chunk) × N
      break on TASK_FINISH
12. onEnd()
13. 出错时标记 isConnected=false（下次 run 重连）
14. return sessionId
```

### 7.2 设置文件旁路

模型选择和 API 配置不通过 SDK 选项传递，而是直接写入 `~/.iflow/settings.json`：

```typescript
// 更新模型
private updateIFlowCliModel(model: ModelType): void {
  const { settings, path } = this.readSettings();
  settings.modelName = model;
  this.writeSettings(settings, path);
}

// 更新 API 配置
private updateIFlowCliApiConfig(): void {
  const { settings, path } = this.readSettings();
  settings.baseUrl = config.baseUrl;
  settings.apiKey = apiKey;
  this.writeSettings(settings, path);  // mode: 0o600 on Unix
}
```

原因：CLI 服务端独立读取此文件获取模型和 API 配置。

### 7.3 三个运行时补丁

#### 补丁 1: patchTransport — 修复 WebSocket 消息丢失

**问题**：SDK 的 `Transport.receiveRawData()` 每次调用注册一个一次性 `message` 监听器。当多条 WebSocket 消息在同一个 TCP 段中到达时，只有第一条被接收。

**修复**：安装持久的 `ws.on('message')` 监听器，用队列/等待者模式缓冲消息，覆盖 `receiveRawData()` 从缓冲区消费。跳过第一条消息以避免与 SDK 已有处理器重复。

```typescript
// 安装后的消息流
ws.on('message') → queue.push(msg) / waiter.resolve(msg)
transport.receiveRawData() → queue.shift() / new Promise(waiter)
```

#### 补丁 2: patchQuestions — 拦截用户问题和计划退出

**问题**：ACP 协议发送 `_iflow/user/questions` 和 `_iflow/plan/exit` JSON-RPC 方法，但 SDK 的 `handleUnknownMessage()` 会返回 -32601 错误导致服务端断开。

**修复**：替换 `protocol.handleClientMessage`，拦截两个方法（所有模式均安装）：

| JSON-RPC 方法 | 处理方式 |
|---------------|---------|
| `_iflow/user/questions` | 注入合成 tool_call 消息（`_questionRequest: true`）到 messageQueue → 阻塞等待用户回答 → `protocol.sendResult(id, {answers})` |
| `_iflow/plan/exit` | 注入合成 tool_call 消息（`_planApproval: true`）到 messageQueue → 阻塞等待用户审批 → `protocol.sendResult(id, {approved})` |

#### 补丁 3: patchPermission — 交互式工具权限审批

**问题**：SDK 的 `Protocol.handleRequestPermission()` 在 AUTO 模式下自动批准、MANUAL 模式下自动拒绝，不提供交互式 UI。

**修复**：替换 `protocol.handleRequestPermission`（所有模式均安装）：
1. 注入确认消息到 messageQueue（`confirmation: { type, description }`）
2. 通过 `pendingPermissions` Map 阻塞等待用户决定
3. 用户调用 `approveToolCall()` / `rejectToolCall()` → 解析 Promise
4. `protocol.sendResult(id, { outcome: { outcome, optionId } })` 发回结果

---

## 8. ProcessManager API

`src/processManager.ts` — 管理 iFlow CLI 子进程生命周期。

### 接口

```typescript
interface ManualStartInfo {
  nodePath: string;      // Node.js 可执行文件路径
  iflowScript: string;   // iFlow CLI JS 入口脚本路径
  port: number;           // WebSocket 端口
}

interface ProcessManagerConfig {
  nodePath: string | null; // 用户配置的 Node 路径（来自 iflow.nodePath）
  port: number;            // 端口号（来自 iflow.port）
}
```

### 方法

| 方法 | 签名 | 说明 |
|------|------|------|
| `resolveStartMode()` | `(config: ProcessManagerConfig) => Promise<ManualStartInfo \| null>` | 三层解析启动方式 |
| `autoDetectNodePath()` | `() => Promise<{nodePath, iflowScript} \| null>` | 自动检测，结果缓存 |
| `startManagedProcess()` | `(nodePath, port, iflowScript?) => Promise<void>` | 启动子进程 |
| `stopManagedProcess()` | `() => void` | 停止子进程（SIGTERM） |
| `clearAutoDetectCache()` | `() => void` | 清除检测缓存 |
| `hasProcess` | `boolean` (getter) | 是否有运行中的子进程 |

### 三层启动解析

```
resolveStartMode(config)
  │
  ├─ Tier 1: config.nodePath 有值（用户手动配置）
  │    → findIFlowPathCrossPlatform() + resolveIFlowScriptCrossPlatform()
  │    → return ManualStartInfo
  │
  ├─ Tier 2: autoDetectNodePath()（自动检测）
  │    → findIFlowPathCrossPlatform()   // 找 iflow 二进制
  │    → deriveNodePathFromIFlow()       // 从 iflow 位置推导 node 路径
  │    → resolveIFlowScriptCrossPlatform() // 解析 JS 入口脚本
  │    → return ManualStartInfo（结果缓存）
  │
  └─ Tier 3: return null（让 SDK 自行管理进程）
```

### 子进程启动流程

```
cp.spawn(nodePath, [iflowScript, '--experimental-acp', '--port', N], { cwd })
  │
  ├─ stdout/stderr 监听 → 检测 "listening"/"ready"/"port" 关键词
  ├─ 延迟 500ms 后开始 WebSocket 健康检查
  │    └─ 最多 20 次尝试，间隔 300ms → ws://localhost:N/acp
  ├─ 30 秒整体超时
  └─ 全部失败时仍然 resolve（fallback）
```

---

## 9. ChunkMapper API

`src/chunkMapper.ts` — 将 SDK 消息映射为 Webview 可渲染的 StreamChunk。

### 方法

| 方法 | 说明 |
|------|------|
| `reset()` | 重置状态（`inNativeThinking`、`ThinkingParser`），每次 run() 开始时调用 |
| `buildPrompt(options)` | 构建完整提示词：工作区文件列表 + 附件内容 + 用户输入 |
| `enrichToolInput(message)` | 合并 `args`、`content`（path/newText/oldText/markdown）、`locations[0].path` 为统一的 input 对象。还解析子 agent 标签格式 `"toolName: {json}"` |
| `mapMessageToChunks(message)` | 核心映射方法，见下表 |

### 消息类型 → StreamChunk 映射表

| SDK MessageType | 条件 | 输出 StreamChunk |
|-----------------|------|------------------|
| `ASSISTANT` | `chunk.thought` 存在 | `thinking_start` + `thinking_content` |
| `ASSISTANT` | `chunk.thought` 结束后出现 `chunk.text` | `thinking_end` + `text` |
| `ASSISTANT` | `chunk.text` 中有 `<think>` 标签 | 通过 ThinkingParser 解析为 `thinking_start/content/end` |
| `ASSISTANT` | 普通 `chunk.text` | `text` |
| `TOOL_CALL` | `confirmation` + `_requestId` | `tool_start` + `tool_confirmation` |
| `TOOL_CALL` | `_questionRequest` | `user_question` |
| `TOOL_CALL` | `_planApproval` | `plan_approval` |
| `TOOL_CALL` | status=`pending`/`in_progress` | `tool_start` |
| `TOOL_CALL` | status=`completed` | `tool_start` + `tool_output` + `tool_end(completed)` |
| `TOOL_CALL` | status=`failed` | `tool_start` + `tool_output` + `tool_end(error)` |
| `PLAN` | 有 entries | `plan` |
| `ERROR` | — | `error` |
| `TASK_FINISH` | 在 thinking 中 | `thinking_end` |

### Thinking 检测双策略

1. **原生 SDK thinking**：`message.chunk.thought` 字段触发 `thinking_start/content/end`
2. **内联 `<think>` 标签**：ThinkingParser 状态机检测 `<think>`/`</think>` 标签并产出相同的 chunk 类型

---

## 10. WebviewHandler 消息调度

`src/webviewHandler.ts` — 处理 Webview 发来的消息，调度 SDK 交互。

### WebviewMessage → 处理器映射

| WebviewMessage.type | 处理方法 | SDK 交互 |
|---------------------|---------|----------|
| `ready` | 发送当前状态 + 推送 IDE 上下文 | 无 |
| `recheckCli` | `client.dispose()` + `clearAutoDetectCache()` + 重新检测 | 完全重启 |
| `pickFiles` | 打开文件选择器，返回选中文件路径 | 无 |
| `listWorkspaceFiles` | 搜索工作区文件（`vscode.workspace.findFiles`） | 无 |
| `readFiles` | 读取文件内容（截断到 maxFileBytes） | 无 |
| `openFile` | `vscode.commands.executeCommand('vscode.open')` | 无 |
| `sendMessage` | `handleSendMessage()` | `client.run()` |
| `toolApproval` (reject) | `client.rejectToolCall()` + `client.cancel()` | 拒绝 + 中断 |
| `toolApproval` (allow/alwaysAllow) | `client.approveToolCall(requestId, outcome)` | 解析权限 Promise |
| `questionAnswer` | `client.answerQuestions(requestId, answers)` | 解析问题 Promise |
| `planApproval` | 根据 option 执行不同逻辑（见下方） | 解析计划 Promise |
| `cancelCurrent` | `client.cancel()` | 中断（不断开连接） |
| `newConversation` | 创建新会话（绑定活动编辑器的工作区） | 无 |
| `switchConversation` | 切换到指定会话 | 无 |
| `deleteConversation` | 删除会话 | 无 |
| `clearConversation` | 清空当前会话消息 | 无 |
| `setMode` | 仅更新 Store | 下次 run() 生效 |
| `setThink` | 仅更新 Store | 下次 run() 生效 |
| `setModel` | 仅更新 Store | 下次 run() 生效 |
| `setWorkspaceFolder` | 绑定会话到指定工作区 | 下次 run() 生效 |

### planApproval 选项处理

| option | 行为 |
|--------|------|
| `smart` | 切换 mode 为 smart，自动发送执行指令 |
| `default` | 切换 mode 为 default，自动发送执行指令 |
| `keep` | 保持 plan 模式不变 |
| `feedback` | 将 feedback 文本作为新消息发送（仍在 plan 模式） |

当 requestId=-1 时为合成审批（AI 未调用 exit_plan_mode 而自然结束）。

### IDE 上下文推送

WebviewHandler 监听活动编辑器和选区变化（300ms 防抖），推送 `ideContextChanged` 消息到 Webview。选区文本截断到 5000 字符。

```typescript
interface IDEContext {
  activeFile: { path: string; name: string } | null;
  selection: {
    filePath: string; fileName: string;
    text: string; lineStart: number; lineEnd: number;
  } | null;
}
```

### 多工作区支持

- `syncWorkspaceFolders()`：同步所有工作区文件夹到 Store
- `resolveWorkspaceFolder(conversation)`：优先级为会话绑定 > 活动编辑器 > 第一个文件夹
- `getAllWorkspaceFolderPaths()`：返回所有工作区路径作为 `fileAllowedDirs`

### CLI 可用性缓存

- 全局共享缓存（跨 WebviewHandler 实例）
- 成功 TTL：2 分钟
- 失败 TTL：15 秒
- 并发去重：`sharedCliCheckInFlight` Promise
- 懒检测：首次 `sendMessage` 时才检测，而非启动时

---

## 11. 交互式审批流

### 工具权限审批流程

```
CLI Server
  │ session/request_permission { toolCall, options }
  ▼
patchPermission() 拦截
  │ 注入 tool_call { confirmation, _requestId } 到 messageQueue
  ▼
chunkMapper.mapMessageToChunks()
  │ 产出 tool_confirmation StreamChunk
  ▼
webviewHandler → postMessage({type:'streamChunk', chunk})
  ▼
Webview 显示审批 UI → 用户点击 Allow/Reject
  │ postMessage({type:'toolApproval', requestId, outcome})
  ▼
webviewHandler.handleMessage()
  │ client.approveToolCall(requestId, outcome)
  │   → pendingPermissions.get(requestId).resolve({outcome:{outcome,optionId}})
  ▼
patchPermission() 的 await 解除
  │ protocol.sendResult(id, {outcome: {outcome: 'selected', optionId}})
  ▼
CLI Server 继续执行工具
```

### 用户问题流程

```
CLI Server
  │ _iflow/user/questions { questions }
  ▼
patchQuestions() 拦截
  │ 注入 tool_call { _questionRequest, _questions } 到 messageQueue
  ▼
chunkMapper → user_question StreamChunk
  ▼
Webview 显示问题 UI → 用户填写答案
  │ postMessage({type:'questionAnswer', requestId, answers})
  ▼
webviewHandler → client.answerQuestions(requestId, answers)
  │ → pendingPermissions.get(requestId).resolve({answers})
  ▼
patchQuestions() 的 await 解除
  │ protocol.sendResult(id, {answers})
  ▼
CLI Server 收到答案，继续生成
```

### 计划审批流程

```
CLI Server
  │ _iflow/plan/exit { plan }
  ▼
patchQuestions() 拦截
  │ 注入 tool_call { _planApproval, _plan } 到 messageQueue
  ▼
chunkMapper → plan_approval StreamChunk
  ▼
Webview 显示计划审批 UI → 用户点击批准/拒绝
  │ postMessage({type:'planApproval', requestId, approved})
  ▼
webviewHandler → client.approvePlan(requestId, approved)
  │ → pendingPermissions.get(requestId).resolve({approved})
  ▼
patchQuestions() 的 await 解除
  │ protocol.sendResult(id, {approved})
  ▼
CLI Server 根据结果继续或停止
```

---

## 12. ACP 协议补偿

ACP 路径与 CLI 内部路径存在以下差异，本项目通过补偿机制弥补：

| 差异 | CLI 内部行为 | ACP 路径缺失 | 本项目补偿 |
|------|-------------|-------------|-----------|
| Plan Mode 指令 | `PLAN_MODE_ACTIVATED` 事件注入到每条用户消息 | ACP 不发送此事件 | 双重注入：`sessionSettings.append_system_prompt` + 每条消息包装 `<system-reminder>` |
| Thinking 开关 | CLI 内部设置 | ACP 无对应选项 | 手动发送 `session/set_think` JSON-RPC 消息 |
| 模型选择 | CLI 读取 settings.json | SDK 选项无模型字段 | 直接写入 `~/.iflow/settings.json` 的 `modelName` |
| API 配置 | CLI 读取 settings.json | SDK 选项无 baseUrl/apiKey | 直接写入 `~/.iflow/settings.json` 的 `baseUrl`/`apiKey` |
| 权限审批 | 终端交互式 UI | SDK 自动批准/拒绝 | `patchPermission()` 替换处理器，转发到 Webview UI（所有模式均安装） |
| 用户问题 | 终端交互式 UI | SDK 返回 -32601 错误 | `patchQuestions()` 拦截方法，转发到 Webview UI（所有模式均安装） |
| 消息丢失 | 不适用 | SDK Transport 一次性监听器导致 TCP 批量消息丢失 | `patchTransport()` 安装持久监听器 + 缓冲队列 |
| 连接管理 | 每次操作独立 | SDK 无会话复用 | `ensureConnected()` 跨 run() 复用连接，仅在 mode/cwd 变化时重连 |

---

## 13. cliDiscovery API

`src/cliDiscovery.ts` — 跨平台 iFlow CLI 路径发现。

### 导出函数

| 函数 | 签名 | 说明 |
|------|------|------|
| `findIFlowPathCrossPlatform` | `(log: Logger) => Promise<string \| null>` | 发现 iflow CLI 二进制路径 |
| `resolveIFlowScriptCrossPlatform` | `(iflowPath: string, log: Logger) => string` | 从二进制路径解析 JS 入口脚本 |
| `deriveNodePathFromIFlow` | `(iflowPath: string, log: Logger) => Promise<string \| null>` | 从 iflow 位置推导 node 路径 |

### 发现策略

**Unix:**
1. `which iflow`
2. 回退：`$SHELL -lc "which iflow"`（捕获 nvm/fnm/volta 环境）
3. `fs.realpathSync()` 解析符号链接

**Windows:**
1. `where iflow` / `where iflow.ps1` / `where iflow.cmd`
2. 回退：`%APPDATA%\npm\iflow{.ps1,.cmd,}`
3. 解析 `.ps1` / `.cmd` 包装文件提取 JS 入口路径

**Node 路径推导:**
1. 在 iflow 所在的 `bin/` 目录查找 `node` / `node.exe`
2. Windows 回退：`where node`

所有函数失败时返回 `null`（不抛异常），错误通过 Logger 回调输出。
