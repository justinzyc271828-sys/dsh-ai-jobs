// Title classification, requirement extraction, and relevance scoring.
// Rule-based on purpose: deterministic, auditable, and free of API calls.

/** Canonical skill vocabulary: [label, regex, weight]. */
const SKILLS = [
  ['Python', /\bpython\b/i, 2],
  ['PyTorch', /\bpytorch\b/i, 3],
  ['TensorFlow', /\btensorflow\b/i, 2],
  ['JAX', /\bjax\b/i, 2],
  ['CUDA', /\bcuda\b/i, 3],
  ['Triton', /\btriton\b/i, 2],
  ['C++', /\bc\+\+\b/i, 2],
  ['Rust', /\brust\b/i, 1],
  ['Go', /\bgolang\b|\bgo\b(?=\s*(?:,|and|programming))/i, 1],
  ['SQL', /\bsql\b/i, 1],
  ['Spark', /\bspark\b/i, 1],
  ['Ray', /\bray\b(?=\s*(?:,|and|cluster))/i, 1],
  ['Kubernetes', /\bkubernetes\b|\bk8s\b/i, 1],
  ['Docker', /\bdocker\b/i, 1],
  ['Distributed training', /distributed\s+training|multi-?node\s+training/i, 3],
  ['LLM', /\bllms?\b|large\s+language\s+models?/i, 3],
  ['RAG', /\brag\b|retrieval[- ]augmented/i, 2],
  ['Transformers', /transformers?\b/i, 2],
  ['vLLM', /\bvllm\b/i, 2],
  ['Inference optimization', /inference\s+(?:optimization|latency|throughput|serving)|model\s+serving/i, 3],
  ['Fine-tuning', /fine-?tun(?:e|ing)|post-?training/i, 2],
  ['RL', /reinforcement\s+learning|\brlhf\b|\brl\b/i, 3],
  ['Alignment', /alignment|\bconstitutional\s+ai\b/i, 3],
  ['Interpretability', /interpretability|mechanistic\s+interpretability/i, 3],
  ['Safety / evals', /\bevals?\b|evaluation\s+(?:suite|harness)|red[- ]team|safety\s+(?:research|evaluation)/i, 3],
  ['Multimodal', /multimodal|vision-language|\bvlm\b/i, 2],
  ['Computer vision', /computer\s+vision|\bcv\b|image\s+generation|diffusion\s+models?/i, 2],
  ['NLP', /\bnlp\b|natural\s+language\s+processing/i, 2],
  ['Speech / audio', /\bspeech\b|\basr\b|\btts\b|text-to-speech|speech-to-text/i, 2],
  ['Agents', /\bagent(?:ic|s)?\b|tool[- ]use|function\s+calling/i, 2],
  ['Prompt engineering', /prompt\s+engineering|prompt\s+design/i, 1],
  ['Embeddings / vector search', /embeddings?|vector\s+(?:search|database|store)|semantic\s+search/i, 2],
  ['Quantization', /quantiz(?:ation|ed)|low-?precision|\bfp8\b|\bint[48]\b/i, 2],
  ['MLOps', /\bmlops\b|model\s+registry|feature\s+store/i, 2],
  ['Data pipelines', /data\s+pipelines?|\betl\b|data\s+(?:infrastructure|platform)/i, 1],
  ['A/B testing', /a\/b\s+test(?:ing)?|experimentation\s+platform/i, 1],
  ['Statistics', /\bstatistic(?:s|al)\b|\bcausal\s+inference\b/i, 1],
  ['Product sense', /product\s+(?:sense|judgment)|customer\s+discovery|user\s+research/i, 1],
]

/** Title families and their core-AI patterns. */
const CORE_PATTERNS = [
  /\bresearch\s+(?:scientist|engineer|scientist\s+manager|manager)\b/,
  /\bapplied\s+(?:scientist|research|ai)\b/,
  /\bmachine\s+learning\b/,
  /\bml\s+(?:engineer|scientist|infra|infrastructure|platform|systems?)\b/,
  /\bai\s+(?:engineer|researcher|scientist|platform|infrastructure|systems?|safety|product)\b/,
  /\b(llm|genai|generative\s+ai|foundation\s+models?|deep\s+learning)\b/,
  /\b(inference|serving|pre-?training|post-?training|training\s+infra\w*)\b/,
  /\b(alignment|interpretability|red[- ]team|evals?)\b/,
  /\breinforcement\s+learning\b|\brl\b/,
  /\b(multimodal|vision-language|computer\s+vision|perception)\b/,
  /\b(nlp|natural\s+language|speech|asr|tts)\b/,
  /\b(agentic|agents?|prompt\s+engineer)\b/,
  /\bdata\s+scientist\b/,
  /\bmember\s+of\s+(?:the\s+)?technical\s+staff\b/,
]

const ADJACENT_PATTERNS = [
  /\b(software|backend|front\w*|full[- ]?stack|platform|infrastructure|systems?)\s+engineer\b/,
  /\b(sre|site\s+reliability|security|devops)\b/,
  /\bdata\s+(?:engineer|platform|architect)\b/,
  /\b(product|program|project)\s+manager\b|\btpm\b/,
  /\b(solutions?|forward\s+deployed|customer)\s+engineer\b/,
  /\b(developer\s+advocate|devrel|developer\s+relations)\b/,
  /\b(quantitative|quant)\s+(?:researcher|research|developer)\b/,
  /\b(ux|product|design)\s+(?:researcher|designer)\b/,
]

const SENIORITY_RULES = [
  ['intern', /\bintern(?:ship)?\b/],
  ['newgrad', /\b(new\s*grad|graduate|entry[- ]level|university\s+grad)\b/],
  ['junior', /\bjunior\b|\bassociate\b/],
  ['principal', /\bprincipal\b/],
  ['distinguished', /\bdistinguished\b|\bfellow\b/],
  ['staff', /\bstaff\b/],
  ['senior', /\bsenior\b|\bsr\.?\b/],
  ['lead', /\blead\b|\btech\s+lead\b/],
  ['director', /\bdirector\b|\bhead\s+of\b|\bvp\b|\bchief\b/],
  ['manager', /\bmanager\b/],
]

/**
 * People-management titles: they can carry AI vocabulary ("Program Manager, LLM Data
 * Operations") without being an AI IC role, so they never rank as core.
 */
const MANAGERIAL_TITLE = /\b(program|project|product)\s+(?:manager|lead)\b|\btechnical\s+program\s+manager\b|\btpm\b/

/** Titles that mention AI but hire for a non-engineering function. */
const NON_TECHNICAL_TITLE =
  /\b(counsel|legal|attorney|paralegal|compliance|policy|government\s+(?:affairs|relations)|public\s+sector|marketing|brand|communications?|content\s+(?:strategist|writer|designer)|copywriter|sales|account\s+executive|business\s+development|partnerships?|customer\s+success|technical\s+support|recruit\w+|talent|people\s+(?:ops|partner)|human\s+resources|payroll|finance|accounting|tax|procurement|supply\s+chain|cost\s+management|audit|facilities|workplace|executive\s+assistant|editor|producer|analyst,\s+(?:finance|sales|marketing))\b/

export function classifyTitle(title, companyTags = []) {
  const text = String(title ?? '').toLowerCase()
  let tier = 'other'
  if (NON_TECHNICAL_TITLE.test(text)) tier = 'other'
  else if (CORE_PATTERNS.some((re) => re.test(text))) tier = 'core'
  else if (ADJACENT_PATTERNS.some((re) => re.test(text))) tier = 'adjacent'
  // Labs post bare "Member of Technical Staff" roles that never name a stack.
  if (tier === 'other' && companyTags.includes('frontier-lab') && /technical\s+staff|researcher/.test(text)) tier = 'core'
  // A manager of AI work is a real opening, but it is not an AI IC role.
  if (tier === 'core' && MANAGERIAL_TITLE.test(text)) tier = 'adjacent'

  let family = 'other'
  if (/\bresearch\b/.test(text)) family = 'research'
  else if (/product\s+manager|program\s+manager|product\s+lead/.test(text)) family = 'product'
  else if (/safety|alignment|interpretability|evals?\b|policy/.test(text)) family = 'safety'
  else if (/\bml\b|machine\s+learning|data\s+scientist|deep\s+learning/.test(text)) family = 'ml'
  else if (/infra|platform|serving|inference|systems?\b/.test(text)) family = 'infra'
  else if (/applied|solutions|forward\s+deployed|customer/.test(text)) family = 'applied'
  else if (/engineer|developer/.test(text)) family = 'eng'
  else if (/data\b/.test(text)) family = 'data'

  let seniority = 'unknown'
  for (const [label, re] of SENIORITY_RULES) {
    if (re.test(text)) {
      seniority = label
      break
    }
  }
  if (seniority === 'unknown') seniority = 'mid'
  return { tier, family, seniority }
}

const DEGREE_RULES = [
  ['PhD', /\bph\.?\s?d\b|\bdoctora(?:te|l)\b/],
  ['MS', /\bmaster'?s?\b|\bm\.?\s?s\.?\b(?!\s*(?:in|of)?\s*(?:ai|cs))/],
  ['BS', /\bbachelor'?s?\b|\bb\.?\s?s\.?\b|\bundergraduate\s+degree\b/],
]

const REMOTE_RE = /\b(fully\s+remote|remote[- ]first|remote\s+ok|work\s+from\s+anywhere|100%\s+remote)\b/i
const HYBRID_RE = /\bhybrid\b|\b\d\s+days?\s+(?:per\s+week\s+)?in[- ](?:the\s+)?office\b/i
const ONSITE_RE = /\b(on-?site|in[- ]person|in\s+office)\b/i

function parseComp(text) {
  // $180,000 - $220,000  |  $180k-$220k  |  USD 180,000 – 220,000
  const range = text.match(
    /\$\s?(\d{2,3})(?:[,.](\d{3}))?\s?[kK]?\s*(?:-|–|—|to)\s*\$?\s?(\d{2,3})(?:[,.](\d{3}))?\s?[kK]?/,
  )
  if (range) {
    const min = Number(range[1]) * (range[2] ? 1000 : 1) * (range[2] ? 1 : 1000)
    const max = Number(range[3]) * (range[4] ? 1000 : 1) * (range[4] ? 1 : 1000)
    if (Number.isFinite(min) && Number.isFinite(max) && max >= min && min > 1000) return { min, max, currency: 'USD' }
  }
  const single = text.match(/\$\s?(\d{2,3}),?(\d{3})/)
  if (single) {
    const value = Number(single[1]) * 1000 + Number(single[2])
    if (Number.isFinite(value) && value > 1000) return { min: value, max: value, currency: 'USD' }
  }
  return null
}

function parseYears(text) {
  const patterns = [
    /(\d{1,2})\s*(?:\+|plus)?\s*(?:-|–|—|to)\s*(\d{1,2})\s*(?:\+)?\s*years?/i,
    /(\d{1,2})\s*\+\s*years?/i,
    /at\s+least\s+(\d{1,2})\s*years?/i,
    /minimum\s+of\s+(\d{1,2})\s*years?/i,
    /(\d{1,2})\s*years?\s+(?:of\s+)?(?:experience|industry)/i,
  ]
  const values = []
  for (const re of patterns) {
    const m = text.match(re)
    if (m) {
      const first = Number(m[1])
      if (Number.isFinite(first) && first > 0 && first <= 30) values.push(first)
    }
  }
  if (!values.length) return { minYears: null, maxYears: null }
  return { minYears: Math.min(...values), maxYears: Math.max(...values) }
}

export function extractRequirements(jd) {
  const text = String(jd ?? '')
  const skills = []
  let skillScore = 0
  for (const [label, re, weight] of SKILLS) {
    if (re.test(text)) {
      skills.push(label)
      skillScore += weight
    }
  }
  const { minYears, maxYears } = parseYears(text)
  let degree = null
  for (const [label, re] of DEGREE_RULES) {
    if (re.test(text)) {
      degree = label
      break
    }
  }
  let workMode = null
  if (REMOTE_RE.test(text)) workMode = 'remote'
  else if (HYBRID_RE.test(text)) workMode = 'hybrid'
  else if (ONSITE_RE.test(text)) workMode = 'onsite'

  let visa = null
  if (/unable\s+to\s+(?:provide\s+)?sponsor|no\s+(?:visa\s+)?sponsorship|cannot\s+sponsor/i.test(text)) visa = false
  else if (/visa\s+sponsorship|we\s+(?:do\s+)?sponsor|sponsorship\s+(?:is\s+)?available/i.test(text)) visa = true

  return {
    skills: skills.slice(0, 12),
    skillScore,
    minYears,
    maxYears,
    degree,
    workMode,
    comp: parseComp(text),
    visa,
  }
}

const SENIORITY_POINTS = {
  distinguished: 8,
  principal: 7,
  staff: 6,
  lead: 5,
  director: 4,
  senior: 4,
  manager: 2,
  mid: 2,
  unknown: 0,
  junior: -3,
  newgrad: -5,
  intern: -8,
}

/**
 * Bump when title rules change: the store reclassifies existing postings on load so
 * an upgrade does not leave stale tiers behind.
 */
export const CLASSIFIER_VERSION = 2

const TIER_POINTS = { core: 55, adjacent: 28, other: 8 }

/**
 * Score a normalized posting 0-100 against a preference profile.
 * @param {object} posting
 * @param {{now?: number, skillsOfInterest?: string[], preferredLocations?: string[], remoteOk?: boolean}} profile
 */
export function scorePosting(posting, profile = {}) {
  const now = profile.now ?? Date.now()
  const posted = posting.postedAt ? Date.parse(posting.postedAt) : Number.NaN
  const ageDays = Number.isFinite(posted) ? Math.max(0, (now - posted) / 86_400_000) : 30
  const freshness = Math.max(0, 30 - ageDays * 0.8)

  let total = (TIER_POINTS[posting.tier] ?? 8) + freshness + (SENIORITY_POINTS[posting.seniority] ?? 0)

  const interests = (profile.skillsOfInterest ?? []).map((s) => s.toLowerCase())
  if (interests.length) {
    const hay = `${posting.title} ${(posting.requirements?.skills ?? []).join(' ')}`.toLowerCase()
    const hits = interests.filter((s) => hay.includes(s)).length
    total += Math.min(12, hits * 3)
  }

  const preferred = (profile.preferredLocations ?? []).map((s) => s.toLowerCase()).filter(Boolean)
  if (preferred.length) {
    const loc = String(posting.location ?? '').toLowerCase()
    if (preferred.some((p) => loc.includes(p))) total += 8
    else if (posting.remote && profile.remoteOk !== false) total += 6
  } else if (posting.remote && profile.remoteOk) {
    total += 6
  }

  if (posting.comp?.min) total += 3
  if (posting.requirements?.visa === false) total -= 4

  return Math.max(0, Math.min(100, Math.round(total)))
}

/** Short human-readable requirement line used by search results and digests. */
export function requirementLine(posting) {
  const req = posting.requirements ?? {}
  const parts = []
  if (req.minYears) parts.push(`${req.minYears}+ 年经验`)
  if (req.skills?.length) parts.push(req.skills.slice(0, 5).join(' / '))
  if (req.degree) parts.push(req.degree)
  if (posting.comp?.min) {
    const fmt = (n) => `${Math.round(n / 1000)}k`
    parts.push(posting.comp.min === posting.comp.max ? `$${fmt(posting.comp.min)}` : `$${fmt(posting.comp.min)}-${fmt(posting.comp.max)}`)
  }
  if (req.workMode === 'remote') parts.push('远程')
  else if (req.workMode === 'hybrid') parts.push('混合')
  return parts.join(' · ')
}

export { SKILLS }
