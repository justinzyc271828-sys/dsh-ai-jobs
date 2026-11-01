// Live multi-board check against the real APIs (not part of CI): indexes a few
// large boards end to end and prints what the digest would say.
// Run: node scripts/live-check.mjs [company ...]
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalizeConfig, loadSeedCompanies } from '../src/index.js'
import { createToolkit } from '../src/tools.js'

const requested = process.argv.slice(2)
const seed = loadSeedCompanies()
const picked = requested.length
  ? seed.filter((board) => requested.some((name) => board.company.toLowerCase().includes(name.toLowerCase())))
  : seed.slice(0, 5)

const config = normalizeConfig({ concurrency: 4, digestPerCompany: 3, digestLimit: 12 })
const dir = await mkdtemp(join(tmpdir(), 'dsh-ai-jobs-live-'))
const toolkit = createToolkit({ config: { ...config, dataDir: dir }, seedCompanies: picked, dataDir: dir })

try {
  const started = Date.now()
  const refreshed = await toolkit.refresh()
  console.log(
    `boards ${refreshed.boardsOk}/${refreshed.boards} · postings ${refreshed.postings} · added ${refreshed.added} · details ${refreshed.details} · ${Date.now() - started}ms`,
  )
  for (const board of refreshed.perBoard.filter(Boolean)) {
    console.log(`  ${board.ok ? 'OK  ' : 'FAIL'} ${board.company.padEnd(20)} ${String(board.fetched ?? '').padStart(5)} ${board.error ?? ''}`)
  }
  const stats = toolkit.store.stats()
  console.log(`\nindex: open=${stats.open} core=${stats.byTier.core} adjacent=${stats.byTier.adjacent} other=${stats.byTier.other}`)
  const aggregate = toolkit.tools.find((tool) => tool.name === 'ai_jobs_requirements')
  const value = await aggregate.execute({ tier: 'core', limit: 150 })
  console.log(`\ncore sample ${value.sample} · median years ${value.minYears.median} · top skills ${value.skills.slice(0, 8).map((s) => `${s.skill}(${s.count})`).join(' ')}`)
  const digest = await toolkit.digest({ save: false, mark: false })
  console.log(`\ndigest: ${digest.selected}/${digest.candidates} selected`)
  console.log(digest.markdown.split('\n').slice(0, 22).join('\n'))
} finally {
  await rm(dir, { recursive: true, force: true }).catch(() => {})
}
