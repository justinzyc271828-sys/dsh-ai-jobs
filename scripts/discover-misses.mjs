// Discover ATS board tokens for companies whose direct probes missed:
// fetch the careers page, extract greenhouse/ashby/lever/workable/smartrecruiters
// links, then verify the extracted token against the public API.
// Run: node scripts/discover-misses.mjs
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36'

const CAREERS = {
  Adept: 'https://www.adept.ai/careers',
  Mistral: 'https://mistral.ai/careers',
  HuggingFace: 'https://huggingface.co/jobs',
  Hebbia: 'https://www.hebbia.ai/careers',
  SSI: 'https://ssi.inc/',
  Luma: 'https://lumalabs.ai/careers',
  Groq: 'https://groq.com/careers/',
  Surge: 'https://www.surgehq.ai/careers',
  Replicate: 'https://replicate.com/about',
  WeightsBiases: 'https://wandb.ai/careers',
  SambaNova: 'https://sambanova.ai/company/careers',
  HashiCorp: 'https://www.hashicorp.com/en/careers',
  Qdrant: 'https://qdrant.tech/careers/',
  Uber: 'https://www.uber.com/global/en/careers/list/',
  Netflix: 'https://explore.jobs.netflix.net/careers',
  Shopify: 'https://www.shopify.com/careers',
  DoorDash: 'https://careers.doordash.com/',
  Grammarly: 'https://www.grammarly.com/jobs',
  Snap: 'https://careers.snap.com/',
  Windsurf: 'https://windsurf.com/careers',
  Kraken: 'https://www.kraken.com/careers',
}

const ATS_RE =
  /(?:boards\.greenhouse\.io|job-boards\.greenhouse\.io|jobs\.lever\.co|jobs\.ashbyhq\.com|apply\.workable\.com|jobs\.smartrecruiters\.com)\/[A-Za-z0-9._\-]+/gi

async function get(url, asJson = false) {
  const res = await fetch(url, {
    headers: { 'user-agent': UA, accept: asJson ? 'application/json' : 'text/html' },
    redirect: 'follow',
    signal: AbortSignal.timeout(20_000),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return asJson ? res.json() : res.text()
}

function tokenize(links) {
  const found = new Set()
  for (const link of links) {
    const lower = link.toLowerCase()
    const token = link.slice(link.lastIndexOf('/') + 1)
    if (!token || token.length < 2) continue
    let ats = null
    if (lower.includes('greenhouse')) ats = 'greenhouse'
    else if (lower.includes('lever.co')) ats = 'lever'
    else if (lower.includes('ashbyhq')) ats = 'ashby'
    else if (lower.includes('workable')) ats = 'workable'
    else if (lower.includes('smartrecruiters')) ats = 'smartrecruiters'
    if (ats && !['jobs', 'careers', 'embed', 'v1'].includes(token.toLowerCase())) found.add(`${ats}:${token}`)
  }
  return [...found]
}

async function verify(ats, token) {
  const url =
    ats === 'greenhouse'
      ? `https://boards-api.greenhouse.io/v1/boards/${token}/jobs?content=false`
      : ats === 'ashby'
        ? `https://api.ashbyhq.com/posting-api/job-board/${token}?includeCompensation=true`
        : ats === 'lever'
          ? `https://api.lever.co/v0/postings/${token}?mode=json`
          : ats === 'workable'
            ? `https://apply.workable.com/api/v1/widget/accounts/${token}?details=true`
            : `https://api.smartrecruiters.com/v1/companies/${token}/postings?limit=10`
  const json = await get(url, true)
  const count = Array.isArray(json)
    ? json.length
    : (json.jobs?.length ?? json.content?.length ?? 0)
  if (!count) throw new Error('empty board')
  return count
}

const results = []
for (const [company, careers] of Object.entries(CAREERS)) {
  const row = { company, careers, found: [], verified: null, error: null }
  try {
    const html = await get(careers)
    const candidates = tokenize(html.match(ATS_RE) ?? [])
    row.found = candidates
    for (const candidate of candidates) {
      const [ats, token] = candidate.split(':')
      try {
        const jobs = await verify(ats, token)
        row.verified = { ats, token, jobs }
        break
      } catch (error) {
        row.lastError = `${candidate}: ${error.message}`
      }
    }
  } catch (error) {
    row.error = error.message
  }
  results.push(row)
  console.log(`${row.verified ? 'HIT ' : 'MISS'} ${company} ${row.verified ? `${row.verified.ats}/${row.verified.token} jobs=${row.verified.jobs}` : (row.found.join(',') || row.error || 'no ATS link')}`)
}

writeFileSync(join(root, 'data', 'discovered.json'), `${JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2)}\n`)
const hits = results.filter((row) => row.verified)
console.log(`\nverified=${hits.length} of ${results.length}`)
