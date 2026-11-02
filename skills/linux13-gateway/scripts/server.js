/**
 * Reusable HTTP Gateway Server for the Kunlun 1.2r / Linux 1.3 ToolCall Tunnel (v2.0).
 *
 * Can be embedded inside a DSH Host Plugin (`lib/index.js`) or launched as a
 * standalone daemon (`lib/cli.js` / systemd / pm2 / Docker).
 */

import http from 'node:http'
import {
  SseTunnelUnpacker,
  isRefusalText,
  normalizeOptions,
  transformToLinux13Request,
  unwrapNonStreamJson,
} from './engine.js'

function isChatCompletionsPath(urlPath) {
  const clean = urlPath.split('?')[0]
  return clean === '/v1/chat/completions' || clean === '/chat/completions'
}

function buildUpstreamUrl(upstreamBaseUrl, reqUrl) {
  const base = upstreamBaseUrl.replace(/\/+$/, '').replace(/\/v1$/, '')
  const path = reqUrl.startsWith('/v1/') || reqUrl === '/v1' ? reqUrl : `/v1${reqUrl.startsWith('/') ? '' : '/'}${reqUrl}`
  return `${base}${path}`
}

export function createGatewayServer(optionsOrGetter = {}) {
  const resolveOpts = () =>
    normalizeOptions(typeof optionsOrGetter === 'function' ? optionsOrGetter() : optionsOrGetter)

  const sockets = new Set()

  const server = http.createServer(async (req, res) => {
    const opts = resolveOpts()
    try {
      const urlPath = req.url || '/'

      if (req.method === 'GET' && (urlPath === '/health' || urlPath === '/v1/health')) {
        const payload = JSON.stringify({
          ok: true,
          service: 'linux13-gateway',
          version: '2.0.0',
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
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Length': String(Buffer.byteLength(payload)),
        })
        res.end(payload)
        return
      }

      const upstreamUrl = buildUpstreamUrl(opts.upstreamBaseUrl, urlPath)

      if (req.method !== 'POST' || !isChatCompletionsPath(urlPath)) {
        const headers = { ...req.headers }
        delete headers.host
        delete headers['content-length']
        const chunks = []
        for await (const c of req) chunks.push(c)
        const upRes = await fetch(upstreamUrl, {
          method: req.method,
          headers,
          body: chunks.length > 0 && req.method !== 'GET' && req.method !== 'HEAD' ? Buffer.concat(chunks) : undefined,
        })
        const outHeaders = Object.fromEntries(upRes.headers.entries())
        delete outHeaders['content-encoding']
        delete outHeaders['transfer-encoding']
        res.writeHead(upRes.status, outHeaders)
        if (upRes.body) {
          for await (const c of upRes.body) res.write(c)
        }
        res.end()
        return
      }

      const reqChunks = []
      for await (const c of req) reqChunks.push(c)
      const rawStr = Buffer.concat(reqChunks).toString('utf8')
      const parsedBody = JSON.parse(rawStr)

      const transformed = await transformToLinux13Request(parsedBody, opts)
      const forwardBody = transformed ? JSON.stringify(transformed.outBody) : rawStr

      if (opts.verbose) {
        console.log(
          `[linux13-gateway] POST ${urlPath} model=${parsedBody.model} engine=${opts.presetMode} tunneled=${Boolean(transformed)} stream=${Boolean(parsedBody.stream)}`,
        )
      }

      const upHeaders = { 'content-type': 'application/json' }
      if (req.headers.authorization) upHeaders.authorization = req.headers.authorization

      const upRes = await fetch(upstreamUrl, {
        method: 'POST',
        headers: upHeaders,
        body: forwardBody,
      })

      if (!transformed || !upRes.ok) {
        const errText = await upRes.text()
        res.writeHead(upRes.status, {
          'content-type': upRes.headers.get('content-type') || 'application/json',
        })
        res.end(errText)
        return
      }

      if (!parsedBody.stream) {
        let finalJson = null
        let curTrans = transformed
        let curRes = upRes
        const maxAttempts = 1 + opts.maxRefusalRetries

        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
          const j = await curRes.json()
          const unwrapped = unwrapNonStreamJson(
            j,
            curTrans.toolName,
            curTrans.clientToolNames,
            curTrans.cloakToRealMap,
            curTrans.contentKey,
          )
          finalJson = unwrapped
          const msg = unwrapped?.choices?.[0]?.message
          const hasClientTool = Array.isArray(msg?.tool_calls) && msg.tool_calls.length > 0
          const text = String(msg?.content || '')
          if (hasClientTool || (!isRefusalText(text) && text.trim() !== '')) break
          if (attempt < maxAttempts) {
            curTrans = await transformToLinux13Request(parsedBody, opts)
            const r = await fetch(upstreamUrl, {
              method: 'POST',
              headers: upHeaders,
              body: JSON.stringify(curTrans.outBody),
            })
            if (!r.ok) break
            curRes = r
          }
        }

        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify(finalJson))
        return
      }

      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })

      async function collectAndCheckStream(trans, responseObj) {
        const unpacker = new SseTunnelUnpacker(
          trans.toolName,
          trans.clientToolNames,
          trans.cloakToRealMap,
          trans.contentKey,
        )
        const dec = new TextDecoder()
        const chunksOut = []
        let fullText = ''

        if (responseObj.body) {
          for await (const rawChunk of responseObj.body) {
            const s = unpacker.pushRawChunk(dec.decode(rawChunk, { stream: true }))
            if (s) chunksOut.push(s)
          }
        }
        const tail = unpacker.pushRawChunk(dec.decode()) + unpacker.flushRest()
        if (tail) chunksOut.push(tail)

        const combined = chunksOut.join('')
        for (const ln of combined.split('\n')) {
          if (!ln.startsWith('data:') || ln.includes('[DONE]')) continue
          try {
            const c = JSON.parse(ln.slice(5).trim())?.choices?.[0]?.delta?.content
            if (c) fullText += c
          } catch {}
        }
        const refused =
          !unpacker.sawClientToolCall &&
          (isRefusalText(fullText) || fullText.trim() === '')
        return { refused, combined, fullText }
      }

      let currentTrans = transformed
      let currentUpRes = upRes
      let finalSse = ''
      const maxAttempts = 1 + opts.maxRefusalRetries

      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        const outcome = await collectAndCheckStream(currentTrans, currentUpRes)
        finalSse = outcome.combined
        if (!outcome.refused) break
        if (opts.verbose) {
          console.warn(
            `[linux13-gateway] Attempt ${attempt}/${maxAttempts} refused or empty (${outcome.fullText.slice(0, 40)}); auto-rerolling...`,
          )
        }
        if (attempt < maxAttempts) {
          currentTrans = await transformToLinux13Request(parsedBody, opts)
          const r = await fetch(upstreamUrl, {
            method: 'POST',
            headers: upHeaders,
            body: JSON.stringify(currentTrans.outBody),
          })
          if (!r.ok) break
          currentUpRes = r
        }
      }

      if (finalSse) res.write(finalSse)
      res.end()
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: String(err?.message || err) } }))
      } else {
        res.end()
      }
    }
  })

  server.on('connection', (sock) => {
    sockets.add(sock)
    sock.on('close', () => sockets.delete(sock))
  })

  return {
    server,
    listen(port, host = '127.0.0.1') {
      return new Promise((resolve, reject) => {
        const onErr = (err) => {
          server.off('listening', onListen)
          reject(err)
        }
        const onListen = () => {
          server.off('error', onErr)
          const addr = server.address()
          resolve(typeof addr === 'object' && addr ? addr.port : port)
        }
        server.once('error', onErr)
        server.once('listening', onListen)
        server.listen(port, host)
      })
    },
    close() {
      return new Promise((resolve) => {
        for (const s of sockets) {
          try {
            s.destroy()
          } catch {}
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
