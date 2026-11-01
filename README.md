# dsh-ai-jobs

**AI hiring radar for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).**
Index the public job boards of AI labs and AI-heavy companies, rank every posting against your own
criteria, mine what they actually ask for (years, skills, degree, work mode, comp, visa), and push a
daily digest of the openings worth reading.

No API keys, no accounts, no scraping of logged-in sites — every source is a public ATS board
endpoint that the company itself publishes for its careers page.

## Why

Job hunting for AI roles is a search problem over ~70 companies that each use a different ATS.
The data is public but scattered, re-read by hand every week, and impossible to compare across
companies. This plugin keeps one local index, so you can ask cross-company questions:

- Which labs are hiring research engineers right now, and what do they require?
- What share of core AI roles ask for a PhD? What is the median "N+ years"?
- Which openings appeared in the last 7 days, and which of them match my stack?
- What do Anthropic/OpenAI/Mistral ask for that I do not have yet?

## What it does

| Step | Detail |
| --- | --- |
| **Collect** | 71 pre-verified boards (Greenhouse, Ashby, Lever) + Workable/SmartRecruiters for your own additions |
| **Normalize** | One posting shape across ATSes: title, locations, remote flag, department, dates, URL, JD text |
| **Classify** | `core` / `adjacent` / `other` AI relevance, role family, seniority — rule-based and auditable |
| **Mine** | Years of experience, degree, work mode, compensation range, visa sponsorship, 40-skill vocabulary |
| **Rank** | 0–100 score from relevance, freshness, seniority, your skills of interest and preferred locations |
| **Store** | Local JSON index with JD snapshots, change history, and a digest cursor |
| **Push** | Markdown digest + optional daily reminder through the harness scheduler |

## Install

```bash
# from the marketplace / npm (once published)
dsh plugin --profile web add dsh-ai-jobs

# from a local checkout, for development
dsh plugin --profile desktop add ./dsh-ai-jobs

# from a packed tarball
npm pack && dsh plugin --profile desktop add ./dsh-ai-jobs-0.1.0.tgz
```

The bundle patch mounts one plugin row (`ai-jobs`); restart the app or toggle it on the Plugins page.

## Quick start

```
ai_jobs_refresh                     # index every watched board (first run: ~10s for 3 big boards)
ai_jobs_search { "tier": "core", "postedWithinDays": 7, "minScore": 70 }
ai_jobs_requirements { "tier": "core", "limit": 200 }
ai_jobs_digest
ai_jobs_watchlist { "action": "add", "company": "Mistral", "ats": "ashby", "token": "mistral.ai" }
```

## Tools

| Tool | What it returns |
| --- | --- |
| `ai_jobs_refresh` | Re-index all/A-selected boards. Reports per-board ok/error, added/changed/closed counts. |
| `ai_jobs_search` | Filtered, scored postings: `query`, `company`, `tier`, `seniority`, `remote`, `location`, `minScore`, `postedWithinDays`, `limit`, `sort`. |
| `ai_jobs_get` | One posting in full: metadata, score, extracted requirements, JD head, stored JD path. |
| `ai_jobs_digest` | Markdown digest of what changed since the last digest (or the last N days). |
| `ai_jobs_requirements` | Cross-company aggregate: skill frequency, median years, degree mix, work-mode mix, comp ranges. |
| `ai_jobs_watchlist` | `list` / `add` / `remove` boards (any of greenhouse, ashby, lever, workable, smartrecruiters). |
| `ai_jobs_status` | Index health: boards, open/closed counts, tier mix, last refresh, last digest, storage path. |
| `ai_jobs_schedule` | `create` / `list` / `delete` the daily digest reminder (needs the `schedule` service). |

## Daily digest

Two ways:

1. `ai_jobs_schedule { "action": "create", "time": "09:00:00", "timeZone": "Asia/Shanghai" }` —
   one reminder per session, matching `title` ≤ 120 chars.
2. `dailyDigest.enabled: true` in config — the plugin arms the reminder itself the first time a
   session runs `ai_jobs_refresh` or `ai_jobs_digest`.

The digest only reports postings that are new since the previous digest cursor, so a daily push does
not repeat yesterday's openings. `ai_jobs_digest { "days": 7 }` ignores the cursor.

## Configuration

```json
{
  "lang": "zh",
  "timeZone": "Asia/Shanghai",
  "concurrency": 4,
  "skillsOfInterest": ["LLM", "inference", "agents", "RAG"],
  "preferredLocations": ["San Francisco", "Remote"],
  "remoteOk": true,
  "digestPerCompany": 4,
  "digestLimit": 30,
  "digestMinScore": 0,
  "dailyDigest": { "enabled": true, "time": "09:00:00" },
  "companies": [
    { "company": "Cohere", "ats": "ashby", "token": "cohere", "tags": ["frontier-lab"] }
  ]
}
```

| Key | Default | Meaning |
| --- | --- | --- |
| `dataDir` | `$DSH_HOME/ai-jobs` (falls back to `~/.dsh/ai-jobs`) | Index, JD snapshots, digest state |
| `lang` | `zh` | Digest language (`zh` / `en`) |
| `concurrency` | `4` | Parallel board fetches |
| `timeoutMs` | `25000` | Per-request timeout |
| `jdMaxChars` | `20000` | JD text kept per posting |
| `maxDetailPerBoard` | `60` | Greenhouse JD fetches per board per refresh |
| `tags` | from seed | `frontier-lab`, `ai-native`, `ai-user` — used by scoring and filters |
| `companies` | `[]` | Extra boards appended to the shipped seed |

## Data sources

All endpoints are public and unauthenticated:

| ATS | Endpoint | Seed boards |
| --- | --- | --- |
| Greenhouse | `boards-api.greenhouse.io/v1/boards/{token}/jobs` | 33 |
| Ashby | `api.ashbyhq.com/posting-api/job-board/{token}` | 37 |
| Lever | `api.lever.co/v0/postings/{token}?mode=json` | 1 |
| Workable | `apply.workable.com/api/v1/widget/accounts/{token}` | — |
| SmartRecruiters | `api.smartrecruiters.com/v1/companies/{token}/postings` | — |

The shipped seed covers Anthropic, OpenAI, xAI, Mistral, Cohere, Perplexity, Thinking Machines,
Cursor, Cognition, Harvey, Sierra, Decagon, ElevenLabs, Suno, Midjourney, Runway, Baseten, Cerebras,
Fireworks, Modal, Anyscale, Together, Scale, Pinecone, Weaviate, Chroma, LangChain, LlamaIndex,
Databricks, Snowflake, Stripe, Cloudflare, Datadog, Elastic, MongoDB, Figma, Notion, Vercel, Plaid,
Ramp, Airbnb, Instacart, Lyft, Pinterest, Reddit, Discord, Roblox, Duolingo, Khan Academy, Spotify
and more. Companies on Greenhouse store their JD behind a second request; the plugin fetches it only
for new or changed postings.

`ai_jobs_watchlist` adds any other company whose careers page exposes one of these boards. Token
discovery is manual by design — the seed was verified one board at a time.

## How ranking works

```
score = tier(55 core / 30 adjacent / 8 other)
      + freshness (30 → 0 over ~40 days)
      + seniority (-6 intern … +7 principal)
      + skills-of-interest overlap (max 12)
      + location preference (max 8) / remote (max 6)
      + comp disclosed (3)
```

Titles that mention AI but hire for a non-engineering function (counsel, sales, policy, marketing,
recruiting, finance, procurement …) are classified `other` before the AI patterns run.

## Data & privacy

- Everything is stored locally under `$DSH_HOME/ai-jobs`: `store.json` (index), `jd/*.txt` (JD
  snapshots), digest cursor.
- The plugin sends no telemetry and has no backend. It only calls the public board endpoints listed
  above, with a descriptive User-Agent.
- Nothing is scraped from logged-in sites; no credentials are read or stored.
- Deleting `dataDir` removes everything.

## Legal note

Board endpoints are published by the companies for their own careers pages. Keep the default
politeness settings (`concurrency: 4`, one refresh per run, JD fetched only for new postings) and do
not republish bulk data. Requirements, compensation, and availability change; always confirm on the
company's own careers page before acting.

## Development

```bash
npm run smoke        # schema contract + refresh/search/digest against two small boards
npm run live-check   # multi-board end-to-end check against the real APIs
npm run probe        # re-verify candidate ATS tokens
npm run seed         # rebuild data/companies.json
```

Layout: `src/text.js` (HTML → text), `src/sources.js` (ATS adapters), `src/classify.js`
(tier/seniority/requirements/score), `src/store.js` (index + JD snapshots), `src/digest.js`
(markdown), `src/tools.js` (8 tools), `src/index.js` (bundle entry).

Zero runtime dependencies; Node built-ins only.

## License

MIT
