// Build data/companies.json (the shipped seed watchlist) from data/probed.json.
// Run: node scripts/build-seed.mjs
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const probed = JSON.parse(readFileSync(join(root, 'data', 'probed.json'), 'utf8'))

const DISPLAY = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  xai: 'xAI',
  cohere: 'Cohere',
  perplexity: 'Perplexity',
  thinkingmachines: 'Thinking Machines Lab',
  inflection: 'Inflection AI',
  stabilityai: 'Stability AI',
  character: 'Character.AI',
  magic: 'Magic',
  poolside: 'Poolside',
  cognition: 'Cognition',
  cursor: 'Cursor (Anysphere)',
  replit: 'Replit',
  elevenlabs: 'ElevenLabs',
  suno: 'Suno',
  midjourney: 'Midjourney',
  pika: 'Pika',
  runway: 'Runway',
  harvey: 'Harvey',
  sierra: 'Sierra',
  decagon: 'Decagon',
  glean: 'Glean',
  baseten: 'Baseten',
  cerebras: 'Cerebras',
  fireworks: 'Fireworks AI',
  modal: 'Modal',
  anyscale: 'Anyscale',
  together: 'Together AI',
  scale: 'Scale AI',
  pinecone: 'Pinecone',
  weaviate: 'Weaviate',
  chroma: 'Chroma',
  langchain: 'LangChain',
  llamaindex: 'LlamaIndex',
  mercor: 'Mercor',
  vectara: 'Vectara',
  turing: 'Turing',
  linear: 'Linear',
  notion: 'Notion',
  databricks: 'Databricks',
  snowflake: 'Snowflake',
  stripe: 'Stripe',
  datadog: 'Datadog',
  cloudflare: 'Cloudflare',
  elastic: 'Elastic',
  mongodb: 'MongoDB',
  roblox: 'Roblox',
  coinbase: 'Coinbase',
  gitlab: 'GitLab',
  airbnb: 'Airbnb',
  lyft: 'Lyft',
  pinterest: 'Pinterest',
  reddit: 'Reddit',
  figma: 'Figma',
  twilio: 'Twilio',
  brex: 'Brex',
  instacart: 'Instacart',
  vercel: 'Vercel',
  duolingo: 'Duolingo',
  discord: 'Discord',
  asana: 'Asana',
  airtable: 'Airtable',
  khanacademy: 'Khan Academy',
  ramp: 'Ramp',
  plaid: 'Plaid',
  spotify: 'Spotify',
}

const FRONTIER = new Set([
  'anthropic',
  'openai',
  'xai',
  'cohere',
  'perplexity',
  'thinkingmachines',
  'inflection',
  'stabilityai',
  'character',
  'magic',
  'poolside',
  'cognition',
])

const AI_NATIVE = new Set([
  'cursor',
  'replit',
  'elevenlabs',
  'suno',
  'midjourney',
  'pika',
  'runway',
  'harvey',
  'sierra',
  'decagon',
  'glean',
  'baseten',
  'cerebras',
  'fireworks',
  'modal',
  'anyscale',
  'together',
  'scale',
  'pinecone',
  'weaviate',
  'chroma',
  'langchain',
  'llamaindex',
  'mercor',
  'vectara',
  'turing',
  'linear',
  'notion',
])

function tagsFor(company) {
  if (FRONTIER.has(company)) return ['frontier-lab', 'ai-native']
  if (AI_NATIVE.has(company)) return ['ai-native']
  return ['ai-user']
}

function careersUrl(ats, token) {
  switch (ats) {
    case 'greenhouse':
      return `https://job-boards.greenhouse.io/${token}`
    case 'ashby':
      return `https://jobs.ashbyhq.com/${token}`
    case 'lever':
      return `https://jobs.lever.co/${token}`
    default:
      return null
  }
}

const hits = (probed.hits ?? [])
  .filter((hit) => hit.company && hit.ats && hit.token)
  .map((hit) => ({
    company: DISPLAY[hit.company] ?? hit.company,
    handle: hit.company,
    ats: hit.ats,
    token: hit.token,
    tags: tagsFor(hit.company),
    jobs: hit.jobs ?? null,
    careersUrl: careersUrl(hit.ats, hit.token),
  }))

// Boards found by scripts/discover-misses.mjs (careers page -> ATS link), which
// the direct token probe could not guess.
const EXTRA = [
  { company: 'Mistral AI', handle: 'mistral', ats: 'ashby', token: 'mistral.ai', tags: ['frontier-lab', 'ai-native'], careersUrl: 'https://jobs.ashbyhq.com/mistral.ai' },
  { company: 'Hebbia', handle: 'hebbia', ats: 'ashby', token: 'hebbia-ai', tags: ['ai-native'], careersUrl: 'https://jobs.ashbyhq.com/hebbia-ai' },
  { company: 'Luma AI', handle: 'luma', ats: 'ashby', token: 'lumaai', tags: ['ai-native'], careersUrl: 'https://jobs.ashbyhq.com/lumaai' },
  { company: 'Kraken', handle: 'kraken', ats: 'ashby', token: 'kraken.com', tags: ['ai-user'], careersUrl: 'https://jobs.ashbyhq.com/kraken.com' },
]
for (const board of EXTRA) {
  if (!hits.some((hit) => hit.ats === board.ats && hit.token === board.token)) hits.push({ ...board, jobs: null })
}

hits.sort((a, b) => a.company.localeCompare(b.company))

writeFileSync(
  join(root, 'data', 'companies.json'),
  `${JSON.stringify({ version: 1, generatedAt: new Date().toISOString(), companies: hits }, null, 2)}\n`,
  'utf8',
)
console.log(`wrote ${hits.length} companies`)
