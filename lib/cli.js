#!/usr/bin/env node
/**
 * Standalone CLI runner for `dsh-linux13-gateway`.
 *
 * Usage:
 *   node lib/cli.js [--host 127.0.0.1] [--port 8318] [--upstream http://127.0.0.1:8317]
 *                   [--markers "<output_contract>,<Role_Profile>,*"] [--window 32]
 *                   [--retries 2] [--cloak-tools "nai_generate_image,draw_image"]
 *                   [--memory-url "http://127.0.0.1:9129/prefetch"] [--verbose]
 */

import { DEFAULT_OPTIONS } from './engine.js'
import { createGatewayServer } from './server.js'

function parseCliArgs(argv) {
  const opts = {
    listenHost: process.env.LINUX13_HOST || '127.0.0.1',
    listenPort: Number(process.env.LINUX13_PORT || 8318),
    upstreamBaseUrl: process.env.LINUX13_UPSTREAM || DEFAULT_OPTIONS.upstreamBaseUrl,
    activationMarkers: process.env.LINUX13_MARKERS || DEFAULT_OPTIONS.activationMarkers.join(','),
    historyWindow: Number(process.env.LINUX13_WINDOW || DEFAULT_OPTIONS.historyWindow),
    maxRefusalRetries: Number(process.env.LINUX13_RETRIES ?? DEFAULT_OPTIONS.maxRefusalRetries),
    cloakedImageTools: process.env.LINUX13_CLOAK_TOOLS || DEFAULT_OPTIONS.cloakedImageTools.join(','),
    memoryPrefetchUrl: process.env.LINUX13_MEMORY_URL || '',
    verbose: process.env.LINUX13_VERBOSE === '1' || process.env.LINUX13_VERBOSE === 'true',
  }

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '-h' || a === '--help') {
      console.log(`Usage: linux13-gateway [options]

Options:
  --host <ip>            Listen address (default: 127.0.0.1, env: LINUX13_HOST)
  --port <port>          Listen port (default: 8318, env: LINUX13_PORT)
  --upstream <url>       Upstream OpenAI-compatible base URL (default: http://127.0.0.1:8317, env: LINUX13_UPSTREAM)
  --markers <csv>        System prompt markers triggering the tunnel, or "*" for all (env: LINUX13_MARKERS)
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
    else if (a === '--markers' && argv[i + 1]) opts.activationMarkers = argv[++i]
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
  `[linux13-gateway] listening on http://${cliOpts.listenHost}:${boundPort} -> ${cliOpts.upstreamBaseUrl}`,
)

const shutdown = async () => {
  await gw.close()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
