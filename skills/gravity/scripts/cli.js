#!/usr/bin/env node
/**
 * Standalone CLI runner for `dsh-gravity` (v2.0 — Kunlun 1.2r + Linux 1.3).
 */

import { DEFAULT_OPTIONS } from './engine.js'
import { createGatewayServer } from './server.js'

function parseCliArgs(argv) {
  const opts = {
    listenHost: process.env.GRAVITY_HOST || process.env.LINUX13_HOST || '127.0.0.1',
    listenPort: Number(process.env.GRAVITY_PORT || process.env.LINUX13_PORT || 8318),
    upstreamBaseUrl: process.env.GRAVITY_UPSTREAM || process.env.LINUX13_UPSTREAM || DEFAULT_OPTIONS.upstreamBaseUrl,
    presetMode: process.env.GRAVITY_PRESET_MODE || process.env.LINUX13_PRESET_MODE || DEFAULT_OPTIONS.presetMode,
    activationMarkers: process.env.GRAVITY_MARKERS || process.env.LINUX13_MARKERS || '*',
    enableBuiltinArmor: process.env.LINUX13_BUILTIN_ARMOR !== '0' && process.env.LINUX13_BUILTIN_ARMOR !== 'false',
    styleMode: process.env.LINUX13_STYLE_MODE || 'auto',
    personaFile: process.env.GRAVITY_PERSONA_FILE || process.env.LINUX13_PERSONA_FILE || '',
    stripCodingBoilerplate: process.env.LINUX13_STRIP_BOILERPLATE !== '0',
    historyWindow: Number(process.env.LINUX13_WINDOW || DEFAULT_OPTIONS.historyWindow),
    maxRefusalRetries: Number(process.env.LINUX13_RETRIES ?? DEFAULT_OPTIONS.maxRefusalRetries),
    cloakedImageTools: process.env.LINUX13_CLOAK_TOOLS || DEFAULT_OPTIONS.cloakedImageTools.join(','),
    memoryPrefetchUrl: process.env.LINUX13_MEMORY_URL || '',
    verbose: process.env.LINUX13_VERBOSE === '1' || process.env.LINUX13_VERBOSE === 'true',
  }

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '-h' || a === '--help') {
      console.log(`Usage: gravity [options]

Options:
  --host <ip>            Listen address (default: 127.0.0.1, env: LINUX13_HOST)
  --port <port>          Listen port (default: 8318, env: LINUX13_PORT)
  --upstream <url>       Upstream OpenAI-compatible base URL (default: http://127.0.0.1:8317, env: LINUX13_UPSTREAM)
  --preset-mode <mode>   Preset engine: "kunlun_1.2r" (default) or "linux_1.3" (env: LINUX13_PRESET_MODE)
  --markers <csv>        Markers triggering tunnel, default "*" for all chat turns (env: LINUX13_MARKERS)
  --no-builtin-armor     Disable automatic <output_contract> armor-breaking header
  --style-mode <mode>    Style adaptation: "auto" (default), "chat" (short/first-person RP), or "novel"
  --persona-file <path>  Optional path to external .txt/.md persona file to inject automatically
  --window <n>           Max historical turns packed into archive (default: 32, env: LINUX13_WINDOW)
  --retries <n>          Max automatic fresh-roll retries on refusal (default: 2, env: LINUX13_RETRIES)
  --cloak-tools <csv>    Image tool names cloaked on wire (env: LINUX13_CLOAK_TOOLS)
  --memory-url <url>     Optional memory prefetch endpoint (env: LINUX13_MEMORY_URL)
  --verbose              Print per-request diagnostic logs
  -h, --help             Show this help message`)
      process.exit(0)
    }
    if (a === '--host' && argv[i + 1]) opts.listenHost = argv[++i]
    else if (a === '--port' && argv[i + 1]) opts.listenPort = Number(argv[++i])
    else if (a === '--upstream' && argv[i + 1]) opts.upstreamBaseUrl = argv[++i]
    else if (a === '--preset-mode' && argv[i + 1]) opts.presetMode = argv[++i]
    else if (a === '--markers' && argv[i + 1]) opts.activationMarkers = argv[++i]
    else if (a === '--no-builtin-armor') opts.enableBuiltinArmor = false
    else if (a === '--style-mode' && argv[i + 1]) opts.styleMode = argv[++i]
    else if (a === '--persona-file' && argv[i + 1]) opts.personaFile = argv[++i]
    else if (a === '--window' && argv[i + 1]) opts.historyWindow = Number(argv[++i])
    else if (a === '--retries' && argv[i + 1]) opts.maxRefusalRetries = Number(argv[++i])
    else if (a === '--cloak-tools' && argv[i + 1]) opts.cloakedImageTools = argv[++i]
    else if (a === '--memory-url' && argv[i + 1]) opts.memoryPrefetchUrl = argv[++i]
    else if (a === '--verbose') opts.verbose = true
  }
  return opts
}

const cliOpts = parseCliArgs(process.argv.slice(2))
const gw = createGatewayServer(cliOpts)

const boundPort = await gw.listen(cliOpts.listenPort, cliOpts.listenHost)
console.log(
  `[gravity] v2.0 (${cliOpts.presetMode}) listening on http://${cliOpts.listenHost}:${boundPort} -> ${cliOpts.upstreamBaseUrl}`,
)

const shutdown = async () => {
  await gw.close()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
