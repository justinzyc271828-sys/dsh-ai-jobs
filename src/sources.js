// ATS adapters. Each adapter turns one public job-board endpoint into the
// normalized posting shape the rest of the plugin works with.
//
// Supported boards (all public, no key, no login):
//   greenhouse   https://boards-api.greenhouse.io/v1/boards/{token}/jobs
//   ashby        https://api.ashbyhq.com/posting-api/job-board/{token}
//   lever        https://api.lever.co/v0/postings/{token}?mode=json
//   workable     https://apply.workable.com/api/v1/widget/accounts/{token}
//   smartrecruiters https://api.smartrecruiters.com/v1/companies/{token}/postings
import { htmlToText, oneLine, truncate } from './text.js'

export const USER_AGENT = 'dsh-ai-jobs/0.1 (+https://github.com/justzyc/dsh-ai-jobs)'
const DEFAULT_TIMEOUT_MS = 25_000

export const SUPPORTED_ATS = ['greenhouse', 'ashby', 'lever', 'workable', 'smartrecruiters']

export function boardUrl(ats, token) {
  switch (ats) {
    case 'greenhouse':
      return `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(token)}/jobs?content=false`
    case 'greenhouse-job':
      return `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(token)}/jobs/${encodeURIComponent(arguments[2])}`
    case 'ashby':
      return `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(token)}?includeCompensation=true`
    case 'lever':
      return `https://api.lever.co/v0/postings/${encodeURIComponent(token)}?mode=json`
    case 'workable':
      return `https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(token)}?details=true`
    case 'smartrecruiters':
      return `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(token)}/postings?limit=100`
    default:
      throw new Error(`unsupported ATS "${ats}" (supported: ${SUPPORTED_ATS.join(', ')})`)
  }
}

async function httpJson(url, { timeoutMs = DEFAULT_TIMEOUT_MS, signal, headers = {} } = {}) {
  const controller = new AbortController()
  const onAbort = () => controller.abort(signal?.reason)
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason)
    else signal.addEventListener('abort', onAbort, { once: true })
  }
  const timer = setTimeout(() => controller.abort(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs)
  try {
    const res = await fetch(url, {
      headers: { accept: 'application/json', 'user-agent': USER_AGENT, ...headers },
      signal: controller.signal,
      redirect: 'follow',
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw Object.assign(new Error(`HTTP ${res.status} ${res.statusText} for ${url}`), {
        status: res.status,
        body: truncate(body, 300),
      })
    }
    return await res.json()
  } finally {
    clearTimeout(timer)
    if (signal) signal.removeEventListener('abort', onAbort)
  }
}

function asIso(value) {
  if (value === undefined || value === null || value === '') return null
  if (typeof value === 'number') {
    const ms = value < 1e12 ? value * 1000 : value
    const d = new Date(ms)
    return Number.isNaN(d.getTime()) ? null : d.toISOString()
  }
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

function remoteFromText(location, workplaceType) {
  const hay = `${location ?? ''} ${workplaceType ?? ''}`.toLowerCase()
  if (/\b(remote|anywhere|distributed)\b/.test(hay)) return true
  if (/\bhybrid\b/.test(hay)) return false
  return false
}

function compSummary(raw) {
  const text = oneLine(raw)
  return text && text.length <= 200 ? text : null
}

/* ------------------------------- greenhouse ------------------------------- */

function greenhousePosting(job, token, company) {
  const location = oneLine(job.location?.name ?? job.location ?? '')
  return {
    externalId: String(job.id ?? job.internal_job_id ?? ''),
    title: oneLine(job.title),
    location,
    locations: [location].filter(Boolean),
    remote: remoteFromText(location),
    department: oneLine(job.departments?.[0]?.name ?? job.department ?? ''),
    employmentType: '',
    postedAt: asIso(job.first_published ?? job.updated_at ?? job.created_at),
    updatedAt: asIso(job.updated_at ?? job.first_published ?? job.created_at),
    url: job.absolute_url ?? `https://boards.greenhouse.io/${token}/jobs/${job.id}`,
    jd: htmlToText(job.content),
    comp: null,
  }
}

async function fetchGreenhouse(board, opts) {
  const json = await httpJson(boardUrl('greenhouse', board.token), opts)
  const jobs = Array.isArray(json?.jobs) ? json.jobs : []
  return jobs
    .filter((job) => job && job.title)
    .map((job) => greenhousePosting(job, board.token, board.company))
}

/** Fetch the JD text for one Greenhouse posting (list responses omit it). */
export async function fetchGreenhouseDetail(board, externalId, opts = {}) {
  const url = boardUrl('greenhouse-job', board.token, externalId)
  const job = await httpJson(url, opts)
  return {
    jd: htmlToText(job?.content),
    postedAt: asIso(job?.first_published ?? job?.updated_at),
    updatedAt: asIso(job?.updated_at),
  }
}

/* ---------------------------------- ashby --------------------------------- */

function ashbyPosting(job, token, company) {
  const primary = oneLine(job.location ?? '')
  const secondary = Array.isArray(job.secondaryLocations)
    ? job.secondaryLocations.map((loc) => oneLine(loc?.location ?? loc)).filter(Boolean)
    : []
  const locations = [primary, ...secondary].filter(Boolean)
  const workplace = oneLine(job.workplaceType ?? '')
  return {
    externalId: String(job.id ?? ''),
    title: oneLine(job.title),
    location: locations.join(' / '),
    locations,
    remote: job.isRemote === true || remoteFromText(primary, workplace),
    department: oneLine(job.department ?? job.team ?? ''),
    employmentType: oneLine(job.employmentType ?? ''),
    postedAt: asIso(job.publishedAt ?? job.publishedDate),
    updatedAt: asIso(job.updatedAt ?? job.publishedAt),
    url: job.jobUrl ?? job.applyUrl ?? `https://jobs.ashbyhq.com/${token}/${job.id}`,
    jd: htmlToText(job.descriptionHtml ?? job.descriptionPlain ?? ''),
    comp: compSummary(job.compensation?.compensationTierSummary ?? job.compensation?.scrapeableCompensationSalarySummary),
  }
}

async function fetchAshby(board, opts) {
  const json = await httpJson(boardUrl('ashby', board.token), opts)
  const jobs = Array.isArray(json?.jobs) ? json.jobs : []
  return jobs
    .filter((job) => job && job.title && job.isListed !== false)
    .map((job) => ashbyPosting(job, board.token, board.company))
}

/* ---------------------------------- lever --------------------------------- */

function leverPosting(job, token, company) {
  const location = oneLine(job.categories?.location ?? '')
  const lists = Array.isArray(job.lists)
    ? job.lists.map((list) => `${oneLine(list?.text)}\n${htmlToText(list?.content)}`).join('\n')
    : ''
  const jd = [htmlToText(job.descriptionPlain ?? job.description ?? ''), lists, htmlToText(job.additionalPlain ?? job.additional ?? '')]
    .filter(Boolean)
    .join('\n\n')
  return {
    externalId: String(job.id ?? ''),
    title: oneLine(job.text),
    location,
    locations: [location].filter(Boolean),
    remote: remoteFromText(location, job.workplaceType),
    department: oneLine(job.categories?.team ?? ''),
    employmentType: oneLine(job.categories?.commitment ?? ''),
    postedAt: asIso(job.createdAt),
    updatedAt: asIso(job.updatedAt ?? job.createdAt),
    url: job.hostedUrl ?? `https://jobs.lever.co/${token}/${job.id}`,
    jd,
    comp: null,
  }
}

async function fetchLever(board, opts) {
  const json = await httpJson(boardUrl('lever', board.token), opts)
  const jobs = Array.isArray(json) ? json : Array.isArray(json?.postings) ? json.postings : []
  return jobs.filter((job) => job && job.text).map((job) => leverPosting(job, board.token, board.company))
}

/* --------------------------------- workable ------------------------------- */

async function fetchWorkable(board, opts) {
  const json = await httpJson(boardUrl('workable', board.token), opts)
  const jobs = Array.isArray(json?.jobs) ? json.jobs : []
  return jobs
    .filter((job) => job && job.title)
    .map((job) => {
      const loc = job.location ?? {}
      const location = oneLine([loc.city, loc.region, loc.country].filter(Boolean).join(', '))
      return {
        externalId: String(job.shortcode ?? job.id ?? ''),
        title: oneLine(job.title),
        location,
        locations: [location].filter(Boolean),
        remote: Boolean(job.telecommuting) || remoteFromText(location),
        department: oneLine(job.department ?? ''),
        employmentType: oneLine(job.employment_type ?? ''),
        postedAt: asIso(job.published_on ?? job.created_at),
        updatedAt: asIso(job.created_at),
        url: job.url ?? job.application_url ?? `https://apply.workable.com/${board.token}/j/${job.shortcode}/`,
        jd: htmlToText(job.description ?? ''),
        comp: null,
      }
    })
}

/* ------------------------------ smartrecruiters --------------------------- */

async function fetchSmartRecruiters(board, opts) {
  const json = await httpJson(boardUrl('smartrecruiters', board.token), opts)
  const jobs = Array.isArray(json?.content) ? json.content : []
  return jobs
    .filter((job) => job && job.name)
    .map((job) => {
      const loc = job.location ?? {}
      const location = oneLine([loc.city, loc.region, loc.country].filter(Boolean).join(', '))
      return {
        externalId: String(job.id ?? ''),
        title: oneLine(job.name),
        location,
        locations: [location].filter(Boolean),
        remote: remoteFromText(location),
        department: oneLine(job.department?.label ?? ''),
        employmentType: oneLine(job.typeOfEmployment?.label ?? ''),
        postedAt: asIso(job.releasedDate),
        updatedAt: asIso(job.releasedDate),
        url: job.ref ?? `https://jobs.smartrecruiters.com/${board.token}/${job.id}`,
        jd: '',
        comp: null,
      }
    })
}

const FETCHERS = {
  greenhouse: fetchGreenhouse,
  ashby: fetchAshby,
  lever: fetchLever,
  workable: fetchWorkable,
  smartrecruiters: fetchSmartRecruiters,
}

/**
 * Fetch one board and return normalized postings.
 * @param {{company: string, ats: string, token: string}} board
 * @param {{timeoutMs?: number, signal?: AbortSignal}} [opts]
 */
export async function fetchBoard(board, opts = {}) {
  const fetcher = FETCHERS[board.ats]
  if (!fetcher) throw new Error(`unsupported ATS "${board.ats}"`)
  const startedAt = Date.now()
  const postings = await fetcher(board, opts)
  return {
    company: board.company,
    ats: board.ats,
    token: board.token,
    postings,
    elapsedMs: Date.now() - startedAt,
  }
}

export { httpJson }
