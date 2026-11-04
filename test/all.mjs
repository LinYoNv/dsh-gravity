#!/usr/bin/env node
/**
 * Run every test suite and report one summary.
 *
 * Each suite is a standalone script so it can also be run alone while working on
 * one area. This runner exists for the `npm test` entry point and for CI: it
 * exits non-zero if any suite fails, and it keeps going after a failure so one
 * broken area does not hide the state of the others.
 */

import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

/** Suites in dependency order: the gateway first, then what wraps it. */
const SUITES = ['e2e', 'tools', 'plugin', 'config', 'install', 'profile', 'coexist']

const rows = []
let failed = 0

for (const suite of SUITES) {
  const file = join(HERE, `${suite}.mjs`)
  const run = spawnSync(process.execPath, [file], { encoding: 'utf8' })
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`
  const summary = output.split('\n').find((line) => /^\d+\/\d+ passed$/.test(line.trim())) ?? 'no summary'
  const ok = run.status === 0
  if (!ok) failed += 1
  rows.push(`${ok ? 'PASS' : 'FAIL'}  ${suite.padEnd(10)} ${summary}`)
  if (!ok) {
    // Print the failing suite's tail so the cause is visible without a rerun.
    const tail = output.trim().split('\n').slice(-12).join('\n')
    rows.push(tail.replace(/^/gm, '      '))
  }
}

console.log(rows.join('\n'))
console.log(`\n${SUITES.length - failed}/${SUITES.length} suites passed`)
process.exit(failed === 0 ? 0 : 1)
