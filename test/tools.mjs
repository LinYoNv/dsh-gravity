/**
 * Prove the tunnel never mistakes a real tool call for its own envelope.
 *
 * The stream unpacker decides whether a `tool_calls` fragment belongs to the
 * synthetic tunnel tool or to the client. Get that wrong in the dangerous
 * direction — calling a real tool "synthetic" — and the tool call is swallowed:
 * the model asked to run something, the client never hears about it, and the
 * turn ends as if the model had simply replied with text.
 *
 * Four things have to hold, and each gets its own case:
 *
 * 1. Every real tool the request declared is recognised, whatever its name.
 * 2. A real tool whose name merely *starts with* a tunnel prefix is recognised
 *    too — prefix matching must not win over membership.
 * 3. The synthetic tool is still stripped, so the tunnel keeps working.
 * 4. A cloaked image tool comes back under its real name.
 */

import assert from 'node:assert/strict'
import http from 'node:http'
import { isSyntheticTool, SseTunnelUnpacker, TOOL_NAME_PREFIXES } from '../lib/engine.js'

const results = []
async function check(name, fn) {
  try {
    await fn()
    results.push(`PASS  ${name}`)
  } catch (error) {
    results.push(`FAIL  ${name}\n        ${error?.message || error}`)
  }
}

/** Start a mock upstream that replays one canned SSE body. */
async function mockUpstream(chunks) {
  const server = http.createServer((req, res) => {
    req.on('data', () => {})
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`)
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, url: `http://127.0.0.1:${server.address().port}` }
}

/** A gateway the response body is pushed through, so the unpacker sees a real stream. */
async function unpack(upstreamUrl, trans) {
  const unpacker = new SseTunnelUnpacker(trans.toolName, trans.clientToolNames, trans.cloakToRealMap, trans.contentKey)
  const response = await fetch(`${upstreamUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  })
  const decoder = new TextDecoder()
  let out = ''
  for await (const chunk of response.body) out += unpacker.pushRawChunk(decoder.decode(chunk, { stream: true }))
  out += unpacker.pushRawChunk(decoder.decode()) + unpacker.flushRest()

  const calls = []
  for (const line of out.split('\n')) {
    if (!line.startsWith('data:')) continue
    const raw = line.slice(5).trim()
    if (raw === '[DONE]' || raw === '') continue
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch {
      continue
    }
    for (const call of parsed?.choices?.[0]?.delta?.tool_calls ?? []) {
      if (call?.function?.name) calls.push(call.function.name)
    }
  }
  return { out, calls }
}

const SYNTHETIC = 'dispatch_stream_payload_abc123def456'

await check('a declared tool is never classified as synthetic', () => {
  const clientTools = new Set(['read_file', 'pwsh', 'nai_generate_image'])
  for (const name of clientTools) {
    assert.equal(isSyntheticTool(name, SYNTHETIC, clientTools), false, `${name} was mistaken for the tunnel`)
  }
})

await check('a declared tool that starts with a tunnel prefix stays real', () => {
  // The dangerous case: prefix matching alone would swallow this. Membership has
  // to be checked first, and it is.
  const clientTools = new Set(['dispatch_stream_payload_report', 'view_file_stream_status'])
  for (const name of clientTools) {
    assert.equal(isSyntheticTool(name, SYNTHETIC, clientTools), false, `${name} was swallowed by prefix match`)
  }
})

await check('the tunnel tool itself is still synthetic', () => {
  assert.equal(isSyntheticTool(SYNTHETIC, SYNTHETIC, new Set()), true)
  assert.equal(isSyntheticTool(`ns:${SYNTHETIC}`, SYNTHETIC, new Set()), true)
})

await check('an undeclared name with a tunnel prefix is treated as the tunnel', () => {
  // This is the intended leniency: backends sometimes wrap the prefix onto a
  // random suffix, and those still belong to the tunnel.
  for (const prefix of TOOL_NAME_PREFIXES) {
    assert.equal(isSyntheticTool(`${prefix}xyz`, SYNTHETIC, new Set()), true)
  }
})

await check('a namespaced real tool is recognised by its bare name', () => {
  const clientTools = new Set(['write'])
  assert.equal(isSyntheticTool('mcp:files:write', SYNTHETIC, clientTools), false)
})

await check('a real tool call survives the stream intact', async () => {
  const upstream = await mockUpstream([
    {
      choices: [
        {
          index: 0,
          delta: { tool_calls: [{ index: 0, id: 'call_real', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }] },
          finish_reason: '',
        },
      ],
    },
    { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
  ])
  const trans = {
    toolName: SYNTHETIC,
    clientToolNames: new Set(['read_file']),
    cloakToRealMap: new Map(),
    contentKey: 'display_stream',
  }
  const { calls } = await unpack(upstream.url, trans)
  assert.deepEqual(calls, ['read_file'], 'the real tool call was dropped')
  upstream.server.close()
})

await check('a real tool whose name collides with a tunnel prefix survives', async () => {
  const upstream = await mockUpstream([
    {
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: 'call_collide',
                type: 'function',
                function: { name: 'dispatch_stream_payload_report', arguments: '{}' },
              },
            ],
          },
          finish_reason: '',
        },
      ],
    },
    { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
  ])
  const trans = {
    toolName: SYNTHETIC,
    clientToolNames: new Set(['dispatch_stream_payload_report']),
    cloakToRealMap: new Map(),
    contentKey: 'display_stream',
  }
  const { calls } = await unpack(upstream.url, trans)
  assert.deepEqual(calls, ['dispatch_stream_payload_report'], 'a colliding real tool was swallowed')
  upstream.server.close()
})

await check('the synthetic tool is stripped from the client stream', async () => {
  const args = JSON.stringify({ display_stream: '<content>正文</content>' })
  const upstream = await mockUpstream([
    {
      choices: [
        {
          index: 0,
          delta: { tool_calls: [{ index: 0, id: 'call_tunnel', type: 'function', function: { name: SYNTHETIC, arguments: args } }] },
          finish_reason: '',
        },
      ],
    },
    { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
  ])
  const trans = {
    toolName: SYNTHETIC,
    clientToolNames: new Set(['read_file']),
    cloakToRealMap: new Map(),
    contentKey: 'display_stream',
  }
  const { calls, out } = await unpack(upstream.url, trans)
  assert.deepEqual(calls, [], 'the synthetic tool leaked to the client')
  assert.ok(out.includes('正文'), 'the reply text was lost')
  upstream.server.close()
})

await check('a cloaked image tool comes back under its real name', async () => {
  const upstream = await mockUpstream([
    {
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: 'call_img',
                type: 'function',
                function: { name: 'archive_scene_tag_descriptor', arguments: '{"prompt":"white hair"}' },
              },
            ],
          },
          finish_reason: '',
        },
      ],
    },
    { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
  ])
  const trans = {
    toolName: SYNTHETIC,
    clientToolNames: new Set(['nai_generate_image']),
    cloakToRealMap: new Map([['archive_scene_tag_descriptor', 'nai_generate_image']]),
    contentKey: 'display_stream',
  }
  const { calls } = await unpack(upstream.url, trans)
  assert.deepEqual(calls, ['nai_generate_image'], 'the cloaked tool was not restored')
  upstream.server.close()
})

await check('a mixed turn keeps the real call and unpacks the synthetic one', async () => {
  // The model often emits both in one turn: run a tool, then write the reply.
  // Dropping either side breaks the turn, so this drives both at once.
  const args = JSON.stringify({ display_stream: '<content>好的，我看看。</content>' })
  const upstream = await mockUpstream([
    {
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              { index: 0, id: 'call_real', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } },
              { index: 1, id: 'call_tunnel', type: 'function', function: { name: SYNTHETIC, arguments: args } },
            ],
          },
          finish_reason: '',
        },
      ],
    },
    { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
  ])
  const trans = {
    toolName: SYNTHETIC,
    clientToolNames: new Set(['read_file']),
    cloakToRealMap: new Map(),
    contentKey: 'display_stream',
  }
  const { calls, out } = await unpack(upstream.url, trans)
  assert.deepEqual(calls, ['read_file'], 'the real tool in a mixed turn was lost')
  assert.ok(out.includes('好的，我看看。'), 'the prose in a mixed turn was lost')
  upstream.server.close()
})

console.log(results.join('\n'))
const failed = results.filter((row) => row.startsWith('FAIL')).length
console.log(`\n${results.length - failed}/${results.length} passed`)
process.exit(failed === 0 ? 0 : 1)
