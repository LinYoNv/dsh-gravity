/**
 * Simulate what the host does after a fresh install of this bundle.
 *
 * The point is to prove the install is self-sufficient: given only the bundle's
 * own `cordis.patch.yml`, the loader must end up with one entry whose plugin
 * module imports, whose `apply()` starts the gateway, and which writes its
 * provider row where the Models page can edit it.
 *
 * The real loader (`applyEntryPatches`) is reproduced from its documented
 * semantics rather than imported, because it lives inside the host asar.
 */

import { readFileSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'

const ROOT = resolve(import.meta.dirname, '..')
const require = createRequire(import.meta.url)

const results = []
async function check(name, fn) {
  try {
    await fn()
    results.push(`PASS  ${name}`)
  } catch (error) {
    results.push(`FAIL  ${name}\n        ${error?.message || error}`)
  }
}

function loadYaml() {
  for (const candidate of [
    'js-yaml',
    join(process.env.USERPROFILE ?? '', '.dsh', 'plugins', 'dsh-nai-image', 'test', '.fixtures', 'verify', 'node_modules', 'js-yaml'),
    join(process.env.HOME ?? '', '.dsh', 'profiles', 'web', 'node_modules', 'js-yaml'),
    '/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/js-yaml',
  ]) {
    try {
      return require(candidate)
    } catch {
      // next
    }
  }
  return undefined
}
const yaml = loadYaml()

/**
 * Apply a patch list to an entry list, exactly as the loader describes:
 * an `insert` without an id appends to the top level; an entry-targeted patch
 * merges its overrides onto the named entry; a patch matching nothing is skipped.
 * @param data - the starting entry list.
 * @param patches - the patch rows, in order.
 * @returns the patched entry list.
 */
function applyEntryPatches(data, patches) {
  const entries = structuredClone(data)
  const index = new Map()
  const build = (list) => {
    for (const entry of list) {
      if (entry.id) index.set(entry.id, entry)
      if (entry.group && Array.isArray(entry.config)) build(entry.config)
    }
  }
  build(entries)
  for (const patch of patches) {
    const { id, insert, name, ...overrides } = patch
    if (insert) {
      if (id) {
        const target = index.get(id)
        if (!target) continue
        if (!Array.isArray(target.config)) target.config = []
        target.config.push(...insert)
      } else {
        entries.push(...insert)
      }
      build(insert)
      continue
    }
    if (!id) continue
    const target = index.get(id)
    if (!target) continue
    Object.assign(target, overrides)
  }
  return entries
}

/** A context that records what the plugin does. */
function makeContext() {
  const state = { adapters: [], writes: [], effects: 0 }
  let llm
  const ctx = {
    fiber: { entry: { options: { id: 'dsh-linux13-gateway' } } },
    effect(fn) {
      state.effects += 1
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    on: () => () => {},
    get(service) {
      if (service === 'llm') return llm
      if (service === 'settings') return state.settings
      return undefined
    },
    logger: { warn: () => {}, error: () => {}, info: () => {} },
  }
  llm = {
    registerAdapter(providers, adapter) {
      state.adapters.push({ providers, adapter })
      const handle = () => {}
      handle.replace = () => {}
      return handle
    },
  }
  state.settings = {
    async mutate(ns, ops) {
      state.writes.push({ ns, ops })
      return {}
    },
  }
  return { ctx, state }
}

if (yaml === undefined) {
  console.log('SKIP  js-yaml unavailable')
  process.exit(0)
}

const bundlePatch = yaml.load(readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8'), { schema: yaml.JSON_SCHEMA })
const settle = () => new Promise((resolve) => setTimeout(resolve, 20))

await check('a bare profile gains exactly one entry from the bundle patch', () => {
  const entries = applyEntryPatches([], bundlePatch)
  assert.equal(entries.length, 1)
  assert.equal(entries[0].id, 'dsh-linux13-gateway')
  assert.equal(entries[0].name, './lib/index.js')
})

await check('the inserted entry carries a complete config', () => {
  const [entry] = applyEntryPatches([], bundlePatch)
  for (const key of ['enabled', 'displayName', 'apiKeyEnv', 'listenHost', 'listenPort', 'upstreamBaseUrl', 'presetMode', 'models']) {
    assert.ok(key in entry.config, `missing config key: ${key}`)
  }
})

await check('the plugin module imports from the package root', async () => {
  const modulePath = join(ROOT, 'lib', 'index.js')
  assert.ok(existsSync(modulePath), 'lib/index.js missing')
  const module = await import(pathToFileURL(modulePath).href)
  assert.equal(module.name, 'dsh-linux13-gateway')
  assert.equal(typeof module.apply, 'function')
  assert.deepEqual(module.inject, ['settings'])
})

await check('apply() publishes the provider row into llm-pi-ai', async () => {
  const [entry] = applyEntryPatches([], bundlePatch)
  const module = await import(pathToFileURL(join(ROOT, 'lib', 'index.js')).href)
  const { ctx, state } = makeContext()
  module.apply(ctx, entry.config)
  await settle()

  assert.equal(state.writes.length, 1, 'expected one settings write')
  assert.equal(state.writes[0].ns, 'llm-pi-ai')
  const [op] = state.writes[0].ops
  assert.equal(op.op, 'set')
  assert.deepEqual(op.path, ['providers', 'linux13-gateway'])
  assert.equal(op.value.displayName, 'linux网关')
  assert.match(op.value.baseURL, /^http:\/\/127\.0\.0\.1:8318\/v1$/)
  assert.equal(op.value.apiKeyEnv, 'LINUX13_GATEWAY_API_KEY')
})

await check('apply() never claims an adapter route', async () => {
  // llm-pi-ai claims one adapter per route in its provider table. Claiming it
  // here first is what once threw DUPLICATE_ADAPTER and blanked every provider.
  const [entry] = applyEntryPatches([], bundlePatch)
  const module = await import(pathToFileURL(join(ROOT, 'lib', 'index.js')).href)
  const { ctx, state } = makeContext()
  module.apply(ctx, entry.config)
  await settle()

  assert.equal(state.adapters.length, 0, 'the plugin must leave adapter ownership to llm-pi-ai')
})

await check('the bundle patch never overrides llm-pi-ai', () => {
  // A patch replaces the whole `config` of the entry it targets, so shipping an
  // `llm-pi-ai` override here would wipe every provider the user configured.
  // Assert on the parsed entries, not on the raw text: the comments explain the
  // rule and legitimately name the namespace.
  const entries = applyEntryPatches([], bundlePatch)
  const offending = entries.filter((entry) => /llm-pi-ai/.test(entry.id ?? '') || /llm-pi-ai/.test(entry.name ?? ''))
  assert.deepEqual(offending, [], 'bundle patch must not target llm-pi-ai')
})

console.log(results.join('\n'))
const failed = results.filter((row) => row.startsWith('FAIL')).length
console.log(`\n${results.length - failed}/${results.length} passed`)
process.exit(failed === 0 ? 0 : 1)
