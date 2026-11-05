/**
 * Simulate the whole `llm-pi-ai` registration path with this plugin's write in
 * place, to prove the two can coexist.
 *
 * This exists because of a real outage: the plugin used to register its own
 * adapter for `linux13-gateway` *and* write that route into pi-ai's provider
 * table. pi-ai then tried to register an adapter for the same route,
 * `registerAdapter` threw `DUPLICATE_ADAPTER`, pi-ai's `apply()` had no catch,
 * and the failure removed **every** provider the user had configured.
 *
 * The rules below are transcribed from `LlmRuntime.registerAdapter` and
 * `registerConfigurableProviders`. They are duplicated deliberately: the point
 * is to fail here, in a test, rather than on a user's machine.
 */

import assert from 'node:assert/strict'
import { apply, publishRoute, PROVIDER } from '../lib/index.js'

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
 * A stand-in for the host's `llm` service, enforcing the same two rules that
 * caused the outage: one adapter per route, one directory entry per route.
 */
function makeLlm() {
  const adapters = new Map()
  const directory = new Map()
  return {
    adapters,
    directory,
    registerAdapter(providers, adapter) {
      for (const provider of providers) {
        if (provider.length === 0) throw new Error('adapter provider names must be non-empty')
        if (adapters.has(provider)) {
          throw new Error(`an adapter for provider "${provider}" is already registered`)
        }
      }
      for (const provider of providers) adapters.set(provider, adapter)
      const handle = () => {
        for (const provider of providers) adapters.delete(provider)
      }
      handle.replace = () => {}
      return handle
    },
    registerConfigurableProviders(entries) {
      if (entries.length === 0) throw new Error('a registration must declare at least one provider')
      for (const entry of entries) {
        if (!entry.provider || !entry.displayName || !entry.settingsNs) {
          throw new Error('configurable providers need a non-empty provider, displayName, and settingsNs')
        }
        if (directory.has(entry.provider)) {
          throw new Error(`configurable provider "${entry.provider}" is already declared`)
        }
      }
      for (const entry of entries) directory.set(entry.provider, entry)
      const handle = () => {
        for (const entry of entries) directory.delete(entry.provider)
      }
      handle.replace = () => {}
      return handle
    },
  }
}

/**
 * What `llm-pi-ai` itself does once its provider table contains a route:
 * it claims an adapter for every route, then publishes a directory entry.
 * @param llm - the fake llm service.
 * @param providers - the provider table as the settings section holds it.
 */
function piAiApply(llm, providers) {
  const routes = Object.keys(providers)
  if (routes.length === 0) return
  llm.registerAdapter(routes, { providerInfo: (id) => ({ id, name: id }) })
  llm.registerConfigurableProviders(
    routes.map((route) => ({
      provider: route,
      displayName: providers[route].displayName ?? route,
      settingsNs: 'llm-pi-ai',
      settingsPath: ['providers', route],
      declared: true,
    })),
  )
}

/** A settings service over a mutable section. */
function makeSettings(section) {
  return {
    describe: () => [{ ns: 'llm-pi-ai', value: structuredClone(section) }],
    async mutate(ns, ops) {
      for (const op of ops) {
        if (op.op !== 'set') continue
        let cursor = section
        for (const key of op.path.slice(0, -1)) {
          if (typeof cursor[key] !== 'object' || cursor[key] === null) cursor[key] = {}
          cursor = cursor[key]
        }
        cursor[op.path.at(-1)] = op.value
      }
    },
  }
}

const baseConfig = {
  enabled: true,
  displayName: 'linux网关',
  apiKeyEnv: 'LINUX13_GATEWAY_API_KEY',
  listenHost: '127.0.0.1',
  listenPort: 18318,
  contextWindow: 1000000,
  models: 'deepseek-v4.1-flash',
  upstreamBaseUrl: 'http://127.0.0.1:9',
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 30))

await check('the plugin registers no adapter of its own', async () => {
  const llm = makeLlm()
  const section = { providers: {} }
  const ctx = {
    get: (name) => (name === 'settings' ? makeSettings(section) : name === 'llm' ? llm : undefined),
    effect: (fn) => {
      const d = fn()
      return typeof d === 'function' ? d : () => {}
    },
    on: () => () => {},
    logger: { warn: () => {} },
  }
  apply(ctx, baseConfig)
  await settle()
  assert.equal(llm.adapters.size, 0, 'the plugin must not claim an adapter route')
})

await check('pi-ai can claim the route after the plugin wrote it', async () => {
  const llm = makeLlm()
  const section = { providers: {} }
  const settings = makeSettings(section)
  const ctx = {
    get: (name) => (name === 'settings' ? settings : name === 'llm' ? llm : undefined),
    effect: (fn) => {
      const d = fn()
      return typeof d === 'function' ? d : () => {}
    },
    on: () => () => {},
    logger: { warn: () => {} },
  }

  apply(ctx, baseConfig)
  await settle()
  assert.ok(section.providers[PROVIDER], 'plugin did not write the route')

  // Now the whole pi-ai apply runs over the section that includes our route.
  assert.doesNotThrow(() => piAiApply(llm, section.providers), 'pi-ai would crash on our route')
  assert.ok(llm.adapters.has(PROVIDER), 'pi-ai should own the route now')
})

await check("the user's own providers keep working through pi-ai", async () => {
  const llm = makeLlm()
  const section = {
    providers: {
      cpa: { api: 'openai-responses', baseURL: 'http://example.invalid/v1', apiKeyEnv: 'CPA_API_KEY' },
      'xyuan-ds': { api: 'openai-responses', baseURL: 'http://other.invalid/v1', apiKeyEnv: 'XYUAN_DS_API_KEY' },
    },
  }
  const ctx = {
    get: (name) => (name === 'settings' ? makeSettings(section) : name === 'llm' ? llm : undefined),
    effect: (fn) => {
      const d = fn()
      return typeof d === 'function' ? d : () => {}
    },
    on: () => () => {},
    logger: { warn: () => {} },
  }

  apply(ctx, baseConfig)
  await settle()

  assert.doesNotThrow(() => piAiApply(llm, section.providers))
  assert.deepEqual([...llm.adapters.keys()].sort(), ['cpa', 'gravity', 'xyuan-ds'])
  assert.deepEqual([...llm.directory.keys()].sort(), ['cpa', 'gravity', 'xyuan-ds'])
})

await check('reloading the plugin does not double-register anything', async () => {
  const llm = makeLlm()
  const section = { providers: { cpa: { api: 'openai-responses', baseURL: 'http://x/v1' } } }
  const settings = makeSettings(section)
  const ctx = {
    get: (name) => (name === 'settings' ? settings : name === 'llm' ? llm : undefined),
    effect: (fn) => {
      const d = fn()
      return typeof d === 'function' ? d : () => {}
    },
    on: () => () => {},
    logger: { warn: () => {} },
  }

  apply(ctx, baseConfig)
  await settle()
  piAiApply(llm, section.providers)

  // A second publish runs on every settings change; it must be a no-op.
  await publishRoute(ctx, () => ({
    ...{
      displayName: 'linux网关',
      apiKeyEnv: 'LINUX13_GATEWAY_API_KEY',
      listenHost: '127.0.0.1',
      listenPort: 18318,
      contextWindow: 1000000,
      models: [{ id: 'deepseek-v4.1-flash', name: 'x', contextWindow: 1000000 }],
    },
  }))
  assert.equal(Object.keys(section.providers).length, 2, 'a second publish must not add a row')
  assert.equal(llm.adapters.size, 2, 'no duplicate adapter registration')
})

await check('a route the user renamed still resolves', async () => {
  const llm = makeLlm()
  const section = {
    providers: {
      'gravity': {
        displayName: '我的网关',
        api: 'openai-completions',
        baseURL: 'http://127.0.0.1:18318/v1',
        apiKeyEnv: 'MY_REF',
        models: [{ id: 'custom-model' }],
      },
    },
  }
  const ctx = {
    get: (name) => (name === 'settings' ? makeSettings(section) : name === 'llm' ? llm : undefined),
    effect: (fn) => {
      const d = fn()
      return typeof d === 'function' ? d : () => {}
    },
    on: () => () => {},
    logger: { warn: () => {} },
  }

  await publishRoute(ctx, () => ({
    displayName: 'linux网关',
    apiKeyEnv: 'LINUX13_GATEWAY_API_KEY',
    listenHost: '127.0.0.1',
    listenPort: 18318,
    contextWindow: 1000000,
    models: [{ id: 'deepseek-v4.1-flash' }],
  }))

  assert.equal(section.providers['gravity'].displayName, '我的网关')
  assert.equal(section.providers['gravity'].apiKeyEnv, 'MY_REF')
  assert.doesNotThrow(() => piAiApply(llm, section.providers))
})

console.log(results.join('\n'))
const failed = results.filter((row) => row.startsWith('FAIL')).length
console.log(`\n${results.length - failed}/${results.length} passed`)
process.exit(failed === 0 ? 0 : 1)
