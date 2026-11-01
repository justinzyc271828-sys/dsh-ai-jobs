// dsh-ai-jobs — AI hiring radar for DeepSeek Harness.
//
// Mounted by the bundle manifest:
//   package.json -> "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
//   cordis.patch.yml -> insert one row with `name: 'dsh-ai-jobs'`
//
// The plugin is dependency-free (Node built-ins only) because third-party
// bundles resolve outside the app's own package graph. State lives in
//   ${DSH_HOME:-~/.dsh}/ai-jobs/{store.json,jd/,digests/}
// and never touches the host's storage services.
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createToolkit } from './tools.js'

export const name = 'dsh-ai-jobs'
export const inject = ['tools']

const OUTPUT_SCHEMA = { type: 'object', additionalProperties: true }

function envHome() {
  const home = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
  return home
}

function normalizeConfig(raw = {}) {
  const config = raw && typeof raw === 'object' ? raw : {}
  const dailyDigest = config.dailyDigest && typeof config.dailyDigest === 'object' ? config.dailyDigest : {}
  return {
    dataDir: typeof config.dataDir === 'string' && config.dataDir.trim() ? config.dataDir.trim() : join(envHome(), 'ai-jobs'),
    companies: Array.isArray(config.companies) ? config.companies.filter((board) => board?.company && board?.ats && board?.token) : [],
    lang: config.lang === 'en' ? 'en' : 'zh',
    concurrency: Number.isFinite(config.concurrency) ? Math.max(1, Math.min(12, config.concurrency)) : 4,
    timeoutMs: Number.isFinite(config.timeoutMs) ? Math.max(5_000, config.timeoutMs) : 25_000,
    jdMaxChars: Number.isFinite(config.jdMaxChars) ? Math.max(2_000, config.jdMaxChars) : 20_000,
    maxDetailPerBoard: Number.isFinite(config.maxDetailPerBoard) ? Math.max(0, config.maxDetailPerBoard) : 60,
    skillsOfInterest: Array.isArray(config.skillsOfInterest) ? config.skillsOfInterest.map(String) : [],
    preferredLocations: Array.isArray(config.preferredLocations) ? config.preferredLocations.map(String) : [],
    remoteOk: config.remoteOk !== false,
    digestPerCompany: Number.isFinite(config.digestPerCompany) ? Math.max(1, config.digestPerCompany) : 4,
    digestLimit: Number.isFinite(config.digestLimit) ? Math.max(1, config.digestLimit) : 30,
    digestMinScore: Number.isFinite(config.digestMinScore) ? config.digestMinScore : 0,
    timeZone: typeof config.timeZone === 'string' && config.timeZone.trim() ? config.timeZone.trim() : 'Asia/Shanghai',
    dailyDigest: {
      enabled: dailyDigest.enabled === true,
      time: typeof dailyDigest.time === 'string' && /^\d{2}:\d{2}:\d{2}$/.test(dailyDigest.time) ? dailyDigest.time : '09:00:00',
      title: typeof dailyDigest.title === 'string' && dailyDigest.title.trim() ? dailyDigest.title.trim() : 'AI 招聘雷达日报',
    },
  }
}

function loadSeedCompanies() {
  try {
    const raw = readFileSync(new URL('../data/companies.json', import.meta.url), 'utf8')
    const parsed = JSON.parse(raw)
    const list = Array.isArray(parsed) ? parsed : parsed.companies
    return Array.isArray(list)
      ? list.filter((board) => board?.company && board?.ats && board?.token).map((board) => ({
          company: String(board.company),
          ats: String(board.ats),
          token: String(board.token),
          tags: Array.isArray(board.tags) ? board.tags.map(String) : [],
        }))
      : []
  } catch {
    return []
  }
}

const DEFAULT_DIGEST_PROMPT = [
  '先用 ai_jobs_refresh 刷新 AI 招聘看板（只拉增量，失败的公司跳过继续），',
  '再调用 ai_jobs_digest 生成今天的岗位摘要，',
  '然后把摘要原文完整发给我：保留公司分组、岗位标题、链接和分数，不要重写标题，',
  '最后用一句话点出今天最值得看的 3 个岗位和理由。',
].join('')

/** Arm the daily digest once per session, when the config asks for it. */
function makeAutoArm(ctx, toolkit, config) {
  return async function autoArm(exec) {
    if (!config.dailyDigest.enabled) return null
    const sessionId = exec?.agent?.session?.id
    if (!sessionId) return null
    const schedule = typeof ctx.get === 'function' ? ctx.get('schedule') : undefined
    if (!schedule) return null
    const store = await toolkit.ensureStore()
    const armed = Array.isArray(store.data.armedSessions) ? store.data.armedSessions : []
    if (armed.includes(sessionId)) return null
    try {
      const request = {
        title: config.dailyDigest.title,
        prompt: DEFAULT_DIGEST_PROMPT,
        daily: { time: config.dailyDigest.time, time_zone: config.timeZone },
      }
      await schedule.create(sessionId, request, exec?.signal)
      store.data.armedSessions = [...armed, sessionId]
      await store.save()
      return { armed: true, time: config.dailyDigest.time }
    } catch (error) {
      return { armed: false, error: error?.message ?? String(error) }
    }
  }
}

function createScheduleTool(ctx, config) {
  return {
    name: 'ai_jobs_schedule',
    description:
      'Manage the recurring AI-job digest reminder for the current session: create a daily or cron reminder that tells the agent to refresh the board index and post the digest, list existing reminders, or delete one by id.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create', 'list', 'delete'], description: 'Operation to perform.' },
        time: { type: 'string', description: 'Local time HH:MM:SS for a daily reminder (default from config).' },
        timeZone: { type: 'string', description: 'IANA time zone, e.g. Asia/Shanghai (default from config).' },
        cron: { type: 'string', description: 'Five-field cron expression; overrides the daily time when present.' },
        title: { type: 'string', description: 'Reminder title, max 120 chars.' },
        prompt: { type: 'string', description: 'Prompt delivered when the reminder fires.' },
        id: { type: 'string', description: 'Reminder id, required for delete.' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    timeoutMs: 30_000,
    isConcurrencySafe: () => false,
    async execute(args = {}, exec) {
      const schedule = typeof ctx.get === 'function' ? ctx.get('schedule') : undefined
      if (!schedule) return { ok: false, error: 'schedule service is not available in this composition' }
      const sessionId = exec?.agent?.session?.id
      if (!sessionId) return { ok: false, error: 'no session bound to this tool call' }
      const action = args.action ?? 'list'
      if (action === 'list') {
        const schedules = await schedule.list({ sessionId })
        return { ok: true, schedules }
      }
      if (action === 'delete') {
        if (!args.id) return { ok: false, error: 'id is required for delete' }
        const result = await schedule.delete({ id: String(args.id) }, exec?.signal)
        return { ok: true, result }
      }
      const request = {
        title: String(args.title ?? config.dailyDigest.title).slice(0, 120),
        prompt: String(args.prompt ?? DEFAULT_DIGEST_PROMPT),
        ...(args.cron
          ? { cron: { expression: String(args.cron), time_zone: String(args.timeZone ?? config.timeZone) } }
          : { daily: { time: String(args.time ?? config.dailyDigest.time), time_zone: String(args.timeZone ?? config.timeZone) } }),
      }
      const record = await schedule.create(sessionId, request, exec?.signal)
      return { ok: true, created: record }
    },
  }
}

export function apply(ctx, rawConfig = {}) {
  const config = normalizeConfig(rawConfig)
  const seed = loadSeedCompanies()
  const companies = [
    ...new Map(
      [...seed, ...config.companies].map((board) => [`${board.ats}:${board.token}`, { ...board, tags: board.tags ?? [] }]),
    ).values(),
  ]

  const toolkit = createToolkit({ config, seedCompanies: companies, dataDir: config.dataDir })
  const autoArm = makeAutoArm(ctx, toolkit, config)

  for (const tool of toolkit.tools) {
    if (tool.name === 'ai_jobs_refresh' || tool.name === 'ai_jobs_digest') {
      const execute = tool.execute
      tool.execute = async (args, exec) => {
        const armed = await autoArm(exec).catch(() => null)
        const value = await execute(args, exec)
        return armed ? { ...value, dailyDigest: armed } : value
      }
    }
    ctx.tools.register(tool)
  }
  ctx.tools.register(createScheduleTool(ctx, config))
}

export { normalizeConfig, loadSeedCompanies }
