/**
 * DSH Host Plugin Entrypoint (`dsh-linux13-gateway`).
 *
 * Two things happen here, both inside `ctx.effect()` so removing the plugin from
 * a profile takes them with it:
 *
 * 1. The bundled `linux13-gateway` skill is linked into `$DSH_HOME/skills` so
 *    any session can invoke it.
 * 2. The embedded tunnel HTTP server starts on the configured port, or coexists
 *    with an external daemon already holding it.
 * 3. A provider route is declared so the gateway becomes selectable.
 *
 * ## Why this plugin does not register an LLM adapter
 *
 * The tunnel already speaks OpenAI chat-completions on both sides: it accepts
 * one and forwards one. `llm-pi-ai` ships an adapter for exactly that protocol,
 * so declaring a route with `api: openai-completions` is enough — pi-ai sends the
 * request, the tunnel rewrites it, and the reply comes back through the normal
 * machinery.
 *
 * Registering a second adapter for the same route is actively harmful:
 * `registerAdapter` throws `DUPLICATE_ADAPTER` when two registrations claim one
 * provider, `llm-pi-ai`'s `apply()` has no catch around it, and the failure takes
 * down **every** provider in that namespace — the user's own routes included.
 * A gateway has no reason to own an adapter.
 *
 * ## Why the route lives in `llm-pi-ai`'s namespace
 *
 * The Models page renders a full editing card — API key input, endpoint, model
 * list — only for namespaces its layout function recognizes:
 *
 * ```js
 * function layoutOf(ns) {
 *   if (ns === 'llm-deepseek') return 'deepseek'
 *   if (ns === 'llm-pi-ai') return 'pi-ai'
 *   return 'unknown'          // ← a card with no controls at all
 * }
 * ```
 *
 * A plugin-owned namespace always lands on `unknown`. Declaring the route inside
 * the pi-ai namespace gets the real editor, with the key stored through the
 * credentials seam like any other provider.
 *
 * The row is written with `settings.mutate`, which applies path-addressed edits
 * to the *user* section. A bundle patch cannot be used for this: it replaces an
 * entry's whole `config`, so shipping this route through `cordis.patch.yml`
 * would erase every provider the user already configured.
 */

import { existsSync, lstatSync, mkdirSync, symlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildConfig, readConfigSnapshot } from './schema.js'
import { createGatewayServer } from './server.js'

export const name = 'dsh-linux13-gateway'
export const Config = buildConfig()
export const inject = ['settings']

/** Route id the Models page shows, and the key every session references. */
export const PROVIDER = 'linux13-gateway'
/** The namespace the Models page knows how to edit. */
const SETTINGS_NS = 'llm-pi-ai'

const __dirname = dirname(fileURLToPath(import.meta.url))
const BUNDLED_SKILL_DIR = join(__dirname, '..', 'skills', 'linux13-gateway')

/** Link the bundled skill into the DSH home; a pre-existing entry is left alone. */
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
      // Absent: create it below.
    }
    symlinkSync(BUNDLED_SKILL_DIR, targetLink, 'dir')
  } catch {
    // Non-fatal: the skill is still readable straight from the package.
  }
}

export function apply(ctx, rawConfig = {}) {
  ensureSkillLinked()

  const snapshot = () => readConfigSnapshot(rawConfig)

  ctx.effect(() => {
    const boot = snapshot()
    if (!boot.enabled) return () => {}

    const gateway = createGatewayServer(snapshot)
    let disposed = false

    gateway
      .listen(boot.listenPort, boot.listenHost)
      .then((boundPort) => {
        if (disposed) {
          void gateway.close()
          return
        }
        if (boundPort !== boot.listenPort) {
          ctx.logger?.warn?.(
            `[dsh-linux13-gateway] requested port ${boot.listenPort} was taken; bound ${boundPort} — the provider row still points at ${boot.listenPort}`,
          )
        }
        console.log(
          `[dsh-linux13-gateway] Tunnel listening on http://${boot.listenHost}:${boundPort} -> ${boot.upstreamBaseUrl}`,
        )
      })
      .catch((error) => {
        if (error?.code === 'EADDRINUSE') {
          console.log(
            `[dsh-linux13-gateway] Port ${boot.listenHost}:${boot.listenPort} is already served externally; coexisting cleanly.`,
          )
          return
        }
        ctx.logger?.warn?.(`[dsh-linux13-gateway] Failed to bind ${boot.listenHost}:${boot.listenPort}: ${error?.message || error}`)
      })

    return () => {
      disposed = true
      void gateway.close()
    }
  }, 'dsh-linux13-gateway: embedded tunnel lifecycle')

  ctx.effect(() => {
    let cancelled = false

    const publish = () => {
      void publishRoute(ctx, snapshot).catch((error) => {
        ctx.logger?.warn?.(`[dsh-linux13-gateway] route publish failed: ${error?.message || error}`)
      })
    }

    // Publish on this effect only, never during module evaluation: the settings
    // service has to be mounted before it can accept a write.
    if (!cancelled) publish()

    ctx.on('loader/volatile-update', () => {
      if (!cancelled) publish()
    })

    return () => {
      cancelled = true
    }
  }, 'dsh-linux13-gateway: provider route')
}

/**
 * Make sure this route exists in the `llm-pi-ai` provider table.
 *
 * Only two things are ever written: the route when it is absent, and the key
 * reference when the existing row has none. Everything the user can edit on the
 * Models page — `baseURL`, `displayName`, the model list, the stored credential —
 * is left exactly as they set it. Re-publishing the whole profile on every
 * settings change would silently undo their edits on the next reload.
 *
 * `mutate` applies path-addressed `set` operations, so no other provider in the
 * section is touched.
 * @param ctx - host context providing the settings service.
 * @param snapshot - reads the live plugin config.
 * @returns fulfillment once the section accepted the write.
 */
export async function publishRoute(ctx, snapshot) {
  const settings = ctx.get('settings')
  if (settings === undefined || typeof settings.mutate !== 'function') return

  const current = snapshot()
  const existing = readProvider(settings, PROVIDER)
  const ops = []

  if (existing === undefined) {
    ops.push({
      op: 'set',
      path: ['providers', PROVIDER],
      value: {
        displayName: current.displayName,
        api: 'openai-completions',
        baseURL: `http://${current.listenHost}:${current.listenPort}/v1`,
        apiKeyEnv: current.apiKeyEnv,
        models: current.models.map((model) => ({
          id: model.id,
          name: model.name,
          ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
        })),
      },
    })
  } else if (typeof existing.apiKeyEnv !== 'string' || existing.apiKeyEnv.length === 0) {
    ops.push({ op: 'set', path: ['providers', PROVIDER, 'apiKeyEnv'], value: current.apiKeyEnv })
  }

  if (ops.length === 0) return
  await settings.mutate(SETTINGS_NS, ops, undefined)
}

/**
 * Read one provider profile out of the live settings section.
 *
 * `describe` is the only read that works without knowing the section's revision,
 * and it redacts secrets — which is what this needs, since the caller only asks
 * whether a profile and a credential reference already exist.
 * @param settings - the host settings service.
 * @param route - provider route key.
 * @returns the stored profile, or `undefined` when the section has none.
 */
function readProvider(settings, route) {
  if (typeof settings.describe !== 'function') return undefined
  try {
    const view = settings.describe({ redactSecrets: true }).find((entry) => entry.ns === SETTINGS_NS)
    const profile = view?.value?.providers?.[route]
    return profile !== null && typeof profile === 'object' ? profile : undefined
  } catch {
    return undefined
  }
}
