// Refresh orchestration: fetch boards with bounded concurrency, then pull
// missing JD bodies for boards whose list endpoint omits them.
import { fetchBoard, fetchGreenhouseDetail } from './sources.js'

/** Run `worker` over `items` with at most `limit` in flight. */
export async function pool(items, limit, worker, signal) {
  const results = []
  let index = 0
  const size = Math.max(1, Math.min(limit, items.length))
  const runners = Array.from({ length: size }, async () => {
    for (;;) {
      if (signal?.aborted) return
      const current = index++
      if (current >= items.length) return
      const item = items[current]
      try {
        results[current] = await worker(item, current)
      } catch (error) {
        results[current] = { ok: false, error: error?.message ?? String(error) }
      }
    }
  })
  await Promise.all(runners)
  return results
}

/**
 * Refresh every board into the store.
 * @param {import('./store.js').JobStore} store
 * @param {Array<{company: string, ats: string, token: string, tags?: string[]}>} boards
 */
export async function refreshBoards(store, boards, options = {}) {
  const {
    now = Date.now(),
    concurrency = 4,
    timeoutMs = 25_000,
    maxDetailPerBoard = 60,
    maxDetailTotal = 400,
    signal = null,
    onProgress = null,
  } = options

  const startedAt = Date.now()
  let detailBudget = maxDetailTotal
  let detailsFetched = 0
  let added = 0
  let changed = 0
  let closed = 0

  const results = await pool(
    boards,
    concurrency,
    async (board) => {
      try {
        const { postings, elapsedMs } = await fetchBoard(board, { timeoutMs, signal })
        const outcome = await store.upsertBoard(board, postings, { now, companyTags: board.tags ?? [] })
        added += outcome.added.length
        changed += outcome.changed.length
        closed += outcome.closed

        let details = 0
        if (board.ats === 'greenhouse' && outcome.needDetail.length && detailBudget > 0) {
          const budget = Math.min(maxDetailPerBoard, detailBudget, outcome.needDetail.length)
          const ids = outcome.needDetail.slice(0, budget)
          detailBudget -= ids.length
          await pool(
            ids,
            Math.min(3, concurrency),
            async (id) => {
              const record = store.get(id)
              if (!record) return
              try {
                const detail = await fetchGreenhouseDetail(board, record.externalId, { timeoutMs, signal })
                if (detail?.jd) {
                  await store.applyDetail(id, detail)
                  details += 1
                  detailsFetched += 1
                }
              } catch {
                // A single missing JD is not a board failure; retry next refresh.
              }
            },
            signal,
          )
        }

        const result = {
          ok: true,
          company: board.company,
          ats: board.ats,
          fetched: postings.length,
          added: outcome.added.length,
          changed: outcome.changed.length,
          closed: outcome.closed,
          details,
          elapsedMs,
        }
        onProgress?.(result)
        return result
      } catch (error) {
        const message = error?.message ?? String(error)
        store.recordBoardError(board, message)
        const result = { ok: false, company: board.company, ats: board.ats, error: message }
        onProgress?.(result)
        return result
      }
    },
    signal,
  )

  const okBoards = results.filter((result) => result?.ok)
  return {
    ok: okBoards.length > 0,
    boards: boards.length,
    boardsOk: okBoards.length,
    boardsFailed: boards.length - okBoards.length,
    postings: okBoards.reduce((sum, result) => sum + (result.fetched ?? 0), 0),
    added,
    changed,
    closed,
    details: detailsFetched,
    elapsedMs: Date.now() - startedAt,
    errors: results.filter((result) => result && !result.ok).map((result) => ({ company: result.company, error: result.error })),
    perBoard: results.filter(Boolean),
  }
}
