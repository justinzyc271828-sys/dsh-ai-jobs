#!/usr/bin/env node
// Probe public ATS job-board endpoints to verify which (ats, token) pair a
// company actually exposes. Output: JSON array of verified boards.
//
// Usage: node scripts/probe-companies.mjs [outFile]
import { writeFile } from 'node:fs/promises'

const UA = 'Mozilla/5.0 (compatible; dsh-ai-jobs-probe/0.1)'

const CANDIDATES = [
  // frontier labs / model companies
  ['anthropic', ['anthropic']],
  ['openai', ['openai']],
  ['xai', ['xai']],
  ['cohere', ['cohere']],
  ['mistral', ['mistral', 'mistralai', 'mistral-ai']],
  ['perplexity', ['perplexity', 'perplexityai']],
  ['huggingface', ['huggingface', 'hugging-face']],
  ['stabilityai', ['stabilityai', 'stability-ai']],
  ['runway', ['runway', 'runwayml']],
  ['midjourney', ['midjourney']],
  ['suno', ['suno']],
  ['elevenlabs', ['elevenlabs']],
  ['character', ['character', 'characterai']],
  ['inflection', ['inflection', 'inflectionai']],
  ['adept', ['adept']],
  ['magic', ['magic', 'magicdev']],
  ['poolside', ['poolside']],
  ['cognition', ['cognition', 'cognitionai']],
  ['thinkingmachines', ['thinkingmachines', 'thinking-machines']],
  ['ssi', ['ssi', 'safe-superintelligence']],
  ['luma', ['luma', 'lumalabs']],
  ['pika', ['pika']],
  ['sierra', ['sierra']],
  ['decagon', ['decagon']],
  ['harvey', ['harvey']],
  ['glean', ['glean', 'gleanwork']],
  ['hebbia', ['hebbia']],
  ['mercor', ['mercor']],
  ['surge', ['surge', 'surgeai']],
  ['scale', ['scale', 'scaleai']],
  ['turing', ['turing']],
  // infra / serving / tooling
  ['together', ['together', 'togetherai']],
  ['fireworks', ['fireworks', 'fireworksai']],
  ['groq', ['groq']],
  ['cerebras', ['cerebras']],
  ['sambanova', ['sambanova']],
  ['modal', ['modal', 'modal-labs']],
  ['replicate', ['replicate']],
  ['baseten', ['baseten']],
  ['anyscale', ['anyscale']],
  ['weightsandbiases', ['weightsandbiases', 'wandb', 'weights-biases']],
  ['langchain', ['langchain']],
  ['llamaindex', ['llamaindex']],
  ['pinecone', ['pinecone']],
  ['weaviate', ['weaviate']],
  ['qdrant', ['qdrant']],
  ['chroma', ['chroma', 'trychroma']],
  ['vectara', ['vectara']],
  // data platform / big tech
  ['databricks', ['databricks']],
  ['snowflake', ['snowflake']],
  ['stripe', ['stripe']],
  ['datadog', ['datadog']],
  ['cloudflare', ['cloudflare']],
  ['mongodb', ['mongodb']],
  ['elastic', ['elastic']],
  ['gitlab', ['gitlab']],
  ['hashicorp', ['hashicorp']],
  ['twilio', ['twilio']],
  ['vercel', ['vercel']],
  ['airtable', ['airtable']],
  ['asana', ['asana']],
  ['notion', ['notion']],
  ['linear', ['linear']],
  ['figma', ['figma']],
  ['shopify', ['shopify']],
  ['airbnb', ['airbnb']],
  ['uber', ['uber']],
  ['lyft', ['lyft']],
  ['doordash', ['doordash']],
  ['instacart', ['instacart']],
  ['netflix', ['netflix']],
  ['spotify', ['spotify']],
  ['reddit', ['reddit']],
  ['discord', ['discord']],
  ['roblox', ['roblox']],
  ['snap', ['snap', 'snapchat']],
  ['pinterest', ['pinterest']],
  ['duolingo', ['duolingo']],
  ['khanacademy', ['khanacademy', 'khan-academy']],
  ['grammarly', ['grammarly']],
  ['plaid', ['plaid']],
  ['brex', ['brex']],
  ['ramp', ['ramp']],
  ['coinbase', ['coinbase']],
  ['kraken', ['kraken']],
  ['replit', ['replit']],
  ['cursor', ['cursor', 'anysphere']],
  ['windsurf', ['windsurf', 'codeium']],
  ['shopifyglobal', ['shopify-at']],
]

const ENDPOINTS = {
  greenhouse: (t) => `https://boards-api.greenhouse.io/v1/boards/${t}/jobs?content=false`,
  ashby: (t) => `https://api.ashbyhq.com/posting-api/job-board/${t}`,
  lever: (t) => `https://api.lever.co/v0/postings/${t}?mode=json`,
  workable: (t) => `https://apply.workable.com/api/v1/widget/accounts/${t}?details=false`,
  smartrecruiters: (t) => `https://api.smartrecruiters.com/v1/companies/${t}/postings?limit=1`,
}

function countJobs(ats, body) {
  try {
    const json = body.trim().startsWith('[') ? JSON.parse(body) : JSON.parse(body)
    if (ats === 'greenhouse') return Array.isArray(json.jobs) ? json.jobs.length : 0
    if (ats === 'ashby') return Array.isArray(json.jobs) ? json.jobs.length : 0
    if (ats === 'lever') return Array.isArray(json) ? json.length : 0
    if (ats === 'workable') return Array.isArray(json.jobs) ? json.jobs.length : 0
    if (ats === 'smartrecruiters') return Array.isArray(json.content) ? json.totalFound ?? json.content.length : 0
  } catch {
    return 0
  }
  return 0
}

async function probe(ats, token) {
  const url = ENDPOINTS[ats](token)
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 15000)
  try {
    const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' }, signal: ctrl.signal })
    if (!res.ok) return null
    const body = await res.text()
    const jobs = countJobs(ats, body)
    if (!jobs) return null
    return { ats, token, jobs, url }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

function slugsFor(name, alts) {
  const out = new Set()
  for (const a of [name, ...alts]) {
    out.add(a.toLowerCase())
    out.add(a.toLowerCase().replace(/[\s.]/g, ''))
    out.add(a.toLowerCase().replace(/[\s._]/g, '-'))
  }
  return [...out]
}

const results = []
const errors = []
const queue = [...CANDIDATES]
const CONCURRENCY = 6

async function worker() {
  while (queue.length) {
    const [name, alts] = queue.shift()
    const slugs = slugsFor(name, alts).slice(0, 4)
    let hit = null
    for (const slug of slugs) {
      for (const ats of ['greenhouse', 'ashby', 'lever']) {
        const r = await probe(ats, slug)
        if (r) {
          hit = { company: name, ...r }
          break
        }
      }
      if (hit) break
    }
    if (hit) {
      results.push(hit)
      console.error(`HIT  ${hit.company.padEnd(18)} ${hit.ats.padEnd(10)} ${hit.token.padEnd(24)} jobs=${hit.jobs}`)
    } else {
      errors.push(name)
      console.error(`MISS ${name}`)
    }
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, worker))
results.sort((a, b) => a.company.localeCompare(b.company))
const out = process.argv[2] || 'data/probed.json'
await writeFile(out, JSON.stringify({ generatedAt: new Date().toISOString(), hits: results, misses: errors }, null, 2))
console.error(`\nverified=${results.length} missed=${errors.length} -> ${out}`)
