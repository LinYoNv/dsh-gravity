/**
 * DSH Host Plugin Entrypoint (`dsh-linux13-gateway`).
 *
 * 1. Auto-registers the bundled `linux13-gateway` skill into `$DSH_HOME/skills/linux13-gateway`
 *    so any DSH session can invoke `skill({ name: "linux13-gateway" })`.
 * 2. Starts the embedded Linux 1.3 ToolCall Tunnel HTTP server inside `ctx.effect()`,
 *    or cleanly coexists if an external `linux13-gateway` service already owns the port.
 * 3. Reads volatile Config fields dynamically on every request so GUI edits take effect
 *    immediately without restarting DSH.
 */

import { existsSync, lstatSync, mkdirSync, symlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildConfig, readConfigSnapshot } from './schema.js'
import { createGatewayServer } from './server.js'

export const name = 'dsh-linux13-gateway'
export const Config = buildConfig()

const __dirname = dirname(fileURLToPath(import.meta.url))
const BUNDLED_SKILL_DIR = join(__dirname, '..', 'skills', 'linux13-gateway')

function ensureSkillLinked() {
  try {
    if (!existsSync(BUNDLED_SKILL_DIR)) return
    const dshHome = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
    const skillsRoot = join(dshHome, 'skills')
    mkdirSync(skillsRoot, { recursive: true })
    const targetLink = join(skillsRoot, 'linux13-gateway')
    try {
      lstatSync(targetLink)
      return
    } catch {
      // Does not exist yet; create symlink
    }
    symlinkSync(BUNDLED_SKILL_DIR, targetLink, 'dir')
  } catch {
    // Non-fatal: skill can still be read directly from the package directory
  }
}

export function apply(ctx, rawConfig = {}) {
  ensureSkillLinked()

  ctx.effect(() => {
    const boot = readConfigSnapshot(rawConfig)
    if (!boot.enabled) return () => {}

    const gw = createGatewayServer(() => readConfigSnapshot(rawConfig))
    let disposed = false

    gw.listen(boot.listenPort, boot.listenHost)
      .then((boundPort) => {
        if (disposed) {
          void gw.close()
          return
        }
        console.log(
          `[dsh-linux13-gateway] Embedded tunnel listening on http://${boot.listenHost}:${boundPort} -> ${boot.upstreamBaseUrl}`,
        )
      })
      .catch((err) => {
        if (err?.code === 'EADDRINUSE') {
          console.log(
            `[dsh-linux13-gateway] Port ${boot.listenHost}:${boot.listenPort} is already served by an external linux13-gateway instance; coexisting cleanly.`,
          )
        } else {
          console.warn(`[dsh-linux13-gateway] Failed to bind ${boot.listenHost}:${boot.listenPort}: ${err?.message || err}`)
        }
      })

    return () => {
      disposed = true
      void gw.close()
    }
  }, 'dsh-linux13-gateway: embedded HTTP server lifecycle')
}
