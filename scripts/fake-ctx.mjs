// Mount the plugin against a fake cordis context: proves the bundle entry can be
// imported and register every tool without touching a live app.
// Run: node scripts/fake-ctx.mjs
import { apply, normalizeConfig, loadSeedCompanies } from '../src/index.js'

const registered = []
const ctx = {
  tools: {
    register(dependency) {
      registered.push(dependency)
      return () => {}
    },
  },
  get: () => undefined,
}

apply(ctx, {})

const seed = loadSeedCompanies()
const config = normalizeConfig({})
console.log(`seed boards: ${seed.length}`)
console.log(`dataDir: ${config.dataDir}`)
console.log(`tools (${registered.length}): ${registered.map((tool) => tool.name).join(', ')}`)

const problems = []
for (const tool of registered) {
  if (!tool.name || !tool.description) problems.push(`${tool.name}: name/description`)
  if (!tool.output || typeof tool.output.render !== 'function') problems.push(`${tool.name}: output.render`)
  if (!(tool.timeoutMs > 0)) problems.push(`${tool.name}: timeoutMs`)
}
if (registered.length !== 8) problems.push(`expected 8 tools, got ${registered.length}`)
console.log(problems.length ? `FAIL ${problems.join(' | ')}` : 'FAKE-CTX OK')
process.exitCode = problems.length ? 1 : 0
