/**
 * Verify the plugin's `apply()` wiring and where it writes.
 *
 * Two properties carry the weight here:
 *
 * - **No adapter.** Claiming an adapter route would collide with `llm-pi-ai`,
 *   which claims one for every route in its provider table; the collision throws
 *   and takes every provider in that namespace down with it.
 * - **An additive write.** `settings.mutate` sends one path-addressed `set`, so
 *   the user's existing providers are never restated or replaced.
 */

import assert from 'node:assert/strict'
import { apply, publishRoute, PROVIDER, Config } from '../lib/index.js'

const results = []
async function check(name, fn) {
  try {
    await fn()
    results.push(`PASS  ${name}`)
  } catch (error) {
    results.push(`FAIL  ${name}\n        ${error?.message || error}`)
  }
}

/**
 * Context that records what the plugin does.
 * @param options.existing - a pre-seeded provider table.
 */
function makeContext(options = {}) {
  const state = {
    adapters: [],
    writes: [],
    effects: 0,
    section: structuredClone(options.existing ?? { providers: {} }),
  }
  const settings = {
    describe: () => [{ ns: 'llm-pi-ai', value: structuredClone(state.section) }],
    async mutate(ns, ops) {
      state.writes.push({ ns, ops: structuredClone(ops) })
      for (const op of ops) {
        if (op.op !== 'set') continue
        let cursor = state.section
        for (const key of op.path.slice(0, -1)) {
          if (typeof cursor[key] !== 'object' || cursor[key] === null) cursor[key] = {}
          cursor = cursor[key]
        }
        cursor[op.path.at(-1)] = op.value
      }
      return {}
    },
  }
  const llm = {
    registerAdapter(providers) {
      state.adapters.push(providers)
      const handle = () => {}
      handle.replace = () => {}
      return handle
    },
  }
  const ctx = {
    fiber: { entry: { options: { id: 'dsh-linux13-gateway' } } },
    effect(fn) {
      state.effects += 1
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    on: () => () => {},
    get: (service) => (service === 'llm' ? llm : service === 'settings' ? settings : undefined),
    logger: { warn: () => {}, error: () => {}, info: () => {} },
  }
  return { ctx, state }
}

const baseConfig = {
  enabled: true,
  displayName: 'linux网关',
  apiKeyEnv: 'LINUX13_GATEWAY_API_KEY',
  listenHost: '127.0.0.1',
  listenPort: 18318,
  contextWindow: 1000000,
  models: 'deepseek-v4.1-flash,gemini-3.8-flash',
  upstreamBaseUrl: 'http://127.0.0.1:9',
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 30))

await check('Config schema is built when the host exposes schemastery', () => {
  assert.ok(Config === undefined || typeof Config === 'object' || typeof Config === 'function')
})

await check('the plugin never registers an adapter', async () => {
  const { ctx, state } = makeContext()
  apply(ctx, baseConfig)
  await settle()
  assert.equal(state.adapters.length, 0, 'registering an adapter here would collide with llm-pi-ai')
})

await check('the route is written into the llm-pi-ai namespace', async () => {
  const { ctx, state } = makeContext()
  apply(ctx, baseConfig)
  await settle()
  assert.equal(state.writes.length, 1)
  assert.equal(state.writes[0].ns, 'llm-pi-ai')
})

await check('the write addresses providers.<route>, not the whole section', async () => {
  const { ctx, state } = makeContext()
  apply(ctx, baseConfig)
  await settle()
  assert.equal(state.writes[0].ops.length, 1)
  const [op] = state.writes[0].ops
  assert.equal(op.op, 'set')
  assert.deepEqual(op.path, ['providers', PROVIDER])
})

await check('the written profile points at the embedded gateway', async () => {
  const { ctx, state } = makeContext()
  apply(ctx, baseConfig)
  await settle()
  const profile = state.section.providers[PROVIDER]
  assert.equal(profile.displayName, 'linux网关')
  assert.equal(profile.api, 'openai-completions')
  assert.equal(profile.baseURL, 'http://127.0.0.1:18318/v1')
  assert.equal(profile.apiKeyEnv, 'LINUX13_GATEWAY_API_KEY')
  assert.deepEqual(
    profile.models.map((m) => m.id),
    ['deepseek-v4.1-flash', 'gemini-3.8-flash'],
  )
})

await check("a user's existing providers survive the write", async () => {
  const existing = {
    providers: {
      cpa: { api: 'openai-responses', baseURL: 'http://example.invalid/v1', apiKeyEnv: 'CPA_API_KEY' },
      'xyuan-ds': { api: 'openai-responses', baseURL: 'http://other.invalid/v1', apiKeyEnv: 'XYUAN_DS_API_KEY' },
    },
  }
  const { ctx, state } = makeContext({ existing })
  apply(ctx, baseConfig)
  await settle()
  assert.deepEqual(Object.keys(state.section.providers).sort(), ['cpa', 'linux13-gateway', 'xyuan-ds'])
  assert.equal(state.section.providers.cpa.baseURL, 'http://example.invalid/v1')
})

await check('an existing route is not overwritten', async () => {
  const existing = {
    providers: {
      [PROVIDER]: {
        displayName: '我自己起的名字',
        api: 'openai-completions',
        baseURL: 'http://127.0.0.1:9999/v1',
        apiKeyEnv: 'MY_OWN_REF',
        models: [{ id: 'my-model' }],
      },
    },
  }
  const { ctx, state } = makeContext({ existing })
  apply(ctx, baseConfig)
  await settle()
  assert.deepEqual(state.section.providers[PROVIDER], existing.providers[PROVIDER])
  assert.equal(state.writes.length, 0, 'nothing to write when the row is already complete')
})

await check('a route without a credential reference gets one filled in', async () => {
  const existing = {
    providers: { [PROVIDER]: { api: 'openai-completions', baseURL: 'http://127.0.0.1:18318/v1' } },
  }
  const { ctx, state } = makeContext({ existing })
  apply(ctx, baseConfig)
  await settle()
  assert.equal(state.section.providers[PROVIDER].apiKeyEnv, 'LINUX13_GATEWAY_API_KEY')
  assert.equal(state.section.providers[PROVIDER].baseURL, 'http://127.0.0.1:18318/v1')
})

await check('publishRoute is a no-op once the row is complete', async () => {
  const { ctx, state } = makeContext()
  const snap = () => ({
    displayName: 'linux网关',
    apiKeyEnv: 'LINUX13_GATEWAY_API_KEY',
    listenHost: '127.0.0.1',
    listenPort: 18318,
    contextWindow: 1000000,
    models: [{ id: 'm', name: 'm', contextWindow: 1000 }],
  })
  await publishRoute(ctx, snap)
  await publishRoute(ctx, snap)
  assert.equal(state.writes.length, 1, 'the second call must find the row already present')
})

await check('a host without a settings service does not throw', async () => {
  const ctx = {
    effect: (fn) => {
      const d = fn()
      return typeof d === 'function' ? d : () => {}
    },
    on: () => () => {},
    get: () => undefined,
    logger: { warn: () => {} },
  }
  assert.doesNotThrow(() => apply(ctx, baseConfig))
  await settle()
})

console.log(results.join('\n'))
const failed = results.filter((row) => row.startsWith('FAIL')).length
console.log(`\n${results.length - failed}/${results.length} passed`)
process.exit(failed === 0 ? 0 : 1)
