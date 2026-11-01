// Digest assembly and text rendering (Chinese by default, English optional).
import { requirementLine, scorePosting } from './classify.js'

function relativeAge(postedAt, now = Date.now()) {
  if (!postedAt) return ''
  const ms = now - Date.parse(postedAt)
  if (!Number.isFinite(ms) || ms < 0) return ''
  const days = Math.floor(ms / 86_400_000)
  if (days <= 0) return '今天'
  if (days === 1) return '1 天前'
  if (days < 30) return `${days} 天前`
  if (days < 365) return `${Math.floor(days / 30)} 个月前`
  return `${Math.floor(days / 365)} 年前`
}

function fmtMoney(comp) {
  if (!comp?.min) return ''
  const k = (n) => `$${Math.round(n / 1000)}k`
  return comp.min === comp.max ? k(comp.min) : `${k(comp.min)}–${k(comp.max)}`
}

export function postingLine(posting, { now = Date.now(), lang = 'zh' } = {}) {
  const score = posting.score ?? scorePosting(posting, { now })
  const bits = []
  if (posting.location) bits.push(posting.location)
  const age = relativeAge(posting.postedAt, now)
  if (age) bits.push(lang === 'en' ? age : age)
  bits.push(`${score} 分`)
  const req = requirementLine(posting)
  const head = `- **${posting.title}** · ${bits.join(' · ')}`
  const lines = [head]
  if (req) lines.push(`  ${req}`)
  if (posting.url) lines.push(`  ${posting.url}`)
  return lines.join('\n')
}

/**
 * Build a digest payload from postings that appeared after a cursor.
 * @param {object} options
 * @param {Array<object>} options.postings candidate records
 * @param {object} [options.profile] scoring profile
 * @param {string|null} [options.sinceIso] cursor (exclusive)
 * @param {number} [options.perCompany] max postings per company
 * @param {number} [options.limit] max total postings
 * @param {number} [options.minScore] drop anything below this
 */
export function buildDigest({ postings, profile = {}, sinceIso = null, perCompany = 4, limit = 30, minScore = 0, now = Date.now() } = {}) {
  const scored = postings
    .map((posting) => ({ posting, score: scorePosting(posting, { ...profile, now }) }))
    .filter(({ score }) => score >= minScore)
    .sort((a, b) => b.score - a.score)

  const perCompanyCount = new Map()
  const picked = []
  for (const entry of scored) {
    const company = entry.posting.company
    const used = perCompanyCount.get(company) ?? 0
    if (used >= perCompany) continue
    perCompanyCount.set(company, used + 1)
    picked.push(entry)
    if (picked.length >= limit) break
  }

  const byCompany = new Map()
  for (const entry of picked) {
    const list = byCompany.get(entry.posting.company) ?? []
    list.push({ ...entry.posting, score: entry.score })
    byCompany.set(entry.posting.company, list)
  }

  const sections = [...byCompany.entries()]
    .map(([company, list]) => ({
      company,
      ats: list[0]?.ats ?? '',
      count: list.length,
      postings: list.sort((a, b) => b.score - a.score),
    }))
    .sort((a, b) => (b.postings[0]?.score ?? 0) - (a.postings[0]?.score ?? 0))

  const tiers = { core: 0, adjacent: 0, other: 0 }
  for (const entry of picked) tiers[entry.posting.tier] = (tiers[entry.posting.tier] ?? 0) + 1

  return {
    generatedAt: new Date(now).toISOString(),
    sinceIso,
    candidates: postings.length,
    selected: picked.length,
    tiers,
    sections,
    minScore,
    perCompany,
  }
}

const TIER_LABEL_ZH = { core: '核心 AI', adjacent: '相邻', other: '其他' }

export function renderDigestText(digest, { lang = 'zh', siteUrl = null } = {}) {
  const { sections, sinceIso, candidates, selected, tiers, generatedAt } = digest
  const date = (generatedAt ?? new Date().toISOString()).slice(0, 10)
  const lines = []
  if (lang === 'en') {
    lines.push(`# AI hiring radar · ${date}`)
    lines.push('')
    lines.push(
      sinceIso
        ? `Since ${sinceIso.slice(0, 16).replace('T', ' ')}: ${candidates} candidate postings, ${selected} selected (${tiers.core} core AI, ${tiers.adjacent} adjacent).`
        : `${candidates} candidate postings, ${selected} selected (${tiers.core} core AI, ${tiers.adjacent} adjacent).`,
    )
  } else {
    lines.push(`# AI 招聘雷达 · ${date}`)
    lines.push('')
    lines.push(
      sinceIso
        ? `自 ${sinceIso.slice(0, 16).replace('T', ' ')} 以来：候选 ${candidates} 个岗位，入选 ${selected} 个（核心 AI ${tiers.core} / 相邻 ${tiers.adjacent}）。`
        : `候选 ${candidates} 个岗位，入选 ${selected} 个（核心 AI ${tiers.core} / 相邻 ${tiers.adjacent}）。`,
    )
  }
  if (!sections.length) {
    lines.push('')
    lines.push(lang === 'en' ? 'Nothing new matched the current filters.' : '本轮没有符合当前筛选条件的新岗位。')
    return lines.join('\n')
  }
  const now = Date.parse(generatedAt ?? '') || Date.now()
  for (const section of sections) {
    lines.push('')
    lines.push(`## ${section.company}${lang === 'en' ? '' : `（${section.count}）`}`)
    for (const posting of section.postings) {
      lines.push(postingLine(posting, { now, lang }))
    }
  }
  lines.push('')
  lines.push(
    lang === 'en'
      ? `Filters in effect: top ${digest.perCompany} per company, minimum score ${digest.minScore}.`
      : `筛选口径：每家公司最多 ${digest.perCompany} 个，最低分 ${digest.minScore}。`,
  )
  if (siteUrl) lines.push('', `Data: ${siteUrl}`)
  return lines.join('\n')
}

/** Compact one-screen status text for the digest_status tool. */
export function renderStatusText(stats, { lang = 'zh' } = {}) {
  const tierText = `core ${stats.byTier.core} / adjacent ${stats.byTier.adjacent} / other ${stats.byTier.other}`
  if (lang === 'en') {
    return [
      `Boards: ${stats.boards} (errors ${stats.boardsWithErrors})`,
      `Postings: ${stats.open} open / ${stats.total} indexed`,
      `Tiers: ${tierText}`,
      `New since last digest: ${stats.newSinceDigest}`,
      `Last index update: ${stats.lastUpdatedAt ?? 'never'}`,
      `Last digest: ${stats.lastDigestAt ?? 'never'} (${stats.digestRuns} runs)`,
    ].join('\n')
  }
  return [
    `公司看板：${stats.boards} 个（异常 ${stats.boardsWithErrors}）`,
    `岗位：在招 ${stats.open} / 共索引 ${stats.total}`,
    `分层：${tierText}`,
    `距上次推送新增：${stats.newSinceDigest}`,
    `索引更新时间：${stats.lastUpdatedAt ?? '从未'}`,
    `上次推送：${stats.lastDigestAt ?? '从未'}（共 ${stats.digestRuns} 次）`,
  ].join('\n')
}
