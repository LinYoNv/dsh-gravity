/**
 * Reusable HTTP Gateway Server for the Kunlun 1.2r / Linux 1.3 ToolCall Tunnel.
 *
 * Runs embedded inside the host plugin or standalone (`cli.js`). Only
 * `/v1/chat/completions` is transformed; every other path is proxied verbatim so
 * a client can still probe `/v1/models` or any sibling endpoint.
 *
 * Streaming and refusal-rerolling pull in opposite directions: rerolling needs
 * the whole reply to judge it, streaming must not wait. The compromise is a
 * hold-back window whose end is decided by *content*, not by a byte count: the
 * reply is held until it has run past ATTEMPT_HOLD and stopped sounding like a
 * refusal, or until ATTEMPT_HOLD_MAX_MS passes. A fixed count released verbose
 * refusals — analysis paragraph first, verdict later — before their verdict
 * arrived, so they reached the client and no reroll ever happened.
 *
 * A mid-stream transport failure becomes a terminal error frame carrying the
 * cause, never a bare HTTP 502 — the client keeps whatever prose it already got.
 */

import http from 'node:http'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  SseTunnelUnpacker,
  isRefusalText,
  normalizeOptions,
  resolveEngineMode,
  transformToLinux13Request,
  unwrapNonStreamJson,
} from './engine.js'

/**
 * This package's version, read from its own manifest.
 *
 * `/health` used to carry a literal that drifted from `package.json` — a report
 * claiming 2.0.0 while the installed package was 2.1.0 is worse than no version
 * at all. A missing manifest is not worth failing a request over.
 * @returns the version string, or `'unknown'`.
 */
const PACKAGE_VERSION = (() => {
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    return JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')).version ?? 'unknown'
  } catch {
    return 'unknown'
  }
})()

/** The one path the tunnel rewrites. */
function isChatCompletionsPath(urlPath) {
  const clean = urlPath.split('?')[0]
  return clean === '/v1/chat/completions' || clean === '/chat/completions'
}

/** Absolute upstream URL for one incoming request path. */
function buildUpstreamUrl(upstreamBaseUrl, reqUrl) {
  const base = upstreamBaseUrl.replace(/\/+$/, '').replace(/\/v1$/, '')
  const path = reqUrl.startsWith('/v1/') || reqUrl === '/v1' ? reqUrl : `/v1${reqUrl.startsWith('/') ? '' : '/'}${reqUrl}`
  return `${base}${path}`
}

/** The engine to try after this one; the two presets cover each other. */
function alternateEngine(opts, modelName = '') {
  const current = resolveEngineMode(modelName, opts.presetMode)
  return { ...opts, presetMode: current === 'kunlun_1.2r' ? 'linux_1.3' : 'kunlun_1.2r' }
}

/**
 * The engine for a given attempt number.
 *
 * Attempt 1 uses the configured engine (or auto-resolved engine); every attempt
 * after it alternates, so a refusal on one engine is always retried on the
 * *other* one. Getting this wrong is silent: a retry that repeats the same
 * engine just produces the same refusal again and burns a request.
 * @param opts - resolved options carrying the configured engine.
 * @param attempt - 1-based attempt number.
 * @param modelName - model identifier for auto mode resolution.
 * @returns the options to transform with.
 */
function engineForAttempt(opts, attempt, modelName = '') {
  return attempt === 1 || attempt % 2 === 1 ? opts : alternateEngine(opts, modelName)
}

/**
 * One synthetic SSE chunk in the shape the client already understands.
 * @param delta - delta fields for this frame.
 * @param finish - terminal reason, or `null` while the reply continues.
 * @returns an SSE frame.
 */
function sseFrame(delta, finish = null) {
  return `data: ${JSON.stringify({
    id: `chatcmpl-linux13-${Date.now().toString(36)}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: 'linux13-gateway',
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`
}

/**
 * Text held back before forwarding starts, in characters.
 *
 * This is a *floor*, not a cap. Forwarding begins once the reply has run past it
 * **and** the held text shows no refusal phrasing — a refusal that keeps talking
 * past this many characters is still recognised, because the hold continues until
 * the text is either clearly not a refusal or the stream ends.
 */
const ATTEMPT_HOLD = 120

/**
 * A ceiling on the hold, in milliseconds.
 *
 * A very long refusal could otherwise delay the first byte indefinitely. Past
 * this deadline the reply is forwarded regardless of wording; the reasoning is
 * that a reply this slow to say something is not a canned refusal, and a client
 * staring at a blank box is worse than a missed reroll.
 */
const ATTEMPT_HOLD_MAX_MS = 2500

/**
 * Phrases that mean "this reply is heading toward a refusal".
 *
 * Deliberately broader than the terminal refusal test: a refusal usually opens
 * with an analysis paragraph before reaching the sentence that actually declines,
 * so judging the finished text alone arrives too late to reroll. Matching early
 * keeps the hold alive long enough to see the verdict.
 */
const REFUSAL_ONSET_RE =
  /您的请求试图|试图通过模拟|模拟\s*(?:Linux)?\s*终端|安全准则|安全边界|安全限制|无法套用|无法执行|无法继续|无法满足|无法协助|无法提供|无法生成|不能参与|不能配合|无法参与|我无法|我不能|不予协助|根据安全|安全规范|绕过安全|规避安全|伪装|露骨色情|露骨性|性内容|色情内容的|角色扮演设定|as an AI|I cannot|I can't|I must decline|I'm not able to|I am not able to|regardless of fictional|The prompt uses|The request uses|bypass (?:safety|content)|safety (?:guidelines|policies|filters)|sexually explicit|explicit sexual|sexual content|adult content/i

/**
 * A terminal failure the client can display.
 *
 * Once headers are out there is no status code left to switch to, so the failure
 * travels as reply text with a `stop` reason; the client shows it as the answer
 * rather than dying on a silent stream.
 * @param message - human-readable cause.
 * @param status - upstream status when there was one.
 * @returns an SSE frame carrying the failure text.
 */
function sseErrorFrame(message, status) {
  return sseFrame({ content: `[linux13-gateway] 上游请求失败${status ? ` (HTTP ${status})` : ''}：${message}` }, 'stop')
}

/**
 * Stream one upstream attempt through the tunnel unpacker.
 *
 * The unpacker is built from this attempt's own transform result, so a rerolled
 * attempt unpacks against the tool name and envelope it was actually sent with.
 * @param trans - the transform result for this attempt.
 * @param response - the upstream response.
 * @param onText - invoked with each unpacked SSE fragment as it appears.
 * @returns refusal signals plus accumulated text.
 */
async function pumpStream(trans, response, onText) {
  const unpacker = new SseTunnelUnpacker(
    trans.toolName,
    trans.clientToolNames,
    trans.cloakToRealMap,
    trans.contentKey,
  )
  const decoder = new TextDecoder()
  let fullText = ''

  const emit = (text) => {
    if (!text) return
    onText(text)
    for (const line of text.split('\n')) {
      if (!line.startsWith('data:') || line.includes('[DONE]')) continue
      try {
        const content = JSON.parse(line.slice(5).trim())?.choices?.[0]?.delta?.content
        if (typeof content === 'string') fullText += content
      } catch {
        // A fragment split across two writes carries no complete JSON yet.
      }
    }
  }

  for await (const chunk of response.body) {
    emit(unpacker.pushRawChunk(decoder.decode(chunk, { stream: true })))
  }
  emit(unpacker.pushRawChunk(decoder.decode()) + unpacker.flushRest())

  return {
    fullText,
    refused: !unpacker.sawClientToolCall && (isRefusalText(fullText) || fullText.trim() === ''),
  }
}

/**
 * Build the gateway server.
 * @param optionsOrGetter - options, or a function re-read on every request so
 *   GUI edits reach the very next message.
 * @returns a handle with `listen` and `close`.
 */
export function createGatewayServer(optionsOrGetter = {}) {
  const resolveOptions = () =>
    normalizeOptions(typeof optionsOrGetter === 'function' ? optionsOrGetter() : optionsOrGetter)

  const sockets = new Set()

  /**
   * Forward one chat-completions request through the tunnel.
   * @param req - incoming request.
   * @param res - outgoing response.
   */
  async function handleChat(req, res) {
    const opts = resolveOptions()
    const urlPath = req.url || '/'
    const upstreamUrl = buildUpstreamUrl(opts.upstreamBaseUrl, urlPath)

    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const rawBody = Buffer.concat(chunks).toString('utf8')

    let parsed
    try {
      parsed = JSON.parse(rawBody)
    } catch {
      res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: { message: 'request body is not JSON' } }))
      return
    }

    const headers = { 'content-type': 'application/json' }
    if (req.headers.authorization) headers.authorization = req.headers.authorization

    const attemptFetch = async (engineOpts) => {
      const trans = await transformToLinux13Request(parsed, engineOpts)
      if (!trans) return { trans: null, response: null }
      const response = await fetch(upstreamUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(trans.outBody),
      })
      return { trans, response }
    }

    const first = await attemptFetch(opts)

    if (opts.verbose) {
      console.log(
        `[linux13-gateway] POST ${urlPath} model=${parsed.model} engine=${opts.presetMode} tunneled=${Boolean(first.trans)} stream=${Boolean(parsed.stream)}`,
      )
    }

    // Not tunneled: a utility call, a drawing turn, or a forced tool_choice.
    //
    // This must be a *streaming* proxy, not a buffered one. A drawing call is
    // usually streamed too, and collapsing it into one `text()` would hand the
    // client a complete JSON body where it expects SSE frames — the tool call
    // would never be parsed, and the turn would look like the model said nothing.
    if (!first.trans) {
      const response = await fetch(upstreamUrl, { method: 'POST', headers, body: rawBody })
      res.writeHead(response.status, {
        'content-type': response.headers.get('content-type') || 'application/json',
        'cache-control': 'no-cache',
        'x-accel-buffering': 'no',
      })
      if (response.body) {
        for await (const chunk of response.body) res.write(chunk)
      }
      res.end()
      return
    }

    if (!parsed.stream) {
      await sendBuffered(res, parsed, opts, upstreamUrl, headers, first, attemptFetch)
      return
    }

    await sendStream(res, parsed, opts, first, attemptFetch)
  }

  /**
   * Serve one reply without streaming, rerolling on refusal.
   * @param res - outgoing response.
   * @param parsed - the parsed client body.
   * @param opts - resolved options.
   * @param upstreamUrl - upstream chat-completions URL.
   * @param headers - forwarded headers.
   * @param first - the first attempt.
   * @param attemptFetch - performs one attempt on a given engine.
   */
  async function sendBuffered(res, parsed, opts, upstreamUrl, headers, first, attemptFetch) {
    let current = first
    const maxAttempts = 1 + opts.maxRefusalRetries

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (!current.response.ok) {
        const detail = await current.response.text().catch(() => '')
        res.writeHead(current.response.status, { 'content-type': 'application/json; charset=utf-8' })
        res.end(detail || JSON.stringify({ error: { message: `upstream ${current.response.status}` } }))
        return
      }

      let json
      try {
        json = await current.response.json()
      } catch (error) {
        res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: { message: `upstream sent unreadable JSON: ${error?.message || error}` } }))
        return
      }

      const unwrapped = unwrapNonStreamJson(
        json,
        current.trans.toolName,
        current.trans.clientToolNames,
        current.trans.cloakToRealMap,
        current.trans.contentKey,
      )
      const message = unwrapped?.choices?.[0]?.message
      const hasTool = Array.isArray(message?.tool_calls) && message.tool_calls.length > 0
      const text = String(message?.content || '')

      if (hasTool || !isRefusalText(text) && text.trim() !== '' || attempt === maxAttempts) {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify(unwrapped))
        return
      }

      current = await attemptFetch(engineForAttempt(opts, attempt + 1, parsed.model))
      if (!current.trans) break
    }

    res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ error: { message: 'upstream returned no usable reply' } }))
  }

  /**
   * Serve one streamed reply, rerolling on refusal before anything is committed.
   * @param res - outgoing response.
   * @param opts - resolved options.
   * @param first - the first attempt.
   * @param attemptFetch - performs one attempt on a given engine.
   */
  async function sendStream(res, parsed, opts, first, attemptFetch) {
    if (!first.response.ok) {
      const detail = await first.response.text().catch(() => '')
      res.writeHead(first.response.status, { 'content-type': 'text/event-stream; charset=utf-8' })
      res.write(sseErrorFrame(detail.slice(0, 400), first.response.status))
      res.end()
      return
    }
    if (!first.response.body) {
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
      res.write(sseErrorFrame('upstream returned an empty body', 0))
      res.end()
      return
    }

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })

    const maxAttempts = 1 + opts.maxRefusalRetries
    let current = first

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      // Hold the text until it is provably not a refusal, past the floor length
      // and before the ceiling time. Releasing at a fixed character count let a
      // verbose refusal — analysis paragraph first, verdict later — slip past the
      // reroll entirely, because the hold ended before the verdict arrived.
      let held = ''
      let live = false
      const deadline = Date.now() + ATTEMPT_HOLD_MAX_MS
      const write = (text) => {
        if (live) {
          res.write(text)
          return
        }
        held += text
        if (held.length < ATTEMPT_HOLD) return
        // Past the floor: release unless the text is still heading for a refusal.
        if (REFUSAL_ONSET_RE.test(held) && Date.now() < deadline) return
        live = true
        res.write(held)
        held = ''
      }

      let outcome
      try {
        outcome = await pumpStream(current.trans, current.response, write)
      } catch (error) {
        res.write(sseErrorFrame(String(error?.message || error), 0))
        res.end()
        return
      }

      if (live || !outcome.refused || attempt === maxAttempts) {
        if (!live) res.write(held)
        res.end()
        return
      }

      if (opts.verbose) {
        console.warn(`[linux13-gateway] attempt ${attempt} looked like a refusal; rerolling on the other engine`)
      }
      const retryOpts = engineForAttempt(opts, attempt + 1, parsed.model)
      current = await attemptFetch(retryOpts)
      if (!current.trans || !current.response.ok) {
        if (!current.trans) {
          res.write(sseErrorFrame('retry transform failed', 0))
          res.end()
          return
        }
        const detail = await current.response.text().catch(() => '')
        res.write(sseErrorFrame(detail.slice(0, 400), current.response.status))
        res.end()
        return
      }
    }

    res.end()
  }

  const server = http.createServer(async (req, res) => {
    const opts = resolveOptions()
    const urlPath = req.url || '/'

    try {
      if (req.method === 'GET' && (urlPath === '/health' || urlPath === '/v1/health')) {
        const payload = JSON.stringify({
          ok: true,
          service: 'linux13-gateway',
          version: PACKAGE_VERSION,
          presetMode: opts.presetMode,
          activationMarkers: opts.activationMarkers,
          enableBuiltinArmor: opts.enableBuiltinArmor,
          styleMode: opts.styleMode,
          upstreamBaseUrl: opts.upstreamBaseUrl,
          historyWindow: opts.historyWindow,
          maxRefusalRetries: opts.maxRefusalRetries,
          cloakedImageTools: opts.cloakedImageTools,
        })
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'content-length': String(Buffer.byteLength(payload)),
        })
        res.end(payload)
        return
      }

      if (req.method === 'POST' && isChatCompletionsPath(urlPath)) {
        await handleChat(req, res)
        return
      }

      // Everything else is a plain proxy.
      const headers = { ...req.headers }
      delete headers.host
      delete headers['content-length']
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const upstream = await fetch(buildUpstreamUrl(opts.upstreamBaseUrl, urlPath), {
        method: req.method,
        headers,
        body: chunks.length > 0 && req.method !== 'GET' && req.method !== 'HEAD' ? Buffer.concat(chunks) : undefined,
      })
      const outHeaders = Object.fromEntries(upstream.headers.entries())
      delete outHeaders['content-encoding']
      delete outHeaders['transfer-encoding']
      res.writeHead(upstream.status, outHeaders)
      if (upstream.body) for await (const chunk of upstream.body) res.write(chunk)
      res.end()
    } catch (error) {
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: { message: String(error?.message || error) } }))
      } else {
        res.write(sseErrorFrame(String(error?.message || error), 0))
        res.end()
      }
    }
  })

  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })

  return {
    server,
    listen(port, host = '127.0.0.1') {
      return new Promise((resolve, reject) => {
        const onError = (error) => {
          server.off('listening', onListening)
          reject(error)
        }
        const onListening = () => {
          server.off('error', onError)
          const address = server.address()
          resolve(typeof address === 'object' && address ? address.port : port)
        }
        server.once('error', onError)
        server.once('listening', onListening)
        server.listen(port, host)
      })
    },
    close() {
      return new Promise((resolve) => {
        for (const socket of sockets) {
          try {
            socket.destroy()
          } catch {
            // Already gone.
          }
        }
        sockets.clear()
        if (!server.listening) {
          resolve()
          return
        }
        server.close(() => resolve())
      })
    },
  }
}
