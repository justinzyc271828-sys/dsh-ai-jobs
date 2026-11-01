# Changelog

## 0.1.1 — 2026-11-01

- People-management titles that carry AI vocabulary (program / product / project manager, TPM) are
  now `adjacent`, not `core`: a manager of AI work is a real opening, but not an AI IC role.
- Existing indexes are reclassified on load (`CLASSIFIER_VERSION`), so an upgrade does not keep
  serving the previous release's tiers until every posting is refetched.
- The digest folds the same opening posted to several locations into one entry and shows all
  locations on one line.
- `ai_jobs_status` now reports `lastUpdatedAt`: the index timestamp is persisted with the store
  instead of living only in the response.
- Smoke test covers the classifier migration, the manager/IC distinction, and digest folding.

## 0.1.0 — 2026-11-01

First release.

- Index 71 pre-verified AI job boards across Greenhouse, Ashby, and Lever (plus Workable and
  SmartRecruiters for user-added companies). No API keys, no login.
- Normalize postings across ATSes: title, locations, remote flag, department, dates, URL, JD text.
- Rule-based classification: `core` / `adjacent` / `other` AI relevance, role family, seniority;
  non-engineering AI titles (counsel, sales, policy, finance, recruiting …) are filtered out.
- Requirement mining from JD text: years of experience, degree, work mode, compensation range,
  visa sponsorship, and a 38-skill vocabulary.
- 0–100 relevance score combining tier, freshness, seniority, your skills of interest, preferred
  locations, and disclosed compensation.
- Local JSON index with JD snapshots, change tracking, and a digest cursor.
- Eight tools: `ai_jobs_refresh`, `ai_jobs_search`, `ai_jobs_get`, `ai_jobs_digest`,
  `ai_jobs_requirements`, `ai_jobs_watchlist`, `ai_jobs_status`, `ai_jobs_schedule`.
- Daily digest with an optional self-arming reminder through the harness `schedule` service.
- Zero runtime dependencies; Node built-ins only.
