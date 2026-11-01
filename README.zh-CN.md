# dsh-ai-jobs

**DeepSeek Harness 的 AI 招聘雷达。**
把 AI 实验室与重度使用 AI 的公司的公开招聘板抓到一个本地索引里，按你自己的标准打分，抽出它们
真实写在 JD 里的要求（年限、技能、学历、办公模式、薪资、签证），并把每天新出现的岗位推成一份摘要。

不需要 API key，不需要账号，也不爬登录态站点：每个数据源都是公司为自己的 careers 页面公开的
ATS 接口。

## 解决什么问题

找 AI 岗位本质上是在约 70 家公司的异构招聘系统里做检索：数据是公开的，但分散、每周要人肉重读、
跨公司没法对比。这个插件维护一份本地索引，于是可以问跨公司的问题：

- 现在哪些实验室在招 research engineer，它们各自要求什么？
- 核心 AI 岗位里有多少要求博士？"N 年以上"的中位数是多少？
- 最近 7 天新开了哪些岗，哪些匹配我的技术栈？
- Anthropic / OpenAI / Mistral 要求的东西里，我缺哪几项？

## 能力

| 环节 | 说明 |
| --- | --- |
| **采集** | 71 个预先验证过的招聘板（Greenhouse / Ashby / Lever），自建公司可用 Workable / SmartRecruiters |
| **归一** | 跨 ATS 统一字段：标题、地点、远程标记、部门、发布时间、链接、JD 正文 |
| **分类** | `core` / `adjacent` / `other` 三档 AI 相关性 + 岗位族 + 职级，纯规则、可审计 |
| **抽取** | 年限、学历、办公模式、薪资区间、是否 sponsor 签证、38 个技能词表 |
| **打分** | 0–100：相关性 + 新鲜度 + 职级 + 你的目标技能 + 偏好地点 |
| **存储** | 本地 JSON 索引 + JD 快照 + 变更记录 + digest 游标 |
| **推送** | Markdown 摘要，并可经 harness 的 schedule 服务每天定时推送 |

## 安装

```bash
# 插件市场 / npm（发布后）
dsh plugin --profile web add dsh-ai-jobs

# 本地目录，开发用
dsh plugin --profile desktop add ./dsh-ai-jobs

# 打包后的 tarball
npm pack && dsh plugin --profile desktop add ./dsh-ai-jobs-0.1.0.tgz
```

bundle patch 只会挂一行插件（`ai-jobs`）；重启应用或到 Plugins 页开关即可。

## 快速上手

```
ai_jobs_refresh                     # 抓取所有监控的招聘板（首次约 10 秒 / 3 个大板）
ai_jobs_search { "tier": "core", "postedWithinDays": 7, "minScore": 70 }
ai_jobs_requirements { "tier": "core", "limit": 200 }
ai_jobs_digest
ai_jobs_watchlist { "action": "add", "company": "Mistral", "ats": "ashby", "token": "mistral.ai" }
```

## 工具

| 工具 | 返回 |
| --- | --- |
| `ai_jobs_refresh` | 重新索引全部或指定招聘板；逐板报告成功/失败与新增/变更/关闭数量 |
| `ai_jobs_search` | 过滤 + 打分后的岗位：`query`、`company`、`tier`、`seniority`、`remote`、`location`、`minScore`、`postedWithinDays`、`limit`、`sort` |
| `ai_jobs_get` | 单个岗位全量：元数据、分数、抽取到的要求、JD 开头、已存 JD 路径 |
| `ai_jobs_digest` | 自上次摘要以来（或最近 N 天）的变化，Markdown 格式 |
| `ai_jobs_requirements` | 跨公司聚合：技能出现频次、年限中位数、学历分布、办公模式分布、薪资区间 |
| `ai_jobs_watchlist` | `list` / `add` / `remove` 招聘板（greenhouse、ashby、lever、workable、smartrecruiters） |
| `ai_jobs_status` | 索引健康度：板数、在招/关闭数、分档占比、上次抓取、上次摘要、存储路径 |
| `ai_jobs_schedule` | `create` / `list` / `delete` 每日摘要提醒（需要 `schedule` 服务） |

## 每日推送

两种方式：

1. `ai_jobs_schedule { "action": "create", "time": "09:00:00", "timeZone": "Asia/Shanghai" }` —
   每个会话一条提醒（title ≤ 120 字）。
2. 配置里 `dailyDigest.enabled: true` — 会话首次执行 `ai_jobs_refresh` 或 `ai_jobs_digest` 时
   插件自己挂上提醒。

摘要只报告上次游标之后的新岗位，所以每天推送不会重复昨天的内容；
`ai_jobs_digest { "days": 7 }` 可以忽略游标看最近 7 天。

## 配置

```json
{
  "lang": "zh",
  "timeZone": "Asia/Shanghai",
  "concurrency": 4,
  "skillsOfInterest": ["LLM", "inference", "agents", "RAG"],
  "preferredLocations": ["San Francisco", "Remote"],
  "remoteOk": true,
  "digestPerCompany": 4,
  "digestLimit": 30,
  "digestMinScore": 0,
  "dailyDigest": { "enabled": true, "time": "09:00:00" },
  "companies": [
    { "company": "Cohere", "ats": "ashby", "token": "cohere", "tags": ["frontier-lab"] }
  ]
}
```

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `dataDir` | `$DSH_HOME/ai-jobs`（回退 `~/.dsh/ai-jobs`） | 索引、JD 快照、摘要状态 |
| `lang` | `zh` | 摘要语言（`zh` / `en`） |
| `concurrency` | `4` | 并发抓取的板数 |
| `timeoutMs` | `25000` | 单请求超时 |
| `jdMaxChars` | `20000` | 每条岗位保留的 JD 字符数 |
| `maxDetailPerBoard` | `60` | 每次刷新每个板补取 JD 的上限（Greenhouse） |
| `tags` | 随种子数据 | `frontier-lab`、`ai-native`、`ai-user`，参与打分与筛选 |
| `companies` | `[]` | 追加到内置种子数据之后的招聘板 |

## 数据源

全部为公司公开、无需鉴权的接口：

| ATS | 接口 | 内置板数 |
| --- | --- | --- |
| Greenhouse | `boards-api.greenhouse.io/v1/boards/{token}/jobs` | 33 |
| Ashby | `api.ashbyhq.com/posting-api/job-board/{token}` | 37 |
| Lever | `api.lever.co/v0/postings/{token}?mode=json` | 1 |
| Workable | `apply.workable.com/api/v1/widget/accounts/{token}` | — |
| SmartRecruiters | `api.smartrecruiters.com/v1/companies/{token}/postings` | — |

内置覆盖 Anthropic、OpenAI、xAI、Mistral、Cohere、Perplexity、Thinking Machines、Cursor、Cognition、
Harvey、Sierra、Decagon、ElevenLabs、Suno、Midjourney、Runway、Baseten、Cerebras、Fireworks、Modal、
Anyscale、Together、Scale、Pinecone、Weaviate、Chroma、LangChain、LlamaIndex、Databricks、Snowflake、
Stripe、Cloudflare、Datadog、Elastic、MongoDB、Figma、Notion、Vercel、Plaid、Ramp、Airbnb、Instacart、
Lyft、Pinterest、Reddit、Discord、Roblox、Duolingo、Khan Academy、Spotify 等。
Greenhouse 的 JD 需要第二次请求，插件只对新增/变更的岗位补取。

`ai_jobs_watchlist` 可以加任何使用上述招聘板的其他公司。token 需要人工确认——内置的 71 个是逐个
验证过的。

## 打分逻辑

```
score = 分档(核心 55 / 相邻 30 / 其他 8)
      + 新鲜度（约 40 天内从 30 线性降到 0）
      + 职级（实习 -6 … 首席 +7）
      + 目标技能命中（最高 12）
      + 偏好地点（最高 8）/ 支持远程（最高 6）
      + 明示薪资（3）
```

标题里带 AI 但实际招非技术职能的（法务、销售、政策、市场、招聘、财务、采购……）会在进入 AI
规则前被判为 `other`。

## 数据与隐私

- 全部存在本地 `$DSH_HOME/ai-jobs`：`store.json`（索引）、`jd/*.txt`（JD 快照）、摘要游标。
- 无遥测、无后端；只会用带说明的 User-Agent 访问上面列出的公开招聘接口。
- 不爬登录态站点，不读取、不保存任何凭据。
- 删除 `dataDir` 即清空全部数据。

## 合规提示

这些接口是公司为自己 careers 页面公开的。请保持默认的克制配置（`concurrency: 4`、每次刷新只取
一轮、只对新岗位补 JD），不要批量转售数据。要求、薪资与在招状态随时变化，行动前请到公司官网
careers 页确认。

## 开发

```bash
npm run smoke        # 校验 schema + 对两个小板跑通 refresh/search/digest
npm run live-check   # 对真实接口跑多板端到端
npm run probe        # 重新验证候选 ATS token
npm run seed         # 重建 data/companies.json
```

目录：`src/text.js`（HTML→文本）、`src/sources.js`（ATS 适配器）、`src/classify.js`
（分档/职级/要求抽取/打分）、`src/store.js`（索引 + JD 快照）、`src/digest.js`（Markdown）、
`src/tools.js`（8 个工具）、`src/index.js`（bundle 入口）。

零运行时依赖，只用 Node 内置模块。

## License

MIT
