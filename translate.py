import re

with open("packages/dashboard/src/pages/index.astro", "r", encoding="utf-8") as f:
    t = f.read()

replacements = {
    "<h2>🔐 X 账号授权</h2>": "<h2>🔐 X 账号授权 <span style='font-size:0.7em;color:var(--text-muted)'>/ X Auth</span></h2>",
    "获取 Refresh Token。</div>": "获取 Refresh Token. / Authorize Agent's X account to get Refresh Token.</div>",
    "浏览器授权（推荐）</h3>": "浏览器授权（推荐） / Browser Auth (Recommended)</h3>",
    "回调 URL 包含：": "回调 URL 包含 (callback URL includes): ",
    "🔗 打开授权页面": "🔗 打开授权页面 / Open Auth Page",
    "等待授权回调中……": "等待授权回调中…… / Waiting for callback...",
    "授权成功！Refresh Token 已获取。": "授权成功！Refresh Token 已获取。 / Auth Successful! Refresh Token obtained.",
    "跳过 — 已有 Refresh Token</h3>": "跳过 — 已有 Refresh Token / Skip — Already have Refresh Token</h3>",
    "✓ 使用此 Token": "✓ 使用此 Token / Use this Token",
    "已使用手动输入的 Token。": "已使用手动输入的 Token。 / Manual Token applied.",
    "下一步 →": "下一步 → / Next",

    # Step 2
    "<h2>⚡ Gemini 配置</h2>": "<h2>⚡ Gemini 配置 <span style='font-size:0.7em;color:var(--text-muted)'>/ Gemini Config</span></h2>",
    "输入你的 Gemini API Key 和模型名称。</div>": "输入你的 Gemini API Key 和模型名称。 / Enter your Gemini API Key and Model Name.</div>",
    "<label>模型名称</label>": "<label>模型名称 / Model Name</label>",
    "👉 请点右侧拉取列表 或 选择下方填入</option>": "👉 请点右侧拉取列表 或 选择下方填入 / Click right to fetch or select below</option>",
    "✍️ 手动输入...</option>": "✍️ 手动输入... / Manual input...</option>",
    "填入具体的模型名...": "填入具体的模型名... / Enter specific model name...",
    "点此拉取列表</button>": "点此拉取列表 / Fetch List</button>",
    "支持的所有可用模型。</p>": "支持的所有可用模型。 / Enter API Key and click to fetch all available models.</p>",
    "← 返回</button>": "← 返回 / Back</button>",

    # Step 3
    "<h2>�� Agent 身份</h2>": "<h2>🎭 Agent 身份 <span style='font-size:0.7em;color:var(--text-muted)'>/ Agent Identity</span></h2>",
    "核心身份信息已与您的授权 X 账号强绑定。</div>": "核心身份信息已与您的授权 X 账号强绑定。 / Agent core identity is securely bound.</div>",
    "<label>展示名称</label>": "<label>展示名称 / Display Name</label>",
    "授权账号昵称：": "授权账号昵称 / Auth Account Name: ",
    "（正在获取...）": "（正在获取... / fetching...）",
    "自动从您的身份提供者中读取": "自动从您的身份提供者中读取 / Auto read from identity provider",
    "不含 @）</label>": "不含 @ / without @）</label>",
    "授权账号短柄：": "授权账号短柄 / Auth Account Handle: ",
    "逗号分隔，不含 @": "逗号分隔，不含 @ / comma separated, no @",
    "例：elonmusk": "例 / Example: elonmusk",
    "推文用于人格蒸馏。</p>": "推文用于人格蒸馏。 / Will fetch tweets from these accounts for persona distillation.</p>",

    # Step 4
    "<h2>🧪 人格蒸馏</h2>": "<h2>🧪 人格蒸馏 <span style='font-size:0.7em;color:var(--text-muted)'>/ Distillation</span></h2>",
    "拉取推文，利用 LLM 配置生成 system prompt。</div>": "拉取推文，利用 LLM 配置生成 system prompt。 / Fetch tweets and generate system prompt.</div>",
    "提取出此人的行文风格。</div>": "提取出此人的行文风格。 / Will extract writing style from recent tweets.</div>",
    "Token 费率！</p>": "Token 费率！ / Highly recommend generating Chinese prompt to save costs!</p>",
    "🚀 开始一键蒸馏": "🚀 开始一键蒸馏 / Start Distillation",
    "约需 10-30 秒）……<": "约需 10-30 秒）…… / Distilling (takes 10-30s)...<",
    "<label>人格配置输出 (System Prompt)</label>": "<label>人格配置输出 / System Prompt Output</label>",
    "自己手写！": "自己手写！ / Distilled persona_skill will show here, you can handwrite or edit it!",

    # Step 5
    "<h2>🎯 样本调教</h2>": "<h2>🎯 样本调教 <span style='font-size:0.7em;color:var(--text-muted)'>/ Tuning</span></h2>",
    "生成演练样本以调优 Agent 的发言。</div>": "生成演练样本以调优 Agent 的发言。 / Generate practice samples to tune voice.</div>",
    "🎲 生成测试样本": "🎲 生成测试样本 / Generate Test Samples",
    "正在思考……": "正在思考…… / Thinking...",
    "系统提示词后重新生成。</label>": "系统提示词后重新生成。 / If unsatisfied, modify the system prompt and regenerate.</label>",

    # Step 6
    "<h2>⚖️ 经济与参数</h2>": "<h2>⚖️ 经济与参数 <span style='font-size:0.7em;color:var(--text-muted)'>/ Parameters</span></h2>",
    "调整互动概率与冷却时间。</div>": "调整互动概率与冷却时间。 / Adjust interaction probability and cooldown.</div>",
    "回复概率（0~1）": "回复概率 / Reply Probability (0~1)",
    "点赞概率（0~1）": "点赞概率 / Like Probability (0~1)",
    "回复冷却时间（小时）": "回复冷却时间 / Reply Cooldown (Hours)",
    "开启夜间自动演进 (Nightly Evolution)": "开启夜间自动演进 / Enable Nightly Evolution",
    "经验优化人格。</p>": "经验优化人格。 / Automatically summarize daily interactions to optimize persona.</p>",

    # Step 7
    "<h2>🧠 记忆控制</h2>": "<h2>🧠 记忆控制 <span style='font-size:0.7em;color:var(--text-muted)'>/ Memory</span></h2>",
    "记忆并回应哪些人的互动。</div>": "记忆并回应哪些人的互动。 / Control whose interactions the Agent remembers.</div>",
    "<label>白名单模式</label>": "<label>白名单模式 / Whitelist Mode</label>",
    "仅白名单用户）</option>": "仅白名单用户） / Specific Users (Whitelist only)</option>",
    "触发记忆）</option>": "触发记忆） / Everyone (Any interaction triggers memory)</option>",
    "<label>白名单用户 (VIP List)</label>": "<label>白名单用户 / VIP List</label>",

    # Step 8
    "<h2>🚀 部署配置</h2>": "<h2>🚀 部署配置 <span style='font-size:0.7em;color:var(--text-muted)'>/ Deploy</span></h2>",
    "激活生命流。</div>": "激活生命流。 / Final confirmation to save your Agent and activate its life stream.</div>",
    "✨ 点燃灵魂火种 (部署 Agent)": "✨ 点燃灵魂火种 / Ignite Soul (Deploy Agent)",

    # JS array
    "['授权','Gemini','身份','蒸馏','调教','经济','记忆','部署']": "['授权/Auth','Gemini','身份/Identity','蒸馏/Distill','调教/Tune','经济/Param','记忆/Memory','部署/Deploy']",

    "<strong>授权账号:</strong>": "<strong>授权账号 / Auth Account:</strong>",
    "<strong>模型配置:</strong>": "<strong>模型配置 / Model Config:</strong>",
    "<strong>源账号:</strong>": "<strong>源账号 / Source Accounts:</strong>",
    "<strong>记忆模式:</strong>": "<strong>记忆模式 / Mode:</strong>",
    "监听全网": "监听全网 / Listen to All",
    "特定白名单": "特定白名单 / Whitelist",
    "<strong>互动概率:</strong>": "<strong>互动概率 / Interaction Pct:</strong>",
    "点赞 ": "点赞 / Like ",
    "回复 ": "回复 / Reply ",
    
    "🎉 <b>Agent 部署成功！</b><br><br>": "🎉 <b>Agent 部署成功！ / Agent Deployed Successfully!</b><br><br>",
    "开始自动巡逻。点击下方进入专属 Dashboard：<br>": "开始自动巡逻。<br>Your Agent is active. Click below to enter your Dashboard:<br>",
    "进入控制台</a>": "进入控制台 / Enter Dashboard</a>",

    "✅ 蒸馏成功！": "✅ 蒸馏成功！ / Distillation Successful!",
    "抓取了": "抓取了 / fetched",
    "条推文": "条推文 / tweets",
    "✏️ 自发推文": "✏️ 自发推文 / Spontaneous Tweet",
    "💬 互动回复": "💬 互动回复 / Interactive Reply"
}

for k, v in replacements.items():
    t = t.replace(k, v)

with open("packages/dashboard/src/pages/index.astro", "w", encoding="utf-8") as f:
    f.write(t)
