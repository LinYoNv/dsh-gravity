/**
 * Prove the written profile survives the host's own validation.
 *
 * The plugin writes a provider row into `llm-pi-ai`'s section. That section is
 * validated by `resolveProfiles`, which rejects a handful of shapes outright —
 * an array instead of a dict, a `provider` key inside the value, a removed
 * `maxRetries`, an empty `baseURL`, an empty `displayName`. Getting any of those
 * wrong turns the whole section invalid and takes the user's other providers
 * down with it, so the shape is checked here against a reimplementation of the
 * rules read from the host.
 *
 * `resolveProfiles` itself lives inside the asar and cannot be imported in a
 * plain Node process, so the rules are restated rather than reimplemented ad
 * hoc: every assertion below corresponds to one throw statement in the host.
 */

import assert from 'node:assert/strict'
import { publishRoute } from '../lib/index.js'

const results = []
async function check(name, fn) {
  try {
    await fn()
    results.push(`PASS  ${name}`)
  } catch (error) {
    results.push(`FAIL  ${name}\n        ${error?.message || error}`)
  }
}

/** Capture what the plugin writes, with a `describe` that reflects the section. */
function captureContext(seed = { providers: {} }) {
  const section = structuredClone(seed)
  const ctx = {
    get: (name) =>
      name === 'settings'
        ? {
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
        : undefined,
    logger: { warn: () => {} },
  }
  return { ctx, section }
}

const config = (over = {}) => () => ({
  enabled: true,
  displayName: 'linux网关',
  apiKeyEnv: 'LINUX13_GATEWAY_API_KEY',
  listenHost: '127.0.0.1',
  listenPort: 8318,
  contextWindow: 1000000,
  models: [{ id: 'deepseek-v4.1-flash', name: 'deepseek-v4.1-flash', contextWindow: 1000000 }],
  upstreamBaseUrl: 'http://x',
  ...over,
})

/**
 * The checks `resolveProfiles` performs before a section is accepted.
 * @param providers - the providers dict as stored.
 * @returns the first violation, or `undefined` when the section is acceptable.
 */
function firstViolation(providers) {
  if (Array.isArray(providers)) return 'providers must be a dict, not an array'
  for (const [route, source] of Object.entries(providers ?? {})) {
    if (route.length === 0) return 'empty provider name'
    if (source === null || typeof source !== 'object') return `${route}: not an object`
    if ('provider' in source) return `${route}: sets "provider", which belongs in the dict key`
    if ('maxRetries' in source || 'maxRetryDelayMs' in source) return `${route}: sets a removed retry field`
    if (source.baseURL !== undefined && String(source.baseURL).length === 0) return `${route}: empty baseURL`
    if (source.displayName !== undefined && String(source.displayName).length === 0) return `${route}: empty displayName`
    if (source.models !== undefined && !Array.isArray(source.models)) return `${route}: models must be an array`
  }
  return undefined
}

await check('the written section passes the host validation rules', async () => {
  const { ctx, section } = captureContext()
  await publishRoute(ctx, config())
  const violation = firstViolation(section.providers)
  assert.equal(violation, undefined, `section would be rejected: ${violation}`)
})

await check('the profile sets the protocol the gateway actually speaks', async () => {
  const { ctx, section } = captureContext()
  await publishRoute(ctx, config())
  const profile = section.providers['gravity']
  assert.equal(profile.api, 'openai-completions')
})

await check('the profile carries the credential reference, not a credential', async () => {
  const { ctx, section } = captureContext()
  await publishRoute(ctx, config())
  const profile = section.providers['gravity']
  assert.equal(profile.apiKeyEnv, 'LINUX13_GATEWAY_API_KEY')
  assert.ok(!('apiKey' in profile), 'the section must never hold the key itself')
  assert.ok(!('token' in profile), 'the section must never hold a token')
})

await check('models entries carry id, name and a numeric context window', async () => {
  const { ctx, section } = captureContext()
  await publishRoute(ctx, config())
  const [model] = section.providers['gravity'].models
  assert.equal(model.id, 'deepseek-v4.1-flash')
  assert.equal(model.name, 'deepseek-v4.1-flash')
  assert.ok(Number.isInteger(model.contextWindow) && model.contextWindow > 0)
})

await check('a section with other providers stays valid after the write', async () => {
  const { ctx, section } = captureContext({
    providers: {
      cpa: { api: 'openai-responses', baseURL: 'http://example.invalid/v1', apiKeyEnv: 'CPA_API_KEY' },
      'xyuan-ds': { api: 'openai-responses', baseURL: 'http://other.invalid/v1', apiKeyEnv: 'XYUAN_DS_API_KEY' },
    },
  })
  await publishRoute(ctx, config())
  assert.equal(firstViolation(section.providers), undefined)
  assert.deepEqual(Object.keys(section.providers).sort(), ['cpa', 'gravity', 'xyuan-ds'])
})

await check('an empty model list still produces a writable profile', async () => {
  const { ctx, section } = captureContext()
  await publishRoute(ctx, config({ models: [] }))
  assert.equal(firstViolation(section.providers), undefined)
  assert.deepEqual(section.providers['gravity'].models, [])
})

await check('a port other than 8318 reaches the profile', async () => {
  const { ctx, section } = captureContext()
  await publishRoute(ctx, config({ listenPort: 9001 }))
  assert.equal(section.providers['gravity'].baseURL, 'http://127.0.0.1:9001/v1')
})

await check('an existing route is never overwritten', async () => {
  // The user may have edited the endpoint or picked a different model on the
  // Models page; a plugin reload must not silently undo that.
  const existing = {
    providers: {
      'gravity': {
        displayName: '我自己起的名字',
        api: 'openai-completions',
        baseURL: 'http://127.0.0.1:9999/v1',
        apiKeyEnv: 'MY_OWN_REF',
        models: [{ id: 'my-model', name: 'my-model' }],
      },
    },
  }
  const { ctx, section } = captureContext(existing)
  await publishRoute(ctx, config())
  assert.deepEqual(section.providers['gravity'], existing.providers['gravity'])
})

await check('a route without a credential reference gets one filled in', async () => {
  const existing = {
    providers: {
      'gravity': { displayName: 'x', api: 'openai-completions', baseURL: 'http://127.0.0.1:8318/v1' },
    },
  }
  const { ctx, section } = captureContext(existing)
  await publishRoute(ctx, config())
  const profile = section.providers['gravity']
  assert.equal(profile.apiKeyEnv, 'LINUX13_GATEWAY_API_KEY')
  // Everything else the user had stays put.
  assert.equal(profile.baseURL, 'http://127.0.0.1:8318/v1')
  assert.equal(profile.displayName, 'x')
})

console.log(results.join('\n'))
const failed = results.filter((row) => row.startsWith('FAIL')).length
console.log(`\n${results.length - failed}/${results.length} passed`)
process.exit(failed === 0 ? 0 : 1)
