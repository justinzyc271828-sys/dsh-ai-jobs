// Durable JSON index + per-posting JD files. No database, no native deps.
import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { CLASSIFIER_VERSION, classifyTitle, extractRequirements, scorePosting } from './classify.js'
import { truncate } from './text.js'

const STORE_VERSION = 1
const JD_HEAD_CHARS = 700

export function postingId(ats, token, externalId) {
  return createHash('sha1').update(`${ats}:${token}:${externalId}`).digest('hex').slice(0, 16)
}

export function boardKey(ats, token) {
  return `${ats}:${token}`
}

function emptyStore() {
  return {
    version: STORE_VERSION,
    classifierVersion: CLASSIFIER_VERSION,
    updatedAt: null,
    boards: {},
    postings: {},
    lastDigestAt: null,
    digestRuns: 0,
  }
}

export class JobStore {
  constructor(dir, options = {}) {
    this.dir = dir
    this.jdDir = join(dir, 'jd')
    this.file = join(dir, 'store.json')
    this.jdMaxChars = options.jdMaxChars ?? 20_000
    this.data = emptyStore()
    this.dirty = false
  }

  async load() {
    await mkdir(this.jdDir, { recursive: true })
    try {
      const raw = await readFile(this.file, 'utf8')
      const parsed = JSON.parse(raw)
      if (parsed && parsed.version === STORE_VERSION) {
        this.data = { ...emptyStore(), ...parsed }
      } else if (parsed && typeof parsed === 'object') {
        // Forward-compatible read: keep recognized containers, drop the rest.
        this.data = { ...emptyStore(), ...parsed, version: STORE_VERSION }
      }
      // Stores written before classifier versioning hold rules from an older release.
      if (parsed.classifierVersion === undefined) this.data.classifierVersion = 0
    } catch (error) {
      if (error.code !== 'ENOENT') {
        // A corrupt store must not take the host down; keep a copy and start over.
        await rename(this.file, `${this.file}.corrupt-${Date.now()}`).catch(() => {})
      }
    }
    this.migrateClassifier()
    return this
  }

  /**
   * Re-run title classification over the whole index when the rules changed.
   * Tiers are cached on each record, so without this an upgrade would keep serving
   * last release's judgement until every posting is refetched.
   * @returns {number} records whose tier/family/seniority changed
   */
  migrateClassifier() {
    if (this.data.classifierVersion === CLASSIFIER_VERSION) return 0
    let changed = 0
    for (const record of Object.values(this.data.postings)) {
      const tags = this.data.boards[boardKey(record.ats, record.token)]?.tags ?? []
      const classified = classifyTitle(record.title, tags)
      if (record.tier !== classified.tier || record.family !== classified.family || record.seniority !== classified.seniority) {
        changed += 1
      }
      Object.assign(record, classified)
    }
    this.data.classifierVersion = CLASSIFIER_VERSION
    this.dirty = true
    return changed
  }

  async save() {
    this.data.updatedAt = new Date().toISOString()
    const payload = JSON.stringify(this.data)
    const tmp = `${this.file}.tmp-${process.pid}`
    await writeFile(tmp, payload, 'utf8')
    await rename(tmp, this.file)
    this.dirty = false
  }

  async writeJd(id, jd) {
    if (!jd) return
    const text = truncate(jd, this.jdMaxChars)
    await writeFile(join(this.jdDir, `${id}.txt`), text, 'utf8').catch(() => {})
  }

  async readJd(id) {
    try {
      return await readFile(join(this.jdDir, `${id}.txt`), 'utf8')
    } catch {
      return null
    }
  }

  get(id) {
    return this.data.postings[id] ?? null
  }

  getBoard(ats, token) {
    return this.data.boards[boardKey(ats, token)] ?? null
  }

  /**
   * Merge one board fetch into the index.
   * @returns {{added: string[], changed: string[], unchanged: number, closed: number, needDetail: string[]}}
   */
  async upsertBoard(board, postings, { now = Date.now(), companyTags = [] } = {}) {
    const key = boardKey(board.ats, board.token)
    const seen = new Set()
    const added = []
    const changed = []
    const needDetail = []
    let unchanged = 0

    for (const raw of postings) {
      const id = postingId(board.ats, board.token, raw.externalId)
      seen.add(id)
      const existing = this.data.postings[id]
      const classified = classifyTitle(raw.title, companyTags)

      if (!existing) {
        const record = {
          id,
          company: board.company,
          ats: board.ats,
          token: board.token,
          externalId: raw.externalId,
          title: raw.title,
          tier: classified.tier,
          family: classified.family,
          seniority: classified.seniority,
          location: raw.location,
          remote: Boolean(raw.remote),
          department: raw.department,
          employmentType: raw.employmentType,
          postedAt: raw.postedAt,
          updatedAt: raw.updatedAt,
          url: raw.url,
          comp: raw.comp ?? null,
          requirements: { skills: [], minYears: null, degree: null, workMode: null },
          jdHead: '',
          jdChars: 0,
          firstSeenAt: new Date(now).toISOString(),
          lastSeenAt: new Date(now).toISOString(),
          status: 'open',
          closedAt: null,
        }
        if (raw.jd) {
          const req = extractRequirements(raw.jd)
          record.requirements = req
          record.comp = record.comp ?? req.comp ?? null
          record.jdHead = truncate(raw.jd, JD_HEAD_CHARS)
          record.jdChars = raw.jd.length
          await this.writeJd(id, raw.jd)
        } else {
          needDetail.push(id)
        }
        this.data.postings[id] = record
        added.push(id)
        continue
      }

      const wasClosed = existing.status !== 'open'
      existing.lastSeenAt = new Date(now).toISOString()
      existing.status = 'open'
      existing.closedAt = null
      if (existing.title !== raw.title) {
        existing.title = raw.title
        Object.assign(existing, classified)
        changed.push(id)
      }
      if (raw.location && raw.location !== existing.location) existing.location = raw.location
      if (raw.url) existing.url = raw.url
      if (raw.postedAt && !existing.postedAt) existing.postedAt = raw.postedAt
      if (raw.updatedAt) existing.updatedAt = raw.updatedAt
      if (raw.comp) existing.comp = raw.comp
      if (raw.jd && !existing.jdChars) {
        const req = extractRequirements(raw.jd)
        existing.requirements = req
        existing.comp = existing.comp ?? req.comp ?? null
        existing.jdHead = truncate(raw.jd, JD_HEAD_CHARS)
        existing.jdChars = raw.jd.length
        await this.writeJd(id, raw.jd)
        changed.push(id)
      } else if (!existing.jdChars && !needDetail.includes(id)) {
        needDetail.push(id)
      }
      if (wasClosed) changed.push(id)
      else if (!changed.includes(id)) unchanged += 1
    }

    let closed = 0
    for (const [id, record] of Object.entries(this.data.postings)) {
      if (record.ats === board.ats && record.token === board.token && !seen.has(id) && record.status === 'open') {
        record.status = 'closed'
        record.closedAt = new Date(now).toISOString()
        closed += 1
      }
    }

    this.data.boards[key] = {
      key,
      company: board.company,
      ats: board.ats,
      token: board.token,
      tags: companyTags,
      lastFetchedAt: new Date(now).toISOString(),
      lastCount: postings.length,
      lastError: null,
    }
    this.dirty = true
    return { added, changed, unchanged, closed, needDetail }
  }

  /** Attach a JD fetched after the list call (Greenhouse detail endpoint). */
  async applyDetail(id, { jd, updatedAt } = {}) {
    const record = this.data.postings[id]
    if (!record || !jd) return false
    const req = extractRequirements(jd)
    record.requirements = req
    record.comp = record.comp ?? req.comp ?? null
    record.jdHead = truncate(jd, JD_HEAD_CHARS)
    record.jdChars = jd.length
    if (updatedAt) record.updatedAt = updatedAt
    await this.writeJd(id, jd)
    this.dirty = true
    return true
  }

  recordBoardError(board, message) {
    const key = boardKey(board.ats, board.token)
    const previous = this.data.boards[key] ?? {
      key,
      company: board.company,
      ats: board.ats,
      token: board.token,
      tags: [],
      lastCount: 0,
    }
    this.data.boards[key] = {
      ...previous,
      lastError: String(message ?? 'unknown error').slice(0, 300),
      lastErrorAt: new Date().toISOString(),
    }
    this.dirty = true
  }

  removeBoard(ats, token) {
    const key = boardKey(ats, token)
    delete this.data.boards[key]
    for (const [id, record] of Object.entries(this.data.postings)) {
      if (record.ats === ats && record.token === token) delete this.data.postings[id]
    }
    this.dirty = true
  }

  /** Remove postings that stayed closed for a while, plus their JD files. */
  async prune({ keepClosedDays = 90, now = Date.now() } = {}) {
    let removed = 0
    const cutoff = now - keepClosedDays * 86_400_000
    for (const [id, record] of Object.entries(this.data.postings)) {
      if (record.status !== 'closed') continue
      const closedAt = record.closedAt ? Date.parse(record.closedAt) : 0
      if (closedAt && closedAt > cutoff) continue
      delete this.data.postings[id]
      await unlink(join(this.jdDir, `${id}.txt`)).catch(() => {})
      removed += 1
    }
    if (removed) this.dirty = true
    return removed
  }

  rescoreAll(profile) {
    for (const record of Object.values(this.data.postings)) {
      record.score = scorePosting(record, profile)
    }
    this.dirty = true
  }

  /**
   * Search the index.
   * @param {object} filters
   */
  search(filters = {}) {
    const {
      query = '',
      company = null,
      ats = null,
      tier = 'core+adjacent',
      seniority = null,
      remote = null,
      location = null,
      minScore = 0,
      postedWithinDays = null,
      includeClosed = false,
      limit = 30,
      sort = 'score',
      profile = {},
      now = Date.now(),
    } = filters

    const terms = String(query)
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean)
    const tiers = tier === 'all' ? null : tier === 'core' ? ['core'] : tier === 'adjacent' ? ['adjacent'] : ['core', 'adjacent']
    const companyNeedle = company ? String(company).toLowerCase() : null
    const locationNeedle = location ? String(location).toLowerCase() : null
    const ageCutoff = postedWithinDays ? now - postedWithinDays * 86_400_000 : null

    const hits = []
    for (const record of Object.values(this.data.postings)) {
      if (!includeClosed && record.status !== 'open') continue
      if (tiers && !tiers.includes(record.tier)) continue
      if (seniority && record.seniority !== seniority) continue
      if (remote === true && !record.remote) continue
      if (remote === false && record.remote) continue
      if (companyNeedle && !record.company.toLowerCase().includes(companyNeedle)) continue
      if (ats && record.ats !== ats) continue
      if (locationNeedle && !String(record.location ?? '').toLowerCase().includes(locationNeedle)) continue
      if (ageCutoff && record.postedAt && Date.parse(record.postedAt) < ageCutoff) continue
      if (terms.length) {
        const hay = `${record.title} ${record.company} ${record.location ?? ''} ${(record.requirements?.skills ?? []).join(' ')} ${record.jdHead ?? ''}`.toLowerCase()
        if (!terms.every((term) => hay.includes(term))) continue
      }
      const score = scorePosting(record, { ...profile, now })
      if (score < minScore) continue
      hits.push({ record, score })
    }

    if (sort === 'newest') {
      hits.sort((a, b) => (Date.parse(b.record.postedAt ?? 0) || 0) - (Date.parse(a.record.postedAt ?? 0) || 0))
    } else if (sort === 'company') {
      hits.sort((a, b) => a.record.company.localeCompare(b.record.company) || b.score - a.score)
    } else {
      hits.sort((a, b) => b.score - a.score || (Date.parse(b.record.postedAt ?? 0) || 0) - (Date.parse(a.record.postedAt ?? 0) || 0))
    }

    const total = hits.length
    const sliced = hits.slice(0, Math.max(1, Math.min(200, limit)))
    return {
      total,
      returned: sliced.length,
      hits: sliced.map(({ record, score }) => ({ ...record, score })),
    }
  }

  /** Postings that appeared after the last digest run (or the given cursor). */
  since(cursorIso, { now = Date.now() } = {}) {
    const cursor = cursorIso ? Date.parse(cursorIso) : 0
    return Object.values(this.data.postings).filter((record) => {
      if (record.status !== 'open') return false
      const first = Date.parse(record.firstSeenAt ?? '')
      return Number.isFinite(first) ? first > cursor : true
    })
  }

  markDigest(at = new Date().toISOString()) {
    this.data.lastDigestAt = at
    this.data.digestRuns = (this.data.digestRuns ?? 0) + 1
    this.dirty = true
    return at
  }

  stats({ now = Date.now() } = {}) {
    const byTier = { core: 0, adjacent: 0, other: 0 }
    const byCompany = new Map()
    let open = 0
    let closed = 0
    let newest = 0
    for (const record of Object.values(this.data.postings)) {
      if (record.status === 'open') {
        open += 1
        byTier[record.tier] = (byTier[record.tier] ?? 0) + 1
        byCompany.set(record.company, (byCompany.get(record.company) ?? 0) + 1)
        const posted = record.postedAt ? Date.parse(record.postedAt) : 0
        if (posted > newest) newest = posted
      } else {
        closed += 1
      }
    }
    const topCompanies = [...byCompany.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([company, count]) => ({ company, count }))
    const boards = Object.values(this.data.boards)
    return {
      total: Object.keys(this.data.postings).length,
      open,
      closed,
      byTier,
      topCompanies,
      boards: boards.length,
      boardsWithErrors: boards.filter((board) => board.lastError).length,
      newestPostedAt: newest ? new Date(newest).toISOString() : null,
      lastUpdatedAt: this.data.updatedAt,
      lastDigestAt: this.data.lastDigestAt,
      digestRuns: this.data.digestRuns ?? 0,
      newSinceDigest: this.since(this.data.lastDigestAt, { now }).length,
      checkedAt: new Date(now).toISOString(),
    }
  }
}
