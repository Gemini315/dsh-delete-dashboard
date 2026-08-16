# DeepSeek Harness Desktop

一个面向 Windows 的 **DeepSeek Harness 非官方 Electron 桌面封装**，开箱即用：

- 基于官方 `@deepseek-ai/dsh`（本地 Agent 服务），自带完整运行环境（**无需安装 Node.js / 无需命令行**）
- 官方网页版界面 + 本地窗口，无浏览器限制
- **新增：会话消息删除**（删除任意一条消息及其之后内容）
- **新增：会话仪表盘**（余额 / token / 费用 / 请求数 / 运行时间，跟随界面主题）
- 你的数据全部在本地（会话日志、配置、密钥）

> [!IMPORTANT]
> 本项目不是 DeepSeek 官方产品，也不提供模型额度或绕过 API 鉴权。
> DeepSeek Harness 仍处于 Developer Preview，请勿在高权限模式下打开不可信项目。

---

## 一、下载与安装（推荐）

### 方式 A：下载安装包（推荐，带全部功能）

1. 打开本仓库 **Releases** 页面，下载最新版：
   - `DeepSeek-Harness-Desktop-vX.Y.Z-win-x64.zip`（绿色版，解压即用）
2. 解压到任意目录（**建议 D 盘等非系统盘**），双击 `DeepSeek Harness Desktop.exe` 启动。

### 方式 B：从源码构建

> 适合开发者。注意：源码构建默认使用官方 dsh 基础（**不含「删除消息」等定制功能**，定制功能随 Release 安装包提供）。

```powershell
git clone https://github.com/Gemini315/dsh-delete-dashboard.git
cd dsh-delete-dashboard
npm install
npm run setup        # 下载并准备 dsh 运行时
npm run build:windows
```

---

## 二、首次启动与配置

1. 启动桌面版，等待本地服务就绪，进入对话界面。
2. 打开 **设置（Settings）> 模型（Models）**，配置你的 **DeepSeek API Key**（或点击「开始使用」按引导填写）。
   - 也可以把 key 写到 `%APPDATA%\deepseek-harness-desktop\harness-home\.credentials.yaml`：
     ```yaml
     DEEPSEEK_API_KEY: sk-xxxxxxxx
     ```
3. 选择模型后即可开始对话。

> 密钥只保存在**你自己电脑**的本地配置中，不会上传到任何服务器，也不会出现在本项目代码里。

---

## 三、功能说明

### 1. 删除会话消息 🗑️

- 鼠标悬停在任意**用户消息**或 **AI 回复**上，出现 🗑️ 按钮，点击即可删除。
- 删除是**截断式**：该条消息及其之后的所有内容都会被移除，AI 之后不会再引用已删除的内容。
- 删除会同步更新会话内存、队列与持久化日志，删除后自动恢复会话，可继续正常对话。

### 2. 会话仪表盘 📊

- 窗口右侧边缘有一个竖条标签（📊），点击展开侧边仪表盘；再点（或点面板内 ✕）收起。
- 显示内容：
  - **余额 (CNY)**：DeepSeek 账户实时余额（只读查询，不消耗额度）
  - **累计 tokens**、**会话费用 (CNY)**、**请求数**、**运行时间**：**只统计当前打开的会话**（切换/新建会话自动跟随，从零开始）
- 每 15 秒自动刷新；余额每 60 秒查询一次，避免频繁请求外部 API。
- 外观跟随 dsh 界面主题（浅色 / 深色，在通用设置中切换）。

### 3. 视觉识别（可选）

本桌面版**不含**智谱 GLM 视觉识别（出于密钥安全，已移除相关代码）。如需要图片识别，请通过 dsh 的插件机制安装视觉类插件，并在插件中配置你自己的 API Key。

---

## 四、数据与隐私

| 项目 | 位置 | 说明 |
|---|---|---|
| 会话日志 | `%APPDATA%\deepseek-harness-desktop\harness-home\sessions\` | zstd 压缩，本地存储 |
| API Key | `%APPDATA%\deepseek-harness-desktop\harness-home\.credentials.yaml` | 仅本地，不入代码 |
| 应用日志 | `%APPDATA%\deepseek-harness-desktop\logs\` | 本地排障用 |

- 所有对话与密钥**只在本地**，不会上传。
- 仪表盘对会话日志**只读**，不会修改或删除任何数据。

---

## 五、安全说明

- 本项目不开采、不上报任何数据；代码全部开源，可自行审计。
- 不要把你的 `.credentials.yaml`、`.env` 或 API Key 提交到任何公开仓库（本仓库已通过 .gitignore 与安全检查排除）。
- 请勿在不可信项目目录下以管理员身份运行。

---

## 六、常见问题

**Q: 启动后一直「正在启动」？**
A: 首次启动需要准备本地运行时，请耐心等待；若超过 90 秒仍未就绪，关闭后重试。检查杀毒软件是否拦截了本地端口。

**Q: 删除消息后 AI 还会复述已删内容？**
A: 请使用 **Releases 安装包**（方式 A）——源码构建不含删除功能。若确认是安装包，删除后新提问不应再引用已删消息。

**Q: 仪表盘显示的不是当前会话？**
A: 仪表盘跟随当前打开的会话；切换会话后 15 秒内自动更新。新建会话后请先打开/发送一条消息。

**Q: 怎么卸载？**
A: 绿色版直接删除解压目录即可；如需清空数据，删除 `%APPDATA%\deepseek-harness-desktop`。

---

## 七、开发

- `main.js`：Electron 主进程（窗口、dsh 进程管理、仪表盘、IPC）
- `shell.html`：窗口外壳（标题栏、仪表盘 UI）
- `preload.js`：IPC 桥接
- 构建：`npm run build:windows`（electron-builder）

## 来源与许可

- 本项目的桌面外壳基础来自开源项目 [cc1252/deepseek-harness-desktop](https://github.com/cc1252/deepseek-harness-desktop)（MIT License，Copyright (c) DeepSeek Harness Desktop contributors）。
- 新增功能（会话消息删除、会话仪表盘）由本仓库作者开发。
- 本项目基于 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)（官方开源）构建，遵循其许可条款。
- 本项目整体以 [MIT](LICENSE) 许可发布，保留上述上游版权声明。

## License

[MIT](LICENSE)
