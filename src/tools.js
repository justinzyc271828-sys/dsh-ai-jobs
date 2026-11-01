// Tool definitions. Registered with the raw DSH tool contract:
//   ctx.tools.register({ name, description, parameters, output: { schema, render }, timeoutMs, execute })
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { requirementLine, scorePosting } from './classify.js'
import { buildDigest, postingLine, renderDigestText, renderStatusText } from './digest.js'
import { refreshBoards } from './refresh.js'
import { JobStore, boardKey } from './store.js'
import { truncate } from './text.js'

const OUTPUT_SCHEMA = { type: 'object', additionalProperties: true }
const STRING_ARRAY = { type: 'array', items: { type: 'string' } }

function jsonText(value) {
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2)
}

function renderJson(_args, value) {
  return [{ type: 'text', text: jsonText(value) }]
}

function render(fn) {
  return (args, value) => [{ type: 'text', text: fn(value, args) }]
}

function relativeAge(postedAt, now = Date.now()) {
  if (!postedAt) return '时间未知'
  const ms = now - Date.parse(postedAt)
  if (!Number.isFinite(ms) || ms < 0) return '时间未知'
  const days = Math.floor(ms / 86_400_000)
  if (days <= 0) return '今天'
  if (days < 30) return `${days} 天前`
  return `${Math.floor(days / 30)} 个月前`
}

function compactPosting(posting, score, { now = Date.now(), withRequirements = true } = {}) {
  return {
    id: posting.id,
    company: posting.company,
    title: posting.title,
    tier: posting.tier,
    family: posting.family,
    seniority: posting.seniority,
    location: posting.location,
    remote: posting.remote,
    postedAt: posting.postedAt,
    url: posting.url,
    score,
    ...(withRequirements
      ? { requirements: posting.requirements, comp: posting.comp, age: relativeAge(posting.postedAt, now) }
      : {}),
  }
}

function renderSearch(value) {
  const lines = []
  const filterBits = []
  if (value.filters?.query) filterBits.push(`关键词「${value.filters.query}」`)
  if (value.filters?.company) filterBits.push(`公司 ${value.filters.company}`)
  if (value.filters?.tier && value.filters.tier !== 'core+adjacent') filterBits.push(`分层 ${value.filters.tier}`)
  lines.push(`匹配 **${value.total}** 个岗位，返回前 ${value.returned} 个${filterBits.length ? `（${filterBits.join('，')}）` : ''}。`)
  if (!value.results.length) {
    lines.push('', '没有命中。可以先运行 `ai_jobs_refresh` 建立索引，或放宽 tier / 关键词。')
    return lines.join('\n')
  }
  lines.push('')
  for (const item of value.results) {
    const meta = [item.location, item.age, `${item.score} 分`].filter(Boolean).join(' · ')
    lines.push(`- **${item.company} · ${item.title}** [${item.tier}]`)
    lines.push(`  ${meta}`)
    const req = requirementLine(item)
    if (req) lines.push(`  要求：${req}`)
    if (item.url) lines.push(`  ${item.url}`)
  }
  return lines.join('\n')
}

function renderRequirements(value) {
  const lines = [`样本：**${value.sample}** 个在招 AI 岗位（${value.scope}）。`]
  lines.push('')
  lines.push('## 出现频率最高的技能/主题')
  for (const row of value.skills.slice(0, 15)) {
    lines.push(`- ${row.skill} — ${row.count} 次（${Math.round(row.ratio * 100)}%）`)
  }
  lines.push('')
  lines.push('## 经验与学历门槛')
  lines.push(`- 明确写明年限的岗位：${value.minYears.count} 个，中位数 ${value.minYears.median ?? '—'} 年`)
  const degree = value.degree.map((d) => `${d.label} ${d.count}`).join(' / ')
  if (degree) lines.push(`- 学历要求：${degree}`)
  const modes = value.workMode.map((m) => `${m.label} ${m.count}`).join(' / ')
  if (modes) lines.push(`- 工作形态：${modes}`)
  if (value.comp.count) lines.push(`- 薪资区间样本 ${value.comp.count} 个，中位下限 $${Math.round(value.comp.medianMin / 1000)}k`)
  if (value.topCompanies.length) {
    lines.push('')
    lines.push('## 招聘量最大的公司')
    for (const row of value.topCompanies.slice(0, 8)) lines.push(`- ${row.company} — ${row.count} 个（平均 ${row.avgScore} 分）`)
  }
  if (value.perCompanySkills?.length) {
    lines.push('')
    lines.push('## 各公司共同要求 Top 5')
    for (const row of value.perCompanySkills.slice(0, 10)) {
      lines.push(`- ${row.company}：${row.skills.join('、')}`)
    }
  }
  return lines.join('\n')
}

/**
 * Build the tool set bound to one store directory and config.
 * @param {{config: object, seedCompanies: Array<object>, dataDir: string}} deps
 */
export function createToolkit({ config, seedCompanies, dataDir }) {
  const store = new JobStore(dataDir, { jdMaxChars: config.jdMaxChars })
  let loadPromise = null

  const ensureStore = async () => {
    if (!loadPromise) {
      loadPromise = store.load().catch((error) => {
        loadPromise = null
        throw error
      })
    }
    await loadPromise
    return store
  }

  const profile = () => ({
    skillsOfInterest: config.skillsOfInterest ?? [],
    preferredLocations: config.preferredLocations ?? [],
    remoteOk: config.remoteOk !== false,
  })

  const watchlist = () => (Array.isArray(store.data.watch) ? store.data.watch : [])

  const allBoards = () => {
    const merged = new Map()
    for (const board of [...seedCompanies, ...watchlist()]) {
      if (!board?.company || !board?.ats || !board?.token) continue
      merged.set(boardKey(board.ats, board.token), {
        company: board.company,
        ats: board.ats,
        token: board.token,
        tags: board.tags ?? [],
      })
    }
    return [...merged.values()]
  }

  async function refresh({ companies = null, limit = null, concurrency = null, signal = null } = {}) {
    await ensureStore()
    let boards = allBoards()
    if (Array.isArray(companies) && companies.length) {
      const needles = companies.map((name) => String(name).toLowerCase())
      boards = boards.filter((board) => needles.some((needle) => board.company.toLowerCase() === needle || board.company.toLowerCase().includes(needle)))
    }
    if (limit && boards.length > limit) boards = boards.slice(0, limit)
    const result = await refreshBoards(store, boards, {
      concurrency: concurrency ?? config.concurrency,
      timeoutMs: config.timeoutMs,
      maxDetailPerBoard: config.maxDetailPerBoard,
      signal,
    })
    await store.save()
    return { ...result, stats: store.stats() }
  }

  async function digest(args = {}) {
    await ensureStore()
    const now = Date.now()
    const sinceIso = args.sinceHours
      ? new Date(now - args.sinceHours * 3_600_000).toISOString()
      : store.data.lastDigestAt ?? new Date(now - 7 * 86_400_000).toISOString()
    const candidates = store.since(sinceIso, { now })
    const payload = buildDigest({
      postings: candidates,
      profile: profile(),
      sinceIso,
      perCompany: args.perCompany ?? config.digestPerCompany,
      limit: args.limit ?? config.digestLimit,
      minScore: args.minScore ?? config.digestMinScore,
      now,
    })
    const markdown = renderDigestText(payload, { lang: config.lang })
    let savedPath = null
    if (args.save !== false) {
      const dir = join(dataDir, 'digests')
      await mkdir(dir, { recursive: true })
      const stamp = new Date(now).toISOString().replace(/[:.]/g, '-').slice(0, 16)
      savedPath = join(dir, `${stamp}.md`)
      await writeFile(savedPath, markdown, 'utf8')
    }
    if (args.mark !== false) {
      store.markDigest(new Date(now).toISOString())
      await store.save()
    }
    return {
      generatedAt: payload.generatedAt,
      sinceIso,
      candidates: payload.candidates,
      selected: payload.selected,
      tiers: payload.tiers,
      sections: payload.sections.map((section) => ({ company: section.company, count: section.count })),
      savedPath,
      markdown,
    }
  }

  function requirementAggregate(args = {}) {
    const now = Date.now()
    const tier = args.tier ?? 'core'
    const result = store.search({
      query: args.query ?? '',
      company: args.company ?? null,
      tier,
      seniority: args.seniority ?? null,
      limit: 200,
      sort: 'score',
      profile: profile(),
      now,
      includeClosed: false,
    })
    const sample = result.hits.slice(0, Math.max(1, Math.min(500, args.limit ?? 200)))
    const skillCounts = new Map()
    const yearCounts = []
    const degreeCounts = new Map()
    const modeCounts = new Map()
    const compMins = []
    const companyCounts = new Map()
    const companySkills = new Map()
    const companyScores = new Map()

    for (const posting of sample) {
      const req = posting.requirements ?? {}
      for (const skill of req.skills ?? []) skillCounts.set(skill, (skillCounts.get(skill) ?? 0) + 1)
      if (req.minYears) yearCounts.push(req.minYears)
      if (req.degree) degreeCounts.set(req.degree, (degreeCounts.get(req.degree) ?? 0) + 1)
      if (req.workMode) modeCounts.set(req.workMode, (modeCounts.get(req.workMode) ?? 0) + 1)
      if (req.comp?.min) compMins.push(req.comp.min)
      companyCounts.set(posting.company, (companyCounts.get(posting.company) ?? 0) + 1)
      companyScores.set(posting.company, (companyScores.get(posting.company) ?? 0) + (posting.score ?? 0))
      const skills = companySkills.get(posting.company) ?? new Map()
      for (const skill of (req.skills ?? []).slice(0, 6)) skills.set(skill, (skills.get(skill) ?? 0) + 1)
      companySkills.set(posting.company, skills)
    }

    const median = (values) => {
      if (!values.length) return null
      const sorted = [...values].sort((a, b) => a - b)
      const mid = Math.floor(sorted.length / 2)
      return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2)
    }

    return {
      scope: tier === 'all' ? '全部分层' : tier === 'core+adjacent' ? '核心 + 相邻' : tier === 'core' ? '核心 AI' : '相邻岗位',
      sample: sample.length,
      skills: [...skillCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([skill, count]) => ({ skill, count, ratio: sample.length ? count / sample.length : 0 })),
      minYears: { count: yearCounts.length, median: median(yearCounts) },
      degree: [...degreeCounts.entries()].sort((a, b) => b[1] - a[1]).map(([label, count]) => ({ label, count })),
      workMode: [...modeCounts.entries()].sort((a, b) => b[1] - a[1]).map(([label, count]) => ({ label, count })),
      comp: { count: compMins.length, medianMin: median(compMins) ?? 0 },
      topCompanies: [...companyCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([company, count]) => ({
          company,
          count,
          avgScore: Math.round((companyScores.get(company) ?? 0) / count),
        })),
      perCompanySkills: [...companySkills.entries()]
        .sort((a, b) => (companyCounts.get(b[0]) ?? 0) - (companyCounts.get(a[0]) ?? 0))
        .map(([company, skills]) => ({
          company,
          skills: [...skills.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5)
            .map(([skill]) => skill),
        })),
    }
  }

  const tools = []

  /* ------------------------------- refresh ------------------------------- */

  tools.push({
    name: 'ai_jobs_refresh',
    description:
      'Fetch the AI job boards in the watchlist (Greenhouse / Ashby / Lever / Workable / SmartRecruiters public APIs) and update the local index: adds new postings, marks closed ones, scores them, and stores JD text for requirement mining. Run this before search/digest when the index is empty or stale.',
    parameters: {
      type: 'object',
      properties: {
        companies: { ...STRING_ARRAY, description: 'Optional company name filter; empty means every watched company.' },
        limit: { type: 'integer', description: 'Fetch at most N boards this run (default: all).' },
        concurrency: { type: 'integer', description: 'Parallel board fetches (default from config, 4).' },
      },
      additionalProperties: false,
    },
    output: { schema: OUTPUT_SCHEMA, render: renderJson },
    timeoutMs: 600_000,
    isConcurrencySafe: () => false,
    async execute(args = {}, exec) {
      const result = await refresh({ companies: args.companies, limit: args.limit, concurrency: args.concurrency, signal: exec?.signal })
      return result
    },
  })

  /* -------------------------------- search -------------------------------- */

  tools.push({
    name: 'ai_jobs_search',
    description:
      'Search the indexed AI job postings by keyword, company, tier, seniority, location or recency. Returns scored postings with extracted requirements (skills, years, degree, work mode, compensation) and the original posting URL.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Space-separated keywords, all must match title/company/location/JD head.' },
        company: { type: 'string', description: 'Company name substring (e.g. "anthro", "openai").' },
        tier: { type: 'string', enum: ['core+adjacent', 'core', 'adjacent', 'all'], description: 'Title relevance tier filter.' },
        seniority: { type: 'string', description: 'intern / newgrad / junior / mid / senior / staff / principal / lead / manager / director.' },
        remote: { type: 'boolean', description: 'true = remote-only, false = on-site/hybrid only.' },
        location: { type: 'string', description: 'Location substring (e.g. "San Francisco", "London").' },
        minScore: { type: 'integer', description: 'Minimum relevance score 0-100.' },
        postedWithinDays: { type: 'integer', description: 'Only postings first published within N days.' },
        includeClosed: { type: 'boolean', description: 'Include postings that disappeared from the board.' },
        limit: { type: 'integer', description: 'Max results, default 20, cap 100.' },
        sort: { type: 'string', enum: ['score', 'newest', 'company'], description: 'Result ordering.' },
      },
      additionalProperties: false,
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: render(renderSearch),
    },
    timeoutMs: 60_000,
    isConcurrencySafe: () => true,
    async execute(args = {}) {
      await ensureStore()
      const now = Date.now()
      const result = store.search({
        query: args.query ?? '',
        company: args.company ?? null,
        tier: args.tier ?? 'core+adjacent',
        seniority: args.seniority ?? null,
        remote: typeof args.remote === 'boolean' ? args.remote : null,
        location: args.location ?? null,
        minScore: args.minScore ?? 0,
        postedWithinDays: args.postedWithinDays ?? null,
        includeClosed: args.includeClosed === true,
        limit: Math.max(1, Math.min(100, args.limit ?? 20)),
        sort: args.sort ?? 'score',
        profile: profile(),
        now,
      })
      return {
        total: result.total,
        returned: result.returned,
        filters: {
          query: args.query ?? '',
          company: args.company ?? null,
          tier: args.tier ?? 'core+adjacent',
        },
        results: result.hits.map((posting) => compactPosting(posting, posting.score, { now })),
      }
    },
  })

  /* --------------------------------- get ---------------------------------- */

  tools.push({
    name: 'ai_jobs_get',
    description: 'Read one indexed posting in full: metadata, extracted requirements, and the stored job-description text.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Posting id returned by ai_jobs_search.' } },
      required: ['id'],
      additionalProperties: false,
    },
    output: { schema: OUTPUT_SCHEMA, render: renderJson },
    timeoutMs: 30_000,
    isConcurrencySafe: () => true,
    async execute(args = {}) {
      await ensureStore()
      const record = store.get(String(args.id ?? ''))
      if (!record) return { ok: false, error: `posting ${args.id} not found` }
      const jd = (await store.readJd(record.id)) ?? record.jdHead ?? ''
      return {
        ok: true,
        posting: { ...record, score: scorePosting(record, profile()) },
        jd: truncate(jd, 12_000),
        jdTruncated: jd.length > 12_000,
      }
    },
  })

  /* -------------------------------- digest -------------------------------- */

  tools.push({
    name: 'ai_jobs_digest',
    description:
      'Produce the periodic digest of newly seen AI postings (grouped by company, ranked by relevance, capped per company), save it as Markdown under the plugin data directory, and advance the cursor so the next digest only reports newer postings.',
    parameters: {
      type: 'object',
      properties: {
        sinceHours: { type: 'integer', description: 'Look back N hours instead of using the stored cursor.' },
        perCompany: { type: 'integer', description: 'Max postings per company.' },
        limit: { type: 'integer', description: 'Max postings overall.' },
        minScore: { type: 'integer', description: 'Drop postings scored below this.' },
        save: { type: 'boolean', description: 'Write the Markdown file (default true).' },
        mark: { type: 'boolean', description: 'Advance the digest cursor (default true).' },
      },
      additionalProperties: false,
    },
    output: { schema: OUTPUT_SCHEMA, render: render((value) => value.markdown) },
    timeoutMs: 120_000,
    isConcurrencySafe: () => false,
    async execute(args = {}) {
      return digest(args)
    },
  })

  /* ------------------------------ requirements ---------------------------- */

  tools.push({
    name: 'ai_jobs_requirements',
    description:
      'Aggregate what companies actually ask for in AI roles: most-requested skills, median years of experience, degree and work-mode split, compensation floor, hiring volume per company, and the top requirements for each company.',
    parameters: {
      type: 'object',
      properties: {
        tier: { type: 'string', enum: ['core', 'adjacent', 'core+adjacent', 'all'], description: 'Which postings to aggregate.' },
        company: { type: 'string', description: 'Restrict to one company substring.' },
        query: { type: 'string', description: 'Restrict to postings matching these keywords.' },
        limit: { type: 'integer', description: 'Sample size cap (default 200).' },
      },
      additionalProperties: false,
    },
    output: { schema: OUTPUT_SCHEMA, render: render(renderRequirements) },
    timeoutMs: 60_000,
    isConcurrencySafe: () => true,
    async execute(args = {}) {
      await ensureStore()
      return requirementAggregate(args)
    },
  })

  /* ------------------------------- watchlist ------------------------------ */

  tools.push({
    name: 'ai_jobs_watchlist',
    description:
      'Inspect or edit the company watchlist. Each entry is one public ATS board: company name, ATS type (greenhouse/ashby/lever/workable/smartrecruiters) and the board token used in the public URL.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'add', 'remove'], description: 'Operation to perform.' },
        company: { type: 'string', description: 'Display name for add.' },
        ats: { type: 'string', description: 'ATS type for add.' },
        token: { type: 'string', description: 'Board token for add (the slug in the public careers URL).' },
        tags: { ...STRING_ARRAY, description: 'Optional tags, e.g. frontier-lab / ai-native / ai-user.' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: { schema: OUTPUT_SCHEMA, render: renderJson },
    timeoutMs: 30_000,
    isConcurrencySafe: () => false,
    async execute(args = {}) {
      await ensureStore()
      const action = args.action ?? 'list'
      if (action === 'list') {
        return { ok: true, seed: seedCompanies.length, watch: watchlist() }
      }
      if (action === 'add') {
        const board = { company: String(args.company ?? '').trim(), ats: String(args.ats ?? '').trim(), token: String(args.token ?? '').trim(), tags: args.tags ?? [] }
        if (!board.company || !board.ats || !board.token) return { ok: false, error: 'company, ats and token are required' }
        if (!['greenhouse', 'ashby', 'lever', 'workable', 'smartrecruiters'].includes(board.ats))
          return { ok: false, error: `unsupported ats "${board.ats}"` }
        const key = boardKey(board.ats, board.token)
        const existing = watchlist().filter((item) => boardKey(item.ats, item.token) !== key)
        store.data.watch = [...existing, board]
        store.dirty = true
        await store.save()
        return { ok: true, added: board, watch: store.data.watch }
      }
      if (action === 'remove') {
        const needle = String(args.company ?? '').trim().toLowerCase()
        const token = String(args.token ?? '').trim()
        const before = watchlist()
        store.data.watch = before.filter((item) => {
          if (token && item.token === token) return false
          if (needle && item.company.toLowerCase() === needle) return false
          return true
        })
        const removed = before.length - store.data.watch.length
        store.dirty = true
        await store.save()
        return { ok: true, removed, watch: store.data.watch }
      }
      return { ok: false, error: `unknown action "${action}"` }
    },
  })

  /* -------------------------------- status -------------------------------- */

  tools.push({
    name: 'ai_jobs_status',
    description: 'Show index health: board count, open/closed postings, tier breakdown, top hiring companies, last refresh and last digest time.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: { schema: OUTPUT_SCHEMA, render: renderJson },
    timeoutMs: 30_000,
    isConcurrencySafe: () => true,
    async execute() {
      await ensureStore()
      return { ok: true, ...store.stats(), boardsDetail: Object.values(store.data.boards) }
    },
  })

  return { tools, store, ensureStore, refresh, digest, profile }
}

export { renderStatusText, postingLine }
