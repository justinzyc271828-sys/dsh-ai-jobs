# dsh-ai-jobs 项目复盘

> 一句话：它把「海外 AI 公司的公开招聘信息」变成**可查询的本地索引 + 每天自动推送的一份筛选摘要**，
> 全部基于公开 ATS 接口，无需账号、无需 API Key、零运行时依赖。
>
> 复盘对象：v0.1.1（2026-11-01），3 次提交，源码 2,077 行，实测索引 11,230 个在招岗位、71 家公司板。
> 本文所有数字都来自本机实测，不是估计值。

---

## 1. 它能实现什么

对你的实际价值不是一个"爬虫"，而是**把招聘信息变成可对话的数据**。装上之后，你可以直接这样问：

| 你想问的问题 | 实际走哪条链路 | 真实返回示例（本机数据） |
| --- | --- | --- |
| 现在哪些 AI 实验室在招研究岗？ | `ai_jobs_search`（tier=core, family=research） | OpenAI 151 个、Anthropic 122 个、Sierra 74 个 |
| 我如果想投推理方向，要准备什么？ | `ai_jobs_get` 读单条 JD 全文 → 再问 | 逐条给出：年限要求、技能栈、学历、是否远程、薪资区间 |
| 核心 AI 岗里，市场最多要求哪些技能？ | `ai_jobs_requirements`（聚合 1,271 条） | Agents 507、Python 389、LLM 388、Safety/evals 201、Fine-tuning 169 |
| 最近 7 天新开的岗有哪些？ | `ai_jobs_digest`（sinceHours=168） | 核心岗 65 个（按分数排序，每家公司封顶） |
| 这个岗位到底要几年经验/要不要博士？ | `ai_jobs_get` + `requirements` 字段 | 年限中位数 5 年；核心岗里明确写学历的只有 23 条 |
| 哪家公司给的钱写出来了？ | `ai_jobs_search`（明示薪资 981 条） | 可过滤出带 `$180k-230k` 这类区间的岗位 |
| 每天 9 点自动告诉我新机会 | `ai_jobs_schedule`（已挂） | 定时刷新 → 生成摘要 → 直接推送到会话 |

一句话概括能力边界：**它解决"信息从哪来、怎么筛、怎么按时送到你面前"，不解决"帮你递简历"。**

---

## 2. 为什么做

海外 AI 公司几乎全部把招聘挂在 ATS（Applicant Tracking System）上：Greenhouse、Ashby、Lever、Workable、SmartRecruiters。
这些板子都提供**公开 JSON 接口**，不需要登录、不违反 robots，只是：

- 分散在 71 个域名下，公司多了之后人工翻不现实；
- 字段不统一（`updated_at` / `published_at` / `createdAt` 各不相同）；
- 标题里同样叫 "Member of Technical Staff"，有的是核心研究岗，有的是产品经理；
- 每天新增量不大（本机实测：全量刷新 71 个板 20 秒，新增通常个位数），**适合做增量而不是全量重抓**。

所以设计目标被刻意收窄成四条：

1. **只抓公开接口**，不碰登录态、不绕反爬——这是合规底线，也让项目能长期运行；
2. **一次刷新、多次查询**：抓取和查询解耦，查询是纯本地操作（实测 9ms/次）；
3. **每天只推"新的、好的"**：用游标记住上次推到哪，避免重复打扰；
4. **零依赖**：不引入 npm 包，任何 Node ≥22 的环境直接跑，降低插件分发成本。

非目标（明确不做）：简历匹配打分、自动投递、薪资预测、公司评价、非公开岗位。

---

## 3. 架构与数据流

```mermaid
flowchart LR
  A[71 个 ATS 板<br/>Greenhouse/Ashby/Lever/...] -->|公开 JSON| B[适配器层 sources.js<br/>5 种 ATS 归一化]
  B --> C[去重 upsertBoard<br/>sha1(ats+token+id) 作为主键]
  C --> D[分类 classify.js<br/>tier / family / seniority]
  C --> E{新岗位或标题变化?}
  E -->|是| F[补抓 JD 详情<br/>每板上限 60 条]
  E -->|否| G[跳过，省请求]
  F --> H[要求抽取<br/>技能/年限/学历/远程/薪资/签证]
  D --> I[打分 scorePosting<br/>0-100]
  H --> I
  I --> J[(本地索引 store.json<br/>+ jd/ 原文快照)]
  J --> K[查询工具<br/>search / requirements / get / status]
  J --> L[摘要 digest.js<br/>按公司分组 + 每司封顶]
  L --> M{推送方式}
  M -->|schedule 定时| N[每天 09:00 推到会话]
  M -->|agent 主动| O[当次对话里直接给]
```

关键设计：**分类与打分发生在写入时**，查询时只做过滤和排序。这让 1.1 万条数据的检索保持在毫秒级，代价是分类规则升级后需要一次迁移（见 §12.4）。

---

## 4. 八个工具

| 工具 | 作用 | 典型用法 |
| --- | --- | --- |
| `ai_jobs_refresh` | 增量刷新板子 | 每天定时第一件事；也可 `companies:["OpenAI"]` 单刷 |
| `ai_jobs_status` | 索引健康度 | 看有多少在招、多少板报错、上次摘要时间 |
| `ai_jobs_search` | 多条件检索 | 关键词 + 公司 + 分档 + 职级 + 远程 + 地点 + 最低分 |
| `ai_jobs_get` | 读单条岗位全文 | 拿到 JD 原文和抽取出的要求，做深度分析 |
| `ai_jobs_requirements` | 聚合统计 | "这批岗位最常要什么技能/学历/年限" |
| `ai_jobs_digest` | 生成摘要 | 支持 `sinceHours`、`perCompany`、`limit`、`minScore` |
| `ai_jobs_watchlist` | 管理公司板 | 加自己关心的公司（自动探测 ATS 类型与 token） |
| `ai_jobs_schedule` | 定时推送 | create/list/delete，按会话级别挂提醒 |

设计上刻意把「刷新」和「摘要」分开：刷新可能失败（网络），摘要只读本地；两者都能单独重试，不会互相污染。

---

## 5. 抓取层

- 5 个适配器：Greenhouse（含详情二次请求）、Ashby、Lever、Workable、SmartRecruiters。
- 内置种子 71 个板：Greenhouse 33、Ashby 37、Lever 1；Workable / SmartRecruiters 有适配器但暂无种子（留了扩展口）。
- 限速：默认并发 4、单请求超时 25 秒；失败只记录到该板，不中断整体（实测 71 板中 70 成功、1 失败，失败原因是单域名 `fetch failed`）。
- 归一化：统一成 `id / company / ats / token / externalId / title / location / remote / department / employmentType / postedAt / updatedAt / url`。
- 增量：重抓同一岗位时，只有标题变了才重新分类；没变就直接跳过，不浪费算力。
- JD 补抓只针对**新岗位或标题变化**的岗位，每板上限 60 条——这是控制请求量的关键阀门，也让首次全量抓取不会瞬时打爆对方。

---

## 6. 分类与打分

### 6.1 三档

| 档位 | 含义 | 判定方式 |
| --- | --- | --- |
| `core` | 核心 AI 岗 | 15 条正则：research scientist/engineer、applied scientist、machine learning、ml engineer/infra、ai engineer/platform/safety、llm/genai/foundation models、inference/serving/pre-training、alignment/interpretability/red-team/evals、RL、multimodal/vision、nlp、agentic、data scientist、member of technical staff |
| `adjacent` | 相邻技术岗 | 8 条正则：software/backend/platform engineer、sre/security/devops、data engineer/platform、product/program/project manager、solutions/forward deployed、devrel、quant、ux researcher |
| `other` | 其他 | 非技术标题优先判 other（法务/政策/市场/销售/招聘/财务/采购/审计/行政/编辑/制片等），避免 "AI" 一词误伤 |

两条特殊规则：

- **frontier-lab 救援**：公司带 `frontier-lab` 标签且标题含 technical staff / researcher 的，判 core（这些公司职级命名特殊）；
- **管理岗降档**：标题命中 `program|project|product manager/lead`、`technical program manager`、`tpm` 的，即使命中 core 正则也降为 adjacent——**管 AI 的人不是做 AI 的人**。这条是 0.1.1 修的，见 §12.1。

### 6.2 打分

```
score = 分档      核心 55 / 相邻 28 / 其他 8
      + 新鲜度    max(0, 30 − 0.8 × 岗位天数)           // 37.5 天归零；缺发布时间按 30 天算
      + 职级      实习 −8 … 首席 +8（内部有对照表）
      + 技能命中  min(12, 命中数 × 3)                    // 标题 + 抽取出的技能
      + 地点      命中偏好 +8；否则支持远程 +6
      + 明示薪资  +3
      + 签证      JD 明确"不提供签证" −4
```

结果 clamp 到 0–100。为什么这样配：分档决定基本盘（55 分起步），新鲜度是第二权重（刚开的岗比三个月前的更容易进），其余是微调。分数不是"匹配度"，而是**"值不值得你今天看一眼"**。

---

## 7. 要求抽取：能力与真相

抽取器从 JD 正文里抽六类信息（38 条技能正则 + 5 条年限正则 + 学历 + 工作模式 + 薪资 + 签证）。

**必须诚实说明覆盖率**（本机 11,230 条实测）：

| 字段 | 有值的条数 | 覆盖率 | 说明 |
| --- | --- | --- | --- |
| 技能 | 3,783 | 34% | 需要 JD 正文；没补抓到的只有标题 |
| 年限 | 3,170（中位数 5 年） | 28% | JD 里写 "5+ years" 这类才抽得到 |
| 学历 | 94（BS 32 / MS 60 / PhD 2） | 0.8% | 大部分 JD 不写学历，**不能据此说"AI 岗不要博士"** |
| 远程 | 3,727 | 33% | 含 location 里出现 Remote |
| 薪资 | 981 | 8.7% | 只有美国部分州和少数公司强制披露 |
| 签证 | 0 条 negative | 0% | 抽取器在真实语料上未触发，这个 −4 分实际上没生效（见 §15） |

核心档（1,271 条）内部：754 条有 JD 正文、743 条有技能、23 条有学历、65 条是 7 天内新开的。
**结论：技能统计可以看趋势，学历/签证统计现在还不能当结论用。**

---

## 8. 每日推送

两种模式，任选其一：

1. **会话级提醒**（当前已启用）：`ai_jobs_schedule create` → 每天 09:00（America/Los_Angeles）触发一次，内容是"先 refresh，再 digest，把摘要原样贴出来，最后用一句话点名最好的 3 个岗"。
   - 已挂：`schedule-89abafc7-…`，下次 2026-11-01T17:00Z。
2. **插件自动挂**：配置里 `dailyDigest.enabled: true`，插件在第一次 refresh/digest 时自动为当前会话挂提醒（每个会话只挂一次，记在 `armedSessions`）。

推送的"只推新的"靠**游标**：每次摘要成功后把 `lastDigestAt` 推进到当前时间，下次只用 `since(cursor)` 取增量。
好处：不会每天重复推同一批岗；代价：如果某天没跑，那天的岗会在下一次被算作"新的"。

---

## 9. 存储

- 一个 JSON 索引（`store.json`，11.7 MB）+ 一个 JD 原文目录（`jd/`，4,580 个文件、25.9 MB）。
- 主键 `sha1(ats + token + externalId)` 前 16 位，跨刷新稳定。
- 状态只有 `open` / `closed`：某次刷新没再出现的岗位标 closed，不删除（保留历史）。
- 写盘用临时文件 + rename，避免半截文件；`updatedAt` 现在会持久化（0.1.1 修的）。
- 无数据库依赖：换来的是零安装成本，代价是全量加载（实测 120ms/1.1 万条）和全量写盘。

---

## 10. 真实数据快照（2026-11-01 本机）

**规模**

| 指标 | 数值 |
| --- | --- |
| 在招岗位 | 11,230（closed 0） |
| 公司板 | 71（0 个报错） |
| 核心 / 相邻 / 其他 | 1,271 / 2,977 / 6,982 |
| 最早 / 最新发布 | 2019-04-17 / 2026-11-01 |
| 摘要运行次数 | 2 |

**职能分布**：other 4,756、eng 2,656、applied 1,169、infra 1,053、product 675、ml 332、research 314、safety 144、data 131。

**职级分布**：mid 4,667、senior 2,164、manager 1,658、staff 982、lead 540、director 498、principal 316、intern 178、junior 160、newgrad 48、distinguished 19。

**全库技能 Top10**：Agents 2,533、Python 1,129、LLM 889、Alignment 591、Data pipelines 488、SQL 431、Kubernetes 392、Safety/evals 340、Multimodal 328、Fine-tuning 284。
（Agents 命中偏高，因为规则同时匹配 agentic / agents / tool use，看趋势可以，别当精确计数。）

**核心档技能 Top12**：Agents 507、Python 389、LLM 388、Safety/evals 201、Fine-tuning 169、PyTorch 164、Multimodal 131、Data pipelines 117、Alignment 115、RL 113、Kubernetes 106、RAG 98。

**核心档公司 Top12**：OpenAI 151、Anthropic 122、Sierra 74、Perplexity 61、Mistral AI 59、Decagon 48、Databricks 42、Reddit 42、Cohere 39、Pinterest 37、Scale AI 36、Together AI 31。

**全库公司 Top12**：Databricks 904、OpenAI 810、Stripe 745、Anthropic 675、Cloudflare 464、Elastic 407、Datadog 397、Harvey 381、MongoDB 366、Snowflake 366、xAI 308、Roblox 268。

---

## 11. 性能实测

| 操作 | 实测 | 备注 |
| --- | --- | --- |
| 全量刷新 71 个板 | 20.1 秒 | 并发 4、超时 25s；70 成功 / 1 失败；补抓 399 条 JD |
| 读 + 解析索引 | 83 ms | 11.7 MB JSON |
| `JobStore.load()`（含迁移） | 120 ms | 每次会话初始化一次 |
| 单次检索（1.1 万条） | ~9 ms | 5 次共 44 ms |
| 生成 30 条摘要 | 26 ms | 含打分与分组 |

结论：**瓶颈在网络，不在计算。** 所以优化方向永远是"少发请求"（增量 + 只补新岗 JD），而不是"换数据库"。

---

## 12. 0.1.0 → 0.1.1：修了什么、为什么

### 12.1 管理岗被判成核心 AI 岗

- **现象**：摘要里出现 "Staff Program Manager, Human & LLM Data Annotation Operations" 96 分、"Staff Product Manager, Agentic Planning" 90 分，排在真正的工程岗前面。
- **根因**：分类只看标题里的 AI 词（LLM / Agentic），"manager" 没有否决权。
- **修复**：新增 `MANAGERIAL_TITLE` 正则，core 命中后强制降 adjacent（管 AI 的人 ≠ 做 AI 的人）。
- **验证**：真实索引上重跑，核心档 1,271 → 1,209，**62 条管理岗被移出**。

### 12.2 同一岗位多地发布导致摘要重复

- **现象**：Instacart 同一个岗在 "Remote - Canada / Remote - USA" 各出现一次。
- **修复**：摘要按 `公司|标题` 折叠，location 合并成 `a / b` 一行。
- **验证**：smoke 里断言折叠后 `selected === 2` 且文本含合并后的地点串。

### 12.3 `lastUpdatedAt` 永远是 null

- **现象**：`ai_jobs_status` 里 `lastUpdatedAt: null`。
- **根因**：保存时只在写盘 payload 里塞了 `updatedAt`，没写回内存对象，下次读出来就没了。
- **修复**：`save()` 先写 `this.data.updatedAt` 再落盘。

### 12.4 分类规则升级后，老索引还是老档位

- **现象**：这是最隐蔽的一个。分类结果缓存在每条记录里，查询直接读缓存——改规则不迁移，等于白改。
- **根因**：没有分类器版本概念。
- **修复**（三件套）：
  1. `CLASSIFIER_VERSION = 2`，写进 store；
  2. `load()` 时发现版本缺失或落后，就对全部记录重跑 `classifyTitle` 并只覆盖 tier/family/seniority；
  3. smoke 里造一份"v1 老索引"（一条 Program Manager 被错误标 core），加载后断言变成 adjacent、版本变成 2。
- **踩坑**：第一版迁移判断条件写成了 `this.data.classifierVersion === undefined`，但 `emptyStore()` 已经把它初始化成 2，导致迁移永不触发。改成判断**解析出来的原始对象** `parsed.classifierVersion` 才正确。

**这四个 bug 的共同点：没有一个能靠"代码读起来对不对"发现，全是拿真实语料跑出来的。** 这是本项目最重要的一条方法论。

---

## 13. 发布路径复盘

原本的计划是：`npm publish` → 进市场一键装。实际走成了三段：

| 阶段 | 计划 | 实际 | 结果 |
| --- | --- | --- | --- |
| 打包 | npm 发布 | `npm whoami` = ENEEDAUTH；凭据文件被安全策略禁止读取 | 改走 `npm pack` + GitHub Release 资产 `dsh-ai-jobs.tgz`（36 KB，15 个文件） |
| 分发 | 市场按包名安装 | 市场支持"GitHub 条目 + release tarball" | 可行，且不依赖 npm 账号 |
| 上架 | 提交即通过 | 唯一检查项失败：仓库年龄 0.1 天 < 1 天 | 不是内容问题；CI 每 6 小时自动重跑，约 22 小时后自然转绿 |

CI 的事实记录：

- `PR check`（+13m59s）通过：单条目、lint、README 生成、站点构建；
- `Submission gate` 失败，原文：*"repository is 0.1 days old (needs 1) — nothing to do: this check re-runs by itself and should clear in about 22h."*
- PR: https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/11107 （1 文件，+7/−0，MERGEABLE）。

**复盘结论：发布不该只有一条路。** npm 被卡时，release tarball 是等效解；年龄闸门是时间问题，不是返工问题——提前开 PR、让它自己重跑，比等满 24 小时再提交更省事。

另外两个小坑：`git push -f` 被安全策略拦下（要求用 `--force-with-lease`），换成普通 push 新分支即可；`data/companies.json` 是 `{companies:[...]}` 包装对象，用 `ConvertFrom-Json` 直接数 `.Count` 会得到 1，别被这个数字骗了。

---

## 14. 决策记录

| 决策 | 选择 | 为什么 | 代价 |
| --- | --- | --- | --- |
| 分类用规则还是模型 | 规则（38 技能 + 23 分档正则） | 可复现、零成本、可审计、离线可跑；招聘标题的词汇其实很稳定 | 语义理解弱，靠真实语料迭代正则 |
| 存储用 JSON 还是 SQLite | JSON 索引 + JD 文件 | 零依赖是插件分发的硬约束 | 全量加载 120ms、全量写盘 |
| 抓取范围 | 只抓公开 ATS 接口 | 合规、可长期运行 | 覆盖不到只在自己官网挂岗的公司 |
| JD 抓取策略 | 只补新岗/改标题的岗 | 控制请求量，避免打爆对方 | 老岗长期没有正文（754/1,271） |
| 推送去重 | 游标（lastDigestAt） | 不重复打扰 | 漏跑一次就会把增量并入下次 |
| 分类结果存不存 | 存，且带版本号 + 加载时迁移 | 查询快；规则升级不失效 | 每次升级要一次全量重算（120ms，可接受） |
| 教育与合规 | 默认并发 4、超时 25s、不绕验证 | 长期可用优先于抓得快 | 首次全量约 20 秒，不算慢 |
| npm 卡住时 | 先用 release tarball | 不阻塞上架，不硬闯凭据 | 用户需从 GitHub 资产安装 |

---

## 15. 已知局限（诚实清单）

1. **分类只看标题**：JD 里写"要做 LLM 推理"但标题叫 "Software Engineer" 的，会被判 adjacent。要改需要读正文，成本上升。
2. **JD 覆盖率 60%**（核心档 754/1,271）：没抓到正文的岗，技能/年限/学历全空。
3. **学历字段 0.8%**：不能用来回答"AI 岗要不要博士"。
4. **签证负例 0 条**：抽取器在真实语料上从未触发，那条 −4 分等于没生效，需要抽样核验正则。
5. **薪资 8.7%**：只对美国强制披露州有效。
6. **老岗残留**：最早的是 2019 年的岗，说明部分板子不会清理历史条目，`closed` 判定依赖"这次没出现"。
7. **单板失败是静默的**：只在 `perBoard` 里记 error，`status` 汇总里不一定显眼（实测 Harvey 板 `fetch failed` 时，汇总仍是 0 报错）。
8. **只有 3 类 ATS 有种子**：Workable / SmartRecruiters 适配器存在但 0 个板。
9. **提醒是会话级的**：换会话/重装要重挂；插件自挂模式依赖配置项开启。
10. **分类器升级要重启宿主**：运行中的 DSH 进程持有旧模块，0.1.1 的规则要重启桌面端才作用于 1.1 万条存量。
11. **技能命中偏宽**：Agents 2,533 这类数字含 agentic/tool use 等宽匹配，适合看趋势不适合做精确统计。
12. **无简历个性化**：`skillsOfInterest` 是手填词表，不是从你的履历里学出来的。

---

## 16. 路线图

**P0（本周就能做）**
- npm 发布（只需 `npm login` 一次）→ 市场条目从 tarball 切到包名，安装更顺；
- 重启桌面端，让 0.1.1 分类器作用于存量 1.1 万条；
- 等市场闸门自然转绿（无需操作）。

**P1（有价值、成本可控）**
- 分类器 v3：把 `department` 字段、公司标签、JD 首段纳入判定，降低"标题误导"；
- 分批补抓老岗 JD（限速后台跑），把核心档 JD 覆盖率从 60% 提到 90%；
- 签证/薪资抽取的真实样本回归：抓 100 条含 sponsor 字样的 JD，验证正则；
- 周报模式：按公司对比本周新岗与要求变化。

**P2（产品化）**
- 配置化偏好：把技能词表、地点偏好、目标公司搬进 profile 配置行；
- 导出：一次查询直接产出 Markdown/CSV，便于存档或转发；
- 多语言岗位：目前以英文 JD 为主，中文岗的年限/学历表达需要独立正则。

---

## 17. 附录

### 17.1 代码结构

| 文件 | 行数 | 职责 |
| --- | --- | --- |
| `src/sources.js` | 272 | 5 个 ATS 适配器 + 归一化 |
| `src/refresh.js` | 126 | 并发池、增量 diff、JD 补抓 |
| `src/classify.js` | 291 | 分档/职能/职级/要求抽取/打分 |
| `src/store.js` | 417 | 索引读写、迁移、检索、统计 |
| `src/digest.js` | 182 | 摘要生成与文本渲染 |
| `src/tools.js` | 522 | 8 个工具的入参校验与返回 |
| `src/index.js` | 183 | 插件装配、配置归一化、定时挂载 |
| `src/text.js` | 84 | HTML → 纯文本 |

脚本：`smoke`（含 4 组回归）、`live-check`、`probe-companies`、`discover-misses`、`build-seed`。

### 17.2 常用命令

```bash
npm run smoke        # 离线回归：分类、折叠、迁移、摘要
npm run live-check   # 打真实接口验证适配器
npm run seed         # 重建种子公司表
```

### 17.3 指标口径

- **在招**：`status === 'open'`，即最近一次刷新仍在板上出现；
- **核心档**：`tier === 'core'`，标题命中 AI 核心正则且未被管理岗/非技术规则否决；
- **技能覆盖**：`requirements.skills.length > 0`；
- **新鲜度**：`postedAt` 距今天数，缺失按 30 天计。

---

*本文档由实证数据生成：索引 11,230 条、71 个板、实测刷新 20.1s、加载 120ms、检索 9ms、摘要 26ms。*
*版本 v0.1.1 · MIT · https://github.com/justinzyc271828-sys/dsh-ai-jobs*
