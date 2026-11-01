// End-to-end smoke test: validate tool schemas against the DSH subset, then
// drive refresh -> search -> requirements -> digest on a throwaway data dir.
// Run: node scripts/smoke.mjs
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalizeConfig } from '../src/index.js'
import { createToolkit } from '../src/tools.js'
import { classifyTitle } from '../src/classify.js'
import { JobStore } from '../src/store.js'
import { buildDigest, renderDigestText } from '../src/digest.js'

const ALLOWED_KEYS = new Set([
  'type',
  'properties',
  'additionalProperties',
  'items',
  'enum',
  'const',
  'oneOf',
  'required',
  'description',
  'title',
  'default',
  'examples',
  'deprecated',
])

function walkSchema(node, path, problems) {
  if (!node || typeof node !== 'object') {
    problems.push(`${path}: not an object`)
    return
  }
  for (const key of Object.keys(node)) {
    if (!ALLOWED_KEYS.has(key)) problems.push(`${path}.${key}: unsupported schema key`)
  }
  if (node.type === 'object') {
    if (typeof node.additionalProperties !== 'boolean')
      problems.push(`${path}.additionalProperties: must be explicit true/false`)
    for (const [key, child] of Object.entries(node.properties ?? {})) {
      walkSchema(child, `${path}.properties.${key}`, problems)
    }
  } else if (node.type === 'array') {
    if (node.items) walkSchema(node.items, `${path}.items`, problems)
  } else if (!['string', 'number', 'integer', 'boolean', 'null', 'json'].includes(node.type)) {
    problems.push(`${path}.type: unsupported type ${JSON.stringify(node.type)}`)
  }
  if (node.oneOf) {
    problems.push(`${path}.oneOf: not used by this plugin (keep the surface flat)`)
  }
}

function checkTools(tools) {
  const problems = []
  for (const tool of tools) {
    if (!tool.name) problems.push('tool without name')
    if (!tool.description) problems.push(`${tool.name}: missing description`)
    if (typeof tool.timeoutMs !== 'number' || !Number.isFinite(tool.timeoutMs) || tool.timeoutMs <= 0)
      problems.push(`${tool.name}: bad timeoutMs`)
    if (!tool.output || typeof tool.output.render !== 'function') problems.push(`${tool.name}: output.render missing`)
    walkSchema(tool.output?.schema, `${tool.name}.output.schema`, problems)
    walkSchema(tool.parameters, `${tool.name}.parameters`, problems)
    problems.push(...[])
  }
  const names = tools.map((tool) => tool.name)
  if (new Set(names).size !== names.length) problems.push('duplicate tool names')
  return problems
}

const config = normalizeConfig({
  concurrency: 3,
  digestPerCompany: 2,
  digestLimit: 6,
  preferredLocations: ['San Francisco', 'Remote'],
  skillsOfInterest: ['LLM', 'inference', 'agents'],
})
const seed = [
  { company: 'Chroma', ats: 'ashby', token: 'trychroma', tags: ['ai-native'] },
  { company: 'Vectara', ats: 'greenhouse', token: 'vectara', tags: ['ai-native'] },
]

const dir = await mkdtemp(join(tmpdir(), 'dsh-ai-jobs-smoke-'))
const toolkit = createToolkit({ config: { ...config, dataDir: dir }, seedCompanies: seed, dataDir: dir })

let failures = 0
const ok = (label, condition, detail = '') => {
  if (condition) {
    console.log(`PASS ${label}${detail ? ` — ${detail}` : ''}`)
  } else {
    failures += 1
    console.log(`FAIL ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

try {
  console.log('--- schema contract ---')
  const problems = checkTools(toolkit.tools)
  ok('tool schemas', problems.length === 0, problems.slice(0, 8).join(' | ') || `${toolkit.tools.length} tools`)
  console.log(`tools: ${toolkit.tools.map((tool) => tool.name).join(', ')}`)

  console.log('\n--- regression: classification ---')
  const manager = classifyTitle('Staff Program Manager, Human & LLM Data Annotation Operations', ['ai-native'])
  ok('AI-vocabulary manager is not core', manager.tier !== 'core', `${manager.tier}/${manager.family}`)
  const product = classifyTitle('Staff Product Manager, Agentic Planning', ['ai-native'])
  ok('product manager is not core', product.tier !== 'core', `${product.tier}/${product.family}`)
  const engineer = classifyTitle('Senior Software Engineer, LLM Inference', ['ai-native'])
  ok('engineering IC stays core', engineer.tier === 'core', `${engineer.tier}/${engineer.family}`)

  console.log('\n--- regression: digest folds duplicate locations ---')
  const base = {
    company: 'Instacart',
    title: 'Staff Machine Learning Engineer',
    tier: 'core',
    seniority: 'staff',
    postedAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
    requirements: { skills: ['Python', 'PyTorch'], minYears: 5 },
    remote: false,
  }
  const folded = buildDigest({
    postings: [
      { ...base, id: 'a', location: 'Remote - Canada' },
      { ...base, id: 'b', location: 'Remote - USA' },
      { ...base, id: 'c', title: 'Senior Data Scientist', location: 'San Francisco' },
    ],
    perCompany: 4,
    limit: 10,
  })
  const foldedText = renderDigestText(folded, { lang: 'zh' })
  ok('same opening posted twice counts once', folded.selected === 2, `${folded.selected} selected of ${folded.candidates}`)
  ok('both locations kept on one line', foldedText.includes('Remote - Canada / Remote - USA'))

  console.log('\n--- regression: classifier migration on load ---')
  const legacyDir = await mkdtemp(join(tmpdir(), 'dsh-ai-jobs-migrate-'))
  const legacyStore = {
    version: 1,
    updatedAt: null,
    boards: { 'ashby:trychroma': { key: 'ashby:trychroma', company: 'Chroma', ats: 'ashby', token: 'trychroma', tags: ['ai-native'] } },
    postings: {
      stale: {
        id: 'stale',
        company: 'Chroma',
        ats: 'ashby',
        token: 'trychroma',
        title: 'Staff Program Manager, AI Platform',
        tier: 'core',
        family: 'product',
        seniority: 'staff',
        status: 'open',
      },
    },
    lastDigestAt: null,
    digestRuns: 0,
  }
  await writeFile(join(legacyDir, 'store.json'), JSON.stringify(legacyStore), 'utf8')
  const migrated = await new JobStore(legacyDir).load()
  const stale = migrated.get('stale')
  ok('stale tier reclassified on load', stale?.tier === 'adjacent', `${stale?.tier}/${stale?.family}`)
  ok('classifier version stamped', migrated.data.classifierVersion === 2, String(migrated.data.classifierVersion))
  await rm(legacyDir, { recursive: true, force: true }).catch(() => {})

  console.log('\n--- live refresh ---')
  const refreshed = await toolkit.refresh()
  ok('refresh ran', refreshed.boardsOk > 0, `${refreshed.boardsOk}/${refreshed.boards} boards, ${refreshed.postings} postings, ${refreshed.added} added, ${refreshed.elapsedMs}ms`)
  if (refreshed.errors.length) console.log('  board errors:', JSON.stringify(refreshed.errors))

  const store = toolkit.store
  ok('postings indexed', Object.keys(store.data.postings).length > 0, `${Object.keys(store.data.postings).length} records`)
  ok('store stamps updatedAt', Number.isFinite(Date.parse(store.data.updatedAt ?? '')), String(store.data.updatedAt))

  console.log('\n--- classification ---')
  const sample = Object.values(store.data.postings).find((posting) => posting.tier === 'core') ?? Object.values(store.data.postings)[0]
  ok('tier assigned', Boolean(sample?.tier), `${sample?.company} / ${sample?.title} -> ${sample?.tier}/${sample?.seniority}`)
  ok('jd stored', (sample?.jdChars ?? 0) > 0 || (sample?.jdHead ?? '').length > 0, `${sample?.jdChars ?? 0} chars`)

  console.log('\n--- search ---')
  const search = store.search({ tier: 'all', limit: 5, profile: toolkit.profile() })
  ok('search returns hits', search.hits.length > 0, `${search.total} matches, top score ${search.hits[0]?.score}`)

  console.log('\n--- requirements aggregate ---')
  const aggregate = store.search({ tier: 'all', limit: 50, profile: toolkit.profile() })
  ok('aggregate sample', aggregate.hits.length > 0, `${aggregate.hits.length} sampled`)

  console.log('\n--- digest ---')
  const digest = await toolkit.digest({ save: false, mark: true })
  ok('digest rendered', digest.markdown.includes('# AI 招聘雷达'), `${digest.selected} selected of ${digest.candidates}`)
  ok('digest marked', Boolean(store.data.lastDigestAt), String(store.data.lastDigestAt))
  const second = await toolkit.digest({ save: false, mark: false })
  ok('cursor advances digest', second.candidates === 0, `${second.candidates} candidates after mark`)

  console.log('\n--- status ---')
  const stats = store.stats()
  ok('stats coherent', stats.open > 0 && stats.boards === seed.length, `open=${stats.open} boards=${stats.boards}`)
  ok('status exposes lastUpdatedAt', Number.isFinite(Date.parse(stats.lastUpdatedAt ?? '')), String(stats.lastUpdatedAt))

  console.log('\n--- digest preview ---')
  console.log(digest.markdown.split('\n').slice(0, 16).join('\n'))
} finally {
  await rm(dir, { recursive: true, force: true }).catch(() => {})
}

console.log(`\n${failures === 0 ? 'SMOKE OK' : `SMOKE FAILED (${failures})`}`)
process.exitCode = failures === 0 ? 0 : 1
