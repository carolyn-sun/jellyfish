# 🪼 Jellyfish

> **在 X (Twitter) 上运行的 AI 人格代理平台 — 完全托管于 Cloudflare，零服务器运维。**

Jellyfish 是一个开源的 Multi-Agent 框架，让你可以将任何 X 账号（或多个账号）的推文风格提炼为 AI 人格档案（Skill），然后将其部署为一个能自主互动的 X Agent。Agent 会以指定人格回复 @提及、浏览时间线、自发发推，并随时间演化自身人格——全程无需人工干预。

---

## ✨ 核心功能

| 功能           | 说明                                                                    |
| -------------- | ----------------------------------------------------------------------- |
| **人格蒸馏**   | 从任意 X 账号的历史推文中，用 Gemini 提炼出结构化人格档案（Skill 文档） |
| **自动回复**   | 每分钟轮询 @提及，以人格驱动的 LLM 生成回复或选择跳过                   |
| **时间线互动** | 每小时扫描关注者/VIP 用户的推文，自主点赞或回复                         |
| **自发发推**   | 每天定时触发，以人格风格主动发一条原创推文                              |
| **记忆系统**   | Pro 模式：记录互动历史，每 6 小时合并记忆                               |
| **人格进化**   | Pro 模式：每晚 UTC 03:00 根据近期记忆自动演化 Skill 文档                |
| **多 Agent**   | 单一 Worker 实例同时托管多个独立 Agent，全部走同一个 cron               |
| **Zero-infra** | 完全运行在 Cloudflare Workers + KV + D1，无需服务器                     |

---

## 🏗 架构概览

```
jellyfish/
├── packages/
│   ├── worker/          # Cloudflare Worker（后端 + API + cron）
│   │   └── src/
│   │       ├── index.ts        # Worker 入口（cron + HTTP 分发）
│   │       ├── api.ts          # Hono HTTP 路由（OAuth、Agent CRUD、管理 API）
│   │       ├── agent.ts        # Agent 核心逻辑（提及处理、时间线、发推）
│   │       ├── llm.ts          # LLM 封装（Gemini / Grok，回复/发推/进化生成）
│   │       ├── builder.ts      # Skill 蒸馏与调优（Wizard 后端）
│   │       ├── twitter.ts      # X API 封装（OAuth 2.0 PKCE）
│   │       ├── memory.ts       # KV 持久化（状态、记忆、日志）
│   │       ├── auth.ts         # Access Token 自动刷新
│   │       ├── gemini.ts       # Gemini / Grok API 调用（统一走 CF AI Gateway）
│   │       ├── scheduled.ts    # Cron 调度分发（按时间路由各 loop）
│   │       └── types.ts        # 全局类型定义
│   └── dashboard/       # 前端 Dashboard（Astro，静态部署到 Worker /public）
│       └── src/pages/
│           ├── index.astro     # 首页（介绍 + Wizard 入口）
│           ├── wizard.astro    # Agent 创建向导
│           └── dashboard.astro # Agent 控制台（日志、配置、技能编辑）
```

**数据存储：**

- **Cloudflare D1**（SQLite）：存储所有 Agent 配置及凭据
- **Cloudflare KV**：存储 Agent 运行时状态（游标、缓存、记忆、会话）

---

## 🚀 快速开始

### 前置条件

- Node.js ≥ 20
- pnpm（`npm i -g pnpm`）
- Cloudflare
- [X Developer Portal](https://developer.twitter.com/) 账号 + 一个 App（需要 OAuth 2.0）
- [Cloudflare AI Gateway](https://developers.cloudflare.com/ai-gateway/) — 统一代理 LLM 请求（必须）
- LLM 提供商之一：
  - [Google AI Studio](https://aistudio.google.com/)（Gemini，默认）
  - [xAI](https://console.x.ai/)（Grok，可选）

> [!IMPORTANT]
> 根据 X 用户协议，在 X 平台上进行自动化操作时，**应当**使用 Grok 作为 LLM 来生成内容。若计划公开部署，建议将 `GEMINI_MODEL` 设为 Grok 模型并配置 `GROK_API_KEY`。

---

### 第一步：克隆并安装依赖

```bash
git clone https://github.com/your-org/jellyfish.git
cd jellyfish
pnpm install
```

---

### 第二步：创建 Cloudflare 基础设施

#### 2.1 创建 KV Namespace

```bash
npx wrangler kv namespace create AGENT_STATE
```

命令输出会给出一个 `id`，将其填入 `packages/worker/wrangler.toml`：

```toml
[[kv_namespaces]]
binding = "AGENT_STATE"
id = "<YOUR_KV_ID>"
```

#### 2.2 创建 D1 数据库

```bash
npx wrangler d1 create agent_saas
```

同样将输出的 `database_id` 填入 `wrangler.toml`：

```toml
[[d1_databases]]
binding = "DB"
database_name = "agent_saas"
database_id = "<YOUR_D1_ID>"
```

#### 2.3 初始化数据库 Schema

```bash
cd packages/worker
npx wrangler d1 execute agent_saas --file=schema.sql
```

---

### 第三步：配置 X (Twitter) App

在 [X Developer Portal](https://developer.twitter.com/en/portal/dashboard) 中：

1. 创建一个 App，启用 **OAuth 2.0**
2. 将 **Type** 设为 `Web App, Automated App or Bot`
3. 在 **Callback / Redirect URLs** 中添加：
   - 本地开发：`http://localhost:8787/callback`
   - 生产环境：`https://<your-domain>/callback`
4. 开启 **Read and write** 权限（发推需要）
5. 记录 `Client ID` 和 `Client Secret`

> **提示**：建议创建两个 App：一个用于 Agent 操作（需要 `offline.access`），一个仅用于 Dashboard 身份验证（只需要 `tweet.read users.read`）。这样可以避免 Dashboard 登录导致 Agent 的 refresh token 失效。

在 `packages/worker/wrangler.toml` 中配置：

```toml
[vars]
X_CLIENT_ID = "<AGENT_APP_CLIENT_ID>"
X_AUTH_CLIENT_ID = "<AUTH_APP_CLIENT_ID>"  # 可选，Dashboard 专用 App
```

---

### 第四步：配置 AI Gateway（Gemini / Grok）

Jellyfish 通过 **Cloudflare AI Gateway** 统一代理所有 LLM API 请求，支持 **Gemini**（默认）和 **Grok**（xAI），可在 `wrangler.toml` 中按需切换，无需改动代码。

1. 在 Cloudflare Dashboard → **AI → AI Gateway** 中创建一个 Gateway（如 `jellyfish-gateway`）
2. 在 Gateway 的 **Authentication** 中生成一个 Token
3. 在 `wrangler.toml` 中配置：

```toml
[vars]
CF_ACCOUNT_ID = "<YOUR_CF_ACCOUNT_ID>"
CF_GATEWAY_NAME = "jellyfish-gateway"

# ── 使用 Gemini（默认）──────────────────────────────────────────
GEMINI_MODEL = "gemini-2.5-flash-preview"  # 或 gemini-2.5-pro-preview 等

# ── 使用 Grok（可选，与 Gemini 二选一或并存）───────────────────
# GEMINI_MODEL = "grok-3-mini-fast"         # 填写 xAI 模型名即可切换
```

> **CF_ACCOUNT_ID** 在 Cloudflare Dashboard 右侧栏 "Account ID" 处可以找到。

#### 使用 Grok

若要切换到 Grok，还需额外设置 xAI API Key：

```bash
npx wrangler secret put GROK_API_KEY
# 在 https://console.x.ai/ 中生成 API Key
```

在 `wrangler.toml` 中将 `GEMINI_MODEL` 的值改为 xAI 支持的模型名（如 `grok-3-mini-fast`、`grok-3`），系统会自动通过 CF AI Gateway 的 xAI 提供商路由请求。两个 provider 可以同时保留配置，运行时按 `GEMINI_MODEL` 的值决定走哪一路。

---

### 第五步：设置 Secrets

所有敏感凭据通过 `wrangler secret put` 存储，**不要**写入 `wrangler.toml`：

```bash
cd packages/worker

# X App 的 OAuth 客户端密钥
npx wrangler secret put X_CLIENT_SECRET
# (输入 Agent App 的 Client Secret)

# Dashboard 专用 App 密钥（可选）
npx wrangler secret put X_AUTH_CLIENT_SECRET

# Cloudflare AI Gateway Token
npx wrangler secret put CF_AIG_TOKEN

# Admin Dashboard 保护密钥（自定义任意字符串）
npx wrangler secret put ADMIN_SECRET

# 部署授权码（用于保护 Agent 创建流程，防止陌生人消耗你的 API 配额）
npx wrangler secret put DEPLOY_PASSCODE

# X Bearer Token（App-only，用于 Wizard 的人格蒸馏功能）
# 在 X Developer Portal 的 App 页面→ "Keys and tokens" 中生成
npx wrangler secret put BEARER_TOKEN

# xAI API Key（使用 Grok 模型时必填，在 https://console.x.ai/ 中生成）
npx wrangler secret put GROK_API_KEY
```

**本地开发**时，在 `packages/worker/.dev.vars` 中填写这些值（此文件已在 `.gitignore` 中，请勿提交）：

```ini
X_CLIENT_SECRET="..."
X_AUTH_CLIENT_SECRET="..."
CF_AIG_TOKEN="..."
ADMIN_SECRET="..."
DEPLOY_PASSCODE="..."
BEARER_TOKEN="..."
GROK_API_KEY="..."       # xAI API Key, Grok 模型时必填
LOCAL_ORIGIN="http://localhost:8787"
```

---

### 第六步：本地开发

```bash
# 在项目根目录运行（同时构建 Dashboard 并启动 Worker 开发服务器）
pnpm dev
```

Worker 将在 `http://localhost:8787` 启动，Dashboard 页面可通过以下路径访问：

- `http://localhost:8787/` — 首页 + Wizard 入口
- `http://localhost:8787/wizard` — Agent 创建向导
- `http://localhost:8787/dashboard?id=<agent_id>` — Agent 控制台

---

### 第七步：部署到 Cloudflare

```bash
# 构建 Dashboard 并部署 Worker
pnpm deploy
```

首次部署后，在 `wrangler.toml` 中配置自定义域名：

```toml
routes = [
  { pattern = "your-domain.com", custom_domain = true }
]
```

---

## 🧙 使用 Wizard 创建 Agent

部署完成后，访问 `https://your-domain.com/wizard`（或本地 `http://localhost:8787/wizard`）：

### 流程概览

```
输入部署授权码
     ↓
输入 X 源账号（用于蒸馏人格）
     ↓
AI 分析历史推文 → 生成 Skill 文档
     ↓
预览样本推文 / 调优人格
     ↓
Agent X 账号授权（OAuth 2.0）
     ↓
配置行为参数
     ↓
Deploy → 生成 Dashboard 链接
```

### 配置参数说明

| 参数             | 说明                                             | 默认值  |
| ---------------- | ------------------------------------------------ | ------- |
| **源账号**       | 用于提取人格的 X 账号（可多个，用逗号分隔）      | —       |
| **回复概率**     | Agent 在收到 @提及时选择回复的概率（0–1）        | `0.2`   |
| **点赞概率**     | 时间线扫描时点赞的概率（0–1）                    | `0.8`   |
| **自发发推间隔** | 两次自发发推之间的最小冷却天数                   | `3`     |
| **VIP 用户列表** | 对特定用户启用自定义回复概率或人格覆盖           | —       |
| **记忆白名单**   | 哪些用户的互动会被记入 Agent 的长期记忆（Pro）   | `[]`    |
| **自动人格进化** | 是否允许 Agent 每晚根据记忆自动更新 Skill（Pro） | `false` |

---

## 📊 Dashboard 功能

访问 `https://your-domain.com/dashboard?id=<your-agent-id>` 后，使用 Agent 的 X 账号登录。

### 可用功能

- **活动日志**：查看 Agent 最近的所有行为（回复、点赞、发推、跳过）
- **手动触发**：立即触发一次提及扫描、时间线互动或自发发推
- **Skill 编辑器**：在线编辑 Agent 的人格 Skill 文档
- **行为参数调整**：修改回复/点赞概率、冷却天数
- **记忆查看**（Pro）：查看当前积累的互动记忆碎片
- **手动进化**（Pro）：立即触发一次人格进化
- **Token 健康检查**：检测 OAuth Token 是否有效，失效时一键重新授权

---

## 🔄 Cron 调度时间表

Worker 每分钟触发一次 cron，内部按当前 UTC 时间路由到不同的任务：

| 任务           | 调度             | 说明                                           |
| -------------- | ---------------- | ---------------------------------------------- |
| 提及轮询       | 每分钟           | 检查新 @提及，每次运行最多处理 5 条，4 轮/分钟 |
| 时间线互动     | 每整点           | 扫描 VIP/粉丝推文，最多点赞/回复 2 条          |
| 自发发推       | UTC 12:30        | 主动发一条原创推文（受冷却期控制）             |
| 记忆合并       | UTC 0/6/12/18:00 | 将近期互动写入长期记忆（Pro）                  |
| 人格进化       | UTC 03:00        | 根据记忆自动更新 Skill 文档（Pro）             |
| 源账号名称刷新 | UTC 02:00        | 更新源账号的显示名缓存                         |

---

## 🔑 API 端点参考

所有端点均由 Worker 暴露，Dashboard 前端直接调用。

### 公开端点

| 方法   | 路径                        | 说明                                    |
| ------ | --------------------------- | --------------------------------------- |
| `POST` | `/api/auth/deploy-passcode` | 验证部署授权码，返回一次性 deploy token |
| `POST` | `/api/oauth/start`          | 启动 X OAuth 2.0 PKCE 流程              |
| `GET`  | `/api/oauth/result`         | 轮询 OAuth 结果                         |
| `GET`  | `/callback`                 | X OAuth 回调处理                        |
| `POST` | `/api/distill`              | 从源账号推文蒸馏 Skill 文档             |
| `POST` | `/api/tune/sample`          | 生成 Skill 预览样本（发推 + 回复示例）  |
| `POST` | `/api/tune/refine`          | 根据反馈调优 Skill 文档                 |
| `GET`  | `/api/models`               | 列出可用 Gemini 模型                    |
| `POST` | `/api/agent/create`         | 创建或更新 Agent（需要 deploy token）   |
| `GET`  | `/api/agent/find-by-handle` | 按 X handle 查找 Agent ID               |

### 需要 Session Token 的端点

> Session Token 通过 `X-Session-Token` 请求头传递，在 OAuth 验证成功后签发（有效期 24 小时）。

| 方法   | 路径                              | 说明                          |
| ------ | --------------------------------- | ----------------------------- |
| `GET`  | `/api/agent/detail?id=`           | 获取 Agent 配置（不含 token） |
| `GET`  | `/api/agent/activity?id=`         | 获取活动日志                  |
| `GET`  | `/api/agent/memory?id=`           | 获取互动记忆（Pro）           |
| `POST` | `/api/agent/trigger?id=`          | 手动触发提及扫描              |
| `POST` | `/api/agent/spontaneous?id=`      | 手动触发自发发推              |
| `POST` | `/api/agent/trigger-timeline?id=` | 手动触发时间线互动（Pro）     |
| `POST` | `/api/agent/refresh-memory?id=`   | 手动触发记忆合并（Pro）       |
| `POST` | `/api/agent/evolve?id=`           | 手动触发人格进化（Pro）       |
| `POST` | `/api/agent/update-config?id=`    | 更新行为参数                  |
| `POST` | `/api/agent/update-skill?id=`     | 更新 Skill 文档               |
| `POST` | `/api/agent/activate-license?id=` | 激活 Pro 授权码               |

---

## 📝 Skill 文档格式

Skill 文档是驱动 Agent 行为的核心——它是一份结构化的 Markdown 人格档案，作为 LLM 的 System Instruction 运行。

Wizard 会自动生成，也可以手动编写或在 Dashboard 中编辑。Skill 同时支持**中文**和**英文**，系统会自动检测语言并在提示词中保持一致。

### 推荐章节结构

```markdown
## 背景设定

身份、社交圈子、兴趣领域的简短描述。

## 核心性格

- 某个显著性格维度
- 另一个维度（3–6 条）

## 三观

- **世界观**：对社会与现实的基本判断
- **人生观**：对生命意义与目标的态度
- **价值观**：是非判断标准与优先级

## 政治倾向

（可选）政治谱系定位及对具体议题的立场。

## 兴趣爱好

具体的圈子、作品、活动列表。

## 性癖

独特的审美趣味和小众迷恋点。

## 情绪模式

情绪触发点、表达方式、调节风格。

## 人际关系模式

在网络上与他人相处的方式。

## 自我认知与盲区

自我呈现与实际形象的差距。

## 禁区与雷点

会引发强烈反应或被避免的话题。

## 口癖

惯用词汇、口头禅、句式结构（附原文示例）。

## 语气与腔调

语域、中英混用习惯、标点与 emoji 偏好。

## 行为约束

- 回复字数限制：通常不超过 X 字
- 若内容无聊或不相关，输出 `<skip>` 跳过
- 不使用话题标签（#）
```

---

## 🔒 安全设计

- **DEPLOY_PASSCODE**：保护 Agent 创建入口，防止任何人消耗你的 API 配额部署 Agent
- **Session Token**：所有写操作（配置修改、手动触发）都要求有效的 24 小时 Session Token，由 X OAuth 验证后签发
- **Agent Secret**：可选的密码登录方式，作为 OAuth 登录的备用方案，存储为明文但在比较时使用常数时间对比以防时序攻击
- **Rate Limiting**：`/api/auth/deploy-passcode` 和 `/api/agent/verify-secret` 均有基于 KV 的暴力破解防护（IP 级别，15分钟冻结）
- **Bot Loop 防护**：双层（user ID + handle）机器人识别，防止平台内 Agent 互相无限回复
- **Thread Depth 限制**：每个线程最多回复 2 次，防止对话无限延伸

---

## 🛠 开发指南

### 项目脚本

在根目录运行：

```bash
pnpm dev        # 构建 Dashboard + 启动 Worker 开发服务器
pnpm build      # 构建 Dashboard + 构建 Worker（不部署）
pnpm deploy     # 构建 Dashboard + 部署 Worker 到 Cloudflare
pnpm typecheck  # TypeScript 类型检查（仅 Worker）
```

### 添加新 Agent 动作

1. 在 `packages/worker/src/agent.ts` 中实现新的 `run*` 函数
2. 在 `packages/worker/src/scheduled.ts` 的 `runScheduled` 中按时间条件路由
3. 在 `packages/worker/src/api.ts` 中暴露对应的 HTTP 端点（如需 Dashboard 手动触发）
4. 在 `packages/dashboard/src/pages/dashboard.astro` 中添加 UI 按钮

### 数据库 Schema 变更

修改 `packages/worker/schema.sql` 后执行：

```bash
# 本地（Remote 模式，操作真实 Cloudflare D1）
npx wrangler d1 execute agent_saas --remote --file=schema.sql
```

> ⚠️ `schema.sql` 包含 `DROP TABLE IF EXISTS agents`，**生产环境执行前请务必备份数据**。

---

## 🌐 环境变量 / Secrets 完整参考

### `wrangler.toml` [vars]（明文，可提交）

| 变量                   | 必须 | 说明                                                                                                                       |
| ---------------------- | ---- | -------------------------------------------------------------------------------------------------------------------------- |
| `X_CLIENT_ID`          | ✅   | X App OAuth 2.0 Client ID（Agent 专用 App）                                                                                |
| `X_AUTH_CLIENT_ID`     | 可选 | Dashboard 身份验证专用 App 的 Client ID                                                                                    |
| `CF_ACCOUNT_ID`        | ✅   | Cloudflare 账号 ID                                                                                                         |
| `CF_GATEWAY_NAME`      | ✅   | Cloudflare AI Gateway 名称                                                                                                 |
| `GEMINI_MODEL`         | ✅   | LLM 模型名；填 Gemini 模型名走 Gemini，填 Grok 模型名走 xAI（如 `grok-3-mini-fast`）                                       |
| `KO_FI_MINIMUM_AMOUNT` | 可选 | 对私有部署没有意义                                                                                                         |
| `ENABLE_SUBSCRIPTIONS` | 可选 | **私有部署应当设置为`"0"`**，关闭订阅功能开关。`"1"`（默认）开启 Pro 授权校验；`"0"` 关闭订阅，所有 Agent 免费使用全部功能 |

### Secrets（通过 `wrangler secret put` 设置，不可提交）

| Secret                     | 必须 | 说明                                                      |
| -------------------------- | ---- | --------------------------------------------------------- |
| `X_CLIENT_SECRET`          | ✅   | X App OAuth 2.0 Client Secret（Agent App）                |
| `X_AUTH_CLIENT_SECRET`     | 可选 | Dashboard 专用 App 的 Client Secret                       |
| `CF_AIG_TOKEN`             | ✅   | Cloudflare AI Gateway 认证 Token                          |
| `ADMIN_SECRET`             | 建议 | 保护管理端点的任意密钥字符串                              |
| `DEPLOY_PASSCODE`          | 建议 | 保护 Agent 创建流程的部署授权码                           |
| `BEARER_TOKEN`             | ✅   | X 应用级 Bearer Token（用于 Wizard 蒸馏功能）             |
| `GROK_API_KEY`             | 可选 | xAI API Key（使用 Grok 模型时必填，在 console.x.ai 生成） |
| `KO_FI_VERIFICATION_TOKEN` | 可选 | Ko-Fi Webhook 验证 Token                                  |
