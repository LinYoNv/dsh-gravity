/**
 * Check that the shipped patches produce a configuration the plugin's own
 * reader accepts, and that the two config surfaces agree.
 *
 * The bundle patch is what a fresh install applies; the profile patch is the
 * user's override layer. Both are read here with the real `readConfigSnapshot`,
 * so a field renamed in `schema.js` but left stale in a YAML file fails loudly.
 */

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { readConfigSnapshot } from '../lib/schema.js'

const require = createRequire(import.meta.url)
const ROOT = join(import.meta.dirname, '..')

/**
 * Files the skill ships as copies of `lib/`.
 *
 * The skill is a self-contained directory a user may copy elsewhere, so it cannot
 * import from `lib/`. The duplication is deliberate; the drift is not.
 */
const MIRRORED = ['engine.js', 'server.js', 'cli.js']

/**
 * Resolve `js-yaml` from wherever it exists.
 *
 * The package ships no dependencies, so the module is borrowed from the host or
 * from a sibling plugin's fixture tree. When none is reachable the YAML-shape
 * assertions are skipped instead of failing, because the point of this file is
 * to catch a renamed field — not to police the machine's module layout.
 * @returns the js-yaml module, or `undefined`.
 */
function loadYaml() {
  const candidates = [
    'js-yaml',
    join(process.env.USERPROFILE ?? '', '.dsh', 'plugins', 'dsh-nai-image', 'test', '.fixtures', 'verify', 'node_modules', 'js-yaml'),
    join(process.env.USERPROFILE ?? '', '.dsh', 'profiles', 'desktop', 'node_modules', 'js-yaml'),
  ]
  for (const candidate of candidates) {
    try {
      return require(candidate)
    } catch {
      // Try the next candidate.
    }
  }
  return undefined
}

const yaml = loadYaml()

const BUNDLE = 'cordis.patch.yml'
const PROFILE = join(process.env.USERPROFILE ?? '', '.dsh', 'profiles', 'desktop', 'cordis.patch.yml')

const results = []
async function check(name, fn) {
  try {
    await fn()
    results.push(`PASS  ${name}`)
  } catch (error) {
    results.push(`FAIL  ${name}\n        ${error?.message || error}`)
  }
}

/** Parse one YAML document with the loader's JSON-only schema. */
function parse(file) {
  return yaml.load(readFileSync(file, 'utf8'), { schema: yaml.JSON_SCHEMA })
}

if (yaml === undefined) {
  // Without a YAML parser only the pure-function cases can run.
  const snap = readConfigSnapshot({ models: 'a,b', upstreamBaseUrl: 'http://x/v1' })
  assert.deepEqual(snap.models.map((m) => m.id), ['a', 'b'])
  console.log('SKIP  js-yaml unavailable — YAML-shape assertions skipped')
  console.log('PASS  readConfigSnapshot model splitting')
  console.log('\n1/1 passed')
  process.exit(0)
}

await check('bundle patch parses and inserts the gateway entry', () => {
  const doc = parse(BUNDLE)
  assert.ok(Array.isArray(doc))
  const insert = doc.find((row) => row.insert)
  assert.ok(insert, 'no insert row')
  const entry = insert.insert.find((row) => row.id === 'dsh-linux13-gateway')
  assert.ok(entry, 'gateway entry missing')
  assert.equal(entry.name, './lib/index.js')
  assert.ok(!('id' in entry === false), 'entry needs an id')
})

await check('bundle config survives readConfigSnapshot unchanged', () => {
  const entry = parse(BUNDLE)
    .find((row) => row.insert)
    .insert.find((row) => row.id === 'dsh-linux13-gateway')
  const snap = readConfigSnapshot(entry.config)
  assert.equal(snap.enabled, true)
  assert.equal(snap.displayName, 'linux网关')
  assert.equal(snap.apiKeyEnv, 'LINUX13_GATEWAY_API_KEY')
  assert.equal(snap.listenPort, 8318)
  assert.equal(snap.presetMode, 'linux_1.3')
  assert.equal(snap.enableBuiltinArmor, true)
  assert.deepEqual(snap.models.map((m) => m.id), ['deepseek-v4.1-flash'])
  assert.equal(snap.models[0].contextWindow, 1000000)
})

await check('models is a comma-separated string, matching the schema', () => {
  const entry = parse(BUNDLE)
    .find((row) => row.insert)
    .insert.find((row) => row.id === 'dsh-linux13-gateway')
  assert.equal(typeof entry.config.models, 'string', `models must be a string, got ${typeof entry.config.models}`)
})

await check('a multi-model string yields one entry each', () => {
  const snap = readConfigSnapshot({ models: 'a-model, b-model ,c-model' })
  assert.deepEqual(snap.models.map((m) => m.id), ['a-model', 'b-model', 'c-model'])
})

await check('an empty model list falls back to the default', () => {
  const snap = readConfigSnapshot({ models: '   ' })
  assert.equal(snap.models.length, 1)
  assert.equal(snap.models[0].id, 'deepseek-v4.1-flash')
})

await check('every volatile schema field has a control in the settings form', () => {
  // A `.volatile()` field with no form row is invisible in the GUI — the user
  // can neither see the default nor change it — and the omission is silent.
  // Parsing both sources keeps that coupling honest.
  const schemaSource = readFileSync(join(import.meta.dirname, '..', 'lib', 'schema.js'), 'utf8')
  const clientSource = readFileSync(join(import.meta.dirname, '..', 'lib', 'client.js'), 'utf8')

  const schemaBlock = schemaSource.slice(schemaSource.indexOf('return z.object({'))
  const fields = [...schemaBlock.matchAll(/^\s{4}(\w+):\s*(?:boolOrText|z\.)/gm)].map((m) => m[1])
  const formFields = new Set([...clientSource.matchAll(/\['(\w+)',\s*'(?:text|number)'\]/g)].map((m) => m[1]))

  assert.ok(fields.length > 5, `schema field scan found only ${fields.length}`)
  const missing = fields.filter((name) => !formFields.has(name))
  assert.deepEqual(missing, [], `schema fields with no form control: ${missing.join(', ')}`)
})

await check('the skill ships byte-identical copies of the runtime modules', () => {
  // The skill directory is meant to be copyable on its own, so it carries its own
  // engine/server/cli instead of importing from lib/. A stale copy would make the
  // skill behave differently from the plugin — quietly, and only on that path.
  for (const file of MIRRORED) {
    const source = readFileSync(join(ROOT, 'lib', file))
    const mirror = readFileSync(join(ROOT, 'skills', 'linux13-gateway', 'scripts', file))
    assert.ok(source.equals(mirror), `skills/linux13-gateway/scripts/${file} is stale; re-copy it from lib/`)
  }
})

await check('the declared version agrees across the manifest, README and changelog', () => {
  // A version that drifts between files is how `/health` once reported 2.0.0 for
  // a 2.1.0 package. `/health` now reads the manifest, so the remaining risk is
  // documentation claiming a release that does not exist.
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/)

  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8')
  const heading = readme.match(/^# .+? v(\d+\.\d+)/m)
  assert.ok(heading, 'README title carries no version')
  assert.equal(heading[1], pkg.version.split('.').slice(0, 2).join('.'), 'README version is stale')

  const changelog = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8')
  const newest = changelog.match(/^## \[(\d+\.\d+\.\d+)\]/m)
  assert.ok(newest, 'CHANGELOG has no released section')
  assert.equal(newest[1], pkg.version, 'CHANGELOG newest entry is not the released version')

  assert.ok(pkg.files.includes('CHANGELOG.md'), 'CHANGELOG must ship with the package')
})

await check('profile patch overrides only what it names', () => {
  let doc
  try {
    doc = parse(PROFILE)
  } catch {
    // The profile is a live user file; skipping is honest when absent.
    return
  }
  const override = doc.find((row) => row.id === 'dsh-linux13-gateway')
  if (override === undefined) return
  const merged = {
    ...parse(BUNDLE).find((row) => row.insert).insert.find((row) => row.id === 'dsh-linux13-gateway').config,
    ...override.config,
  }
  const snap = readConfigSnapshot(merged)
  assert.equal(snap.enabled, true, 'enabled must survive the override')
  assert.equal(snap.listenPort, 8318, 'port must survive the override')
  assert.ok(snap.upstreamBaseUrl.length > 0, 'upstream must be set')
})

await check('unknown keys are ignored rather than fatal', () => {
  const snap = readConfigSnapshot({ ...parse(BUNDLE).find((r) => r.insert).insert[0].config, futureField: 'x' })
  assert.equal(snap.enabled, true)
  assert.ok(!('futureField' in snap))
})

console.log(results.join('\n'))
const failed = results.filter((row) => row.startsWith('FAIL')).length
console.log(`\n${results.length - failed}/${results.length} passed`)
process.exit(failed === 0 ? 0 : 1)
