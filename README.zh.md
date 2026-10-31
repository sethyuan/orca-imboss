[English](README.md) · [官方网站](https://orca-studio.com/imboss/)

# imboss

**在一个聊天窗口里，用 AI 员工运营你的「一人公司」。**

imboss 是一款桌面应用：你与一位担任「幕僚长」的 AI **助理**对话，告诉它你的需求，它会组建一支 AI **员工**团队，在群聊里派发任务、实时同步进展，并最终把成果汇报给你。

<img width="1938" height="1412" alt="imboss" src="https://github.com/user-attachments/assets/e785e2e1-145a-436b-a1e6-975710ffbd24" />

## 介绍视频

[imboss 介绍视频](https://www.bilibili.com/video/BV1e3po6rET6/?share_source=copy_web&vd_source=89506ada1738e6a7900dc6eb24d24da5)

## 工作原理

1. **你和助理对话。** 像给同事发消息一样自然聊天，无需琢磨提示词。
2. **助理规划并组建团队。** 它把你的需求拆解成任务，盘点现有成员，在缺少对应专长时招募新员工，并创建一个任务群聊。
3. **员工开始干活。** 每位员工都有自己的角色、人设、模型、工具、技能与 MCP 服务，能调研、写作、执行命令并产出真实成果。
4. **团队自行协作。** 员工之间通过 @ 提及、提问与汇报结果，助理则推动任务前进、及时解困。
5. **你始终掌控全局。** 在对话中跟进进展，只在真正需要拍板时回答问题，最后收到完整结果。

## 功能特性

### 以聊天为中心的工作台

- 微信风格的会话界面：会话列表、消息气泡、头像、未读角标与已读状态一应俱全。
- 支持图片与文件附件；消息以 Markdown 富文本渲染，带代码高亮与 KaTeX 数学公式。
- 专属的**提问卡片**用于收集你的结构化回答，**进度卡片**则实时展示任务的每一步状态。
- 单窗口、单实例运行，始终如一。

### 会管理团队的助理

- 内置助理是团队的总协调人：制定计划、招募员工、创建任务群聊、派发工作并向你汇报。
- 你可以在助理详情页调整它的人设与系统提示词，微调它的工作方式。

### 一支员工团队

- **招募**专才：设定名字、角色、人设，挑选头像，并写好定义「他是谁、如何工作」的系统提示词。
- 为每位员工单独指定**模型**与**思考强度**，也可跟随应用默认值。
- 为员工配备**技能**、**MCP 服务**以及可选的**定时任务**。
- 员工会用你使用的语言回复，并把结果汇报给分配任务的人。

### 任务群聊

- 助理会为每个任务创建一个**群聊**，并 @ 提及负责各部分的员工。
- 群聊可从你的会话列表中随时查阅，完整呈现员工之间的往来过程。
- 提问、回答与汇报都走同一套消息模型，因此任何一个结果是如何产生的都清晰可查。

### 模型服务商

- 通过精选列表接入服务商（Anthropic、OpenAI、DeepSeek、Google、Groq、MiniMax、Moonshot AI、OpenRouter、OpenCode Zen、OpenCode Go、xAI、小米、小米 Token Plan（CN/AMS/SGP）、Z.ai、GitHub Copilot 等），也可添加**自定义**服务商。
- 支持 OpenAI 兼容的 completions / responses、Anthropic Messages 与 Google Generative AI 协议。
- 一键获取可用模型列表；API 密钥默认打码，仅在明确操作后显示。

### MCP 服务

- 以 **stdio** 或 **streamable HTTP** 方式注册 [Model Context Protocol](https://modelcontextprotocol.io) 服务。
- 按员工分配服务，让每个会话只连接真正需要的工具。
- 支持服务级环境变量，以及与工具和服务共享的应用级环境变量。

### 技能

- 从本地文件夹安装 [Agent Skills](https://agentskills.io)（以 `SKILL.md` 为准），不用时随时卸载。
- 精确选择每位员工可以使用哪些技能。
- 助理自带内置技能，可代你管理 MCP 服务、管理技能，以及开发微应用。

### 微应用

- 在侧边栏、紧挨着会话的位置直接运行本地 Web 应用。
- 一个微应用就是一个带 `metadata.json` 的文件夹，既可以是静态页面，也可以是可启动的进程（含命令、参数、工作目录与环境变量）。
- 模块之间切换时微应用持续运行；助理可以替你创建并调试微应用。

### 定时任务

- 给员工设置 cron 计划，让它自动被唤醒——比如每日简报或定时巡检。
- 可查看下次运行时间，并按员工开启或关闭任务。
- 任务在应用打开期间运行（应用内调度器，而非系统级服务）。

### 消息集成

- 把 imboss 桥接到你日常使用的通讯软件，用手机也能办公：
  - **微信**：通过官方 iLink Bot 接入（扫码登录）。
  - **QQ**：通过 QQ 官方机器人平台接入。
  - **Telegram**：通过 @BotFather 机器人接入。
- 负责人账号会被加入白名单：你发送的消息会被视为你的指令，助理的回复也会送回到该会话。
- 收到的图片与文件会导入到会话中，发出的消息则以平台原生形式转发。

### 通知提醒

- 窗口在后台时，智能体发帖会触发系统原生通知——点击即可直接跳转到对应会话。
- 未读计数与提示音让你不错过任何新动态。

### 外观与语言

- 亮色、暗色与跟随系统三种主题，搭配 **18 种主题色**。
- 支持简体中文与英文，默认跟随系统语言。

### 本地优先，隐私可控

- 所有数据都存放在主目录下的同一个文件夹：**`~/.imboss`**——包括数据库、头像、智能体环境、会话与微应用。
- imboss 管理自己独立的 Pi 智能体环境，绝不影响系统级的 Pi 安装。
- API 密钥保存在本地，并设置严格的访问权限。

### 远程模式

- 后端可以作为一个纯 Node.js 包运行在**远程服务器**上，本机的桌面应用远程连接它。不带任何参数启动时，imboss 与以前完全一致：全部本地、不联网。
- 会话、智能体、定时任务、消息集成与你的数据都在服务器上；桌面端保留窗口、托盘、全局快捷键、通知以及自身的更新能力。
- 两端通过带共享 token 的 gRPC 通信。你附加的文件会上传到服务器，历史消息里的图片则按需从服务器拉取。

**服务器**（Node.js >= 22，一个可写的家目录；压缩包用 `pnpm run build:remote` 生成，见[构建](#构建)）：

```bash
unzip imboss-backend-<version>.zip && cd imboss-backend-<version>
npm install --omit=dev      # 压缩包不含 node_modules；better-sqlite3 提供预编译二进制
node main.cjs --init        # 生成 ~/.imboss/server.json（权限 0600）并打印 token
node main.cjs               # 用 systemd/pm2 托管，样例见 systemd/imboss-backend.service
```

**桌面端**：

```bash
imboss --remote=<host>:47810 --remote-token-file=$HOME/.imboss-token
```

| 参数                                     | 含义                                                     |
| ---------------------------------------- | -------------------------------------------------------- |
| `--remote=<host:port>`                   | 连接远程后端，而不是本地运行。                           |
| `--remote-token-file=<path>`             | 从文件读取 token（推荐）。                               |
| `--remote-token-env=<NAME>`              | 从环境变量读取 token。                                   |
| `--remote-token=<token>`                 | 直接在命令行给出 token——仅用于调试，会出现在进程列表里。 |
| `--remote-ca=<pem>`、`--remote-insecure` | 为向后兼容而接受；本版本使用明文 gRPC，只会给出警告。    |

服务器端参数：`--init`、`--config <path>`、`--data-root <path>`、`--listen <host:port>`（默认 `0.0.0.0:47810`）、`--token-file <path>`、`--token <token>`（仅调试）、`--version`、`--help`。token 也可通过 `IMBOSS_TOKEN` / `IMBOSS_TOKEN_FILE` 提供。

**安全提示。** 传输为明文 gRPC，唯一认证手段是共享 token。不要把端口直接暴露到公网：请置于防火墙之后，或使用 SSH 隧道（`ssh -L 47810:127.0.0.1:47810 host`，并在服务器上以 `--listen 127.0.0.1:47810` 启动），或使用 Tailscale、WireGuard 之类的私有网络。

**已知限制。** 一个后端只服务一个客户端（第二个会被明确拒绝）；远程模式下微应用会被隐藏；后端没有自更新（替换目录后重启）；附件上限 50 MiB；导入（备份包与员工包）以流式写入磁盘，上限 2 GiB。

### 自动更新

- 内置基于 GitHub Releases 的更新能力：收到提醒、下载并重启即可应用新版本。

## 快速开始

**环境要求**

- Node.js >= 22
- pnpm >= 9
- 原生模块编译工具链（macOS 需 Xcode CLT，Windows 需 MSVC，Linux 需 `build-essential`）

**安装并运行**

```bash
pnpm install            # 安装依赖，并为 Electron 重新编译原生模块
pnpm dev                # 启动应用，支持热更新
```

首次启动后，先在**模型服务商**中添加一个服务商，然后到**对话**里和你的助理打个招呼吧。

## 构建

```bash
pnpm build              # 类型检查 + 构建
pnpm run build:remote   # 打包无界面后端 → dist/imboss-backend-<version>.zip
pnpm dist:mac           # macOS（DMG + ZIP）
pnpm dist:win           # Windows（NSIS 安装包）
pnpm dist:linux         # Linux（AppImage）
```

`build:remote` 把后端入口打包成 `main.cjs`，生成只含运行时依赖、**没有 `postinstall`** 的 `package.json`，并连同 `proto/` 接口约定、README 与 systemd 样例一起打成一个压缩包。**包内不含 `node_modules`**——由服务器自行安装，这样原生模块 `better-sqlite3` 的二进制才能与服务端平台匹配。

## 许可说明

imboss 采用**双重许可**模式：

- **开源许可 —— GPL-3.0。** 个人使用免费，条款全文见 [LICENSE](LICENSE)。
- **商业许可。** **只要在企业范围内使用 imboss——包括仅限内部使用——都需要付费授权**，详见 [LICENSE-COMMERCIAL.md](LICENSE-COMMERCIAL.md)；如有需要，请联系 [kefroth@outlook.com](mailto:kefroth@outlook.com) 了解细节。

若你依据 GPL-3.0 使用 imboss，就需履行其全部义务，包括以相同许可开放你的衍生作品。但请注意，履行 GPL-3.0 本身**并不**授予企业使用权限：只要在企业范围内使用，都需要商业许可。若你无法或不愿履行 GPL-3.0，或者需要企业使用，则需要商业许可。

欢迎参与贡献 —— 请参阅 [CONTRIBUTING.md](CONTRIBUTING.md) 与[贡献者许可协议](CLA.md)。

## 技术实现

- **运行时** —— Electron 44、React 19 + TypeScript、`electron-vite`。
- **数据** —— `better-sqlite3`（WAL 模式）。本地模式下仅驻留主进程、通过 IPC 访问；远程模式下由远端纯 Node.js 后端承载，桌面端通过 gRPC 访问。
- **智能体** —— [Pi SDK](https://github.com/earendil-works/pi-coding-agent)，隔离运行于 `~/.imboss/agent`。
- **更新与打包** —— `electron-updater` 与 `electron-builder`。

## Buy me a coffee

如果您认为我所开发的软件对您有所帮助，并且愿意给予肯定和支持，不妨扫描下方的二维码进行打赏。感谢您的支持与关注。

![wx](https://user-images.githubusercontent.com/3410293/236807219-cf21180a-e7f8-44a9-abde-86e1e6df999b.jpg)
