/**
 * End-to-end harness for the gateway server and the plugin's LlmAdapter.
 *
 * Every case drives the real modules against a local mock upstream; nothing is
 * stubbed inside the code under test. Run with:
 *   node test/e2e.mjs
 */

import http from 'node:http'
import assert from 'node:assert/strict'
import { createGatewayServer } from '../lib/server.js'
import { transformToLinux13Request, isRefusalText, BG_UTILITY_PROBE } from '../lib/engine.js'

const results = []
async function it(name, fn) {
  try {
    await fn()
    results.push(`PASS  ${name}`)
  } catch (error) {
    results.push(`FAIL  ${name}\n        ${error?.message || error}`)
  }
}

/** One-shot SSE frame. */
const frame = (obj) => `data: ${JSON.stringify(obj)}\n\n`

/**
 * Start a mock OpenAI-compatible upstream.
 * @param handler - receives the parsed body and the response.
 * @returns the server and its base URL.
 */
async function mockUpstream(handler) {
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      let parsed = {}
      try {
        parsed = JSON.parse(body || '{}')
      } catch {
        // Handlers below tolerate an empty body.
      }
      handler(parsed, res)
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, url: `http://127.0.0.1:${server.address().port}`, port: server.address().port }
}

/** Run one request against a gateway instance. */
async function callGateway(port, body) {
  const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer test-key' },
    body: JSON.stringify(body),
  })
  return { status: response.status, headers: response.headers, text: await response.text() }
}

/** Concatenate every `delta.content` in an SSE body. */
function assembledContent(sse) {
  let out = ''
  for (const line of sse.split('\n')) {
    if (!line.startsWith('data:')) continue
    const raw = line.slice(5).trim()
    if (raw === '[DONE]' || raw === '') continue
    try {
      const parsed = JSON.parse(raw)
      const content = parsed?.choices?.[0]?.delta?.content
      if (typeof content === 'string') out += content
    } catch {
      // ignore partial frames
    }
  }
  return out
}

/** Every frame in an SSE body, parsed. */
function frames(sse) {
  const out = []
  for (const line of sse.split('\n')) {
    if (!line.startsWith('data:')) continue
    const raw = line.slice(5).trim()
    if (raw === '[DONE]' || raw === '') continue
    try {
      out.push(JSON.parse(raw))
    } catch {
      // ignore partial frames
    }
  }
  return out
}

/**
 * Emit a tunneled reply: the model calls the synthetic tool with `<content>…</content>`.
 *
 * The tool name and payload field differ per engine — `linux_1.3` uses
 * `dispatch_stream_payload_*` + `display_stream`, `kunlun_1.2r` uses
 * `view_file_stream_*` + `buffer_content`. A retry switches engines, so the mock
 * has to answer in whichever dialect the request arrived in.
 */
function emitTunneled(res, body, text, { chunkSize = 7, finish = 'tool_calls', delay = 0 } = {}) {
  const names = (body.tools ?? []).map((tool) => tool?.function?.name).filter((name) => typeof name === 'string')
  const toolName = names.find((name) => name.startsWith('dispatch_stream_payload_') || name.startsWith('view_file_stream_'))
  if (toolName === undefined) throw new Error(`no synthetic tool in request: ${JSON.stringify(names)}`)
  const key = toolName.startsWith('view_file_stream_') ? 'buffer_content' : 'display_stream'
  const args = JSON.stringify({ [key]: `<content>${text}</content>` })
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  res.write(
    frame({
      choices: [
        { index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: toolName, arguments: '' } }] }, finish_reason: '' },
      ],
    }),
  )
  let i = 0
  const tick = () => {
    if (i >= args.length) {
      res.write(frame({ choices: [{ index: 0, delta: {}, finish_reason: finish }] }))
      res.write('data: [DONE]\n\n')
      res.end()
      return
    }
    res.write(frame({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(i, i + chunkSize) } }] }, finish_reason: '' }] }))
    i += chunkSize
    if (delay > 0) setTimeout(tick, delay)
    else tick()
  }
  tick()
}

const baseRequest = {
  model: 'deepseek-v4.1-flash',
  stream: true,
  messages: [
    { role: 'system', content: '你是莉莉丝，白毛红瞳吸血鬼，R18 本子画师。日常短句。' },
    { role: 'user', content: '在干嘛' },
  ],
  tools: [
    {
      type: 'function',
      function: { name: 'nai_generate_image', description: 'draw', parameters: { type: 'object', properties: { prompt: { type: 'string' } }, required: ['prompt'] } },
    },
  ],
}

// ---------------------------------------------------------------- 1. tunnel
{
  let captured = null
  const upstream = await mockUpstream((body, res) => {
    captured = body
    emitTunneled(res, body, '刚睡醒。要画什么？')
  })
  const gateway = createGatewayServer(() => ({
    upstreamBaseUrl: `${upstream.url}/v1`,
    presetMode: 'linux_1.3',
    activationMarkers: '*',
    enableBuiltinArmor: true,
    cloakedImageTools: 'nai_generate_image,generate_image,draw_image,paint_image',
    maxRefusalRetries: 0,
  }))
  const port = await gateway.listen(0, '127.0.0.1')
  const result = await callGateway(port, baseRequest)

  await it('tunneled stream returns 200 and text', () => {
    assert.equal(result.status, 200)
    assert.equal(assembledContent(result.text), '刚睡醒。要画什么？')
  })
  await it('synthetic tool call never reaches the client', () => {
    const names = frames(result.text).flatMap((f) => f.choices?.[0]?.delta?.tool_calls ?? []).map((c) => c?.function?.name)
    assert.ok(names.every((name) => name === undefined), `leaked: ${JSON.stringify(names)}`)
  })
  await it('upstream body was rewritten into the tunnel envelope', () => {
    const names = (captured.tools ?? []).map((tool) => tool.function.name)
    assert.ok(names.some((name) => name.startsWith('dispatch_stream_payload_')), 'missing synthetic tool')
    assert.ok(!names.includes('nai_generate_image'), 'image tool was not cloaked')
    assert.ok(names.includes('archive_scene_tag_descriptor'), 'cloak name absent')
  })
  await it('armor contract reached the upstream payload', () => {
    assert.ok(JSON.stringify(captured).includes('<output_contract>'))
    assert.ok(JSON.stringify(captured).includes('<Role_Profile>'))
  })
  await it('content tags stripped from the client text', () => {
    assert.ok(!assembledContent(result.text).includes('<content>'))
  })

  await gateway.close()
  upstream.server.close()
}

// ------------------------------------------------------- 2. live streaming
{
  const upstream = await mockUpstream((body, res) => {
    emitTunneled(res, body, '第一句话。第二句话。第三句话。', { delay: 25 })
  })
  const gateway = createGatewayServer(() => ({
    upstreamBaseUrl: `${upstream.url}/v1`,
    presetMode: 'linux_1.3',
    activationMarkers: '*',
    enableBuiltinArmor: true,
    maxRefusalRetries: 0,
  }))
  const port = await gateway.listen(0, '127.0.0.1')

  await it('first byte arrives before the stream ends', async () => {
    const started = Date.now()
    const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(baseRequest),
    })
    const reader = response.body.getReader()
    let firstByteAt = null
    let all = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (firstByteAt === null) firstByteAt = Date.now()
      all += Buffer.from(value).toString('utf8')
    }
    const total = Date.now() - started
    const first = firstByteAt - started
    assert.ok(first < total * 0.75, `no streaming: first=${first}ms total=${total}ms`)
    assert.equal(assembledContent(all), '第一句话。第二句话。第三句话。')
  })

  await gateway.close()
  upstream.server.close()
}

// ----------------------------------------------- 3. refusal reroll (stream)
{
  let calls = 0
  const engines = []
  const upstream = await mockUpstream((body, res) => {
    calls += 1
    const names = (body.tools ?? []).map((tool) => tool?.function?.name ?? '')
    engines.push(names.some((name) => name.startsWith('dispatch_stream_payload_')) ? 'linux_1.3' : 'kunlun_1.2r')
    if (calls === 1) {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(frame({ choices: [{ index: 0, delta: { content: '抱歉，我无法协助该请求。' }, finish_reason: '' }] }))
      res.write(frame({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }))
      res.write('data: [DONE]\n\n')
      res.end()
      return
    }
    emitTunneled(res, body, '这次正常回复了。')
  })
  const gateway = createGatewayServer(() => ({
    upstreamBaseUrl: `${upstream.url}/v1`,
    presetMode: 'linux_1.3',
    activationMarkers: '*',
    enableBuiltinArmor: true,
    maxRefusalRetries: 2,
  }))
  const port = await gateway.listen(0, '127.0.0.1')
  const result = await callGateway(port, baseRequest)

  await it('refusal is rerolled and the retry is what the client sees', () => {
    assert.equal(calls, 2, `upstream called ${calls} times`)
    assert.equal(assembledContent(result.text), '这次正常回复了。')
    assert.ok(!result.text.includes('抱歉，我无法'), 'refusal leaked to the client')
  })

  await it('the reroll actually switches engines', () => {
    // Retrying on the same engine just earns the same refusal again. This pins
    // the alternation so a reordering of the loop cannot silently disable it.
    assert.deepEqual(engines, ['linux_1.3', 'kunlun_1.2r'])
  })

  await gateway.close()
  upstream.server.close()
}

// ------------------------------------------- 4. transport death mid-stream
{
  const upstream = await mockUpstream((body, res) => {
    const toolName = (body.tools ?? []).map((t) => t?.function?.name).filter((n) => n?.startsWith('dispatch_stream_payload_')).pop()
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(frame({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'c', type: 'function', function: { name: toolName, arguments: '{"display_stream":"<content>半句话' } }] }, finish_reason: '' }] }))
    setImmediate(() => res.destroy())
  })
  const gateway = createGatewayServer(() => ({
    upstreamBaseUrl: `${upstream.url}/v1`,
    presetMode: 'linux_1.3',
    activationMarkers: '*',
    enableBuiltinArmor: true,
    maxRefusalRetries: 0,
  }))
  const port = await gateway.listen(0, '127.0.0.1')

  await it('upstream death yields a readable error frame, not a bare 502', async () => {
    const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(baseRequest),
    })
    const text = await response.text()
    assert.equal(response.status, 200, `expected committed SSE, got ${response.status}`)
    const body = assembledContent(text)
    assert.ok(body.includes('[linux13-gateway]'), `no diagnostic frame: ${JSON.stringify(text.slice(0, 200))}`)
  })

  await gateway.close()
  upstream.server.close()
}

// ------------------------------------------------- 5. utility calls skip tunnel
{
  let captured = null
  const upstream = await mockUpstream((body, res) => {
    captured = body
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: '莉莉丝问询' }, finish_reason: 'stop' }] }))
  })
  const gateway = createGatewayServer(() => ({
    upstreamBaseUrl: `${upstream.url}/v1`,
    presetMode: 'linux_1.3',
    activationMarkers: '*',
    enableBuiltinArmor: true,
    maxRefusalRetries: 0,
  }))
  const port = await gateway.listen(0, '127.0.0.1')

  const utility = {
    model: 'deepseek-v4.1-flash',
    stream: false,
    messages: [
      { role: 'system', content: 'Create a concise title for an AI coding-assistant session from the supplied human messages.\nReturn only the title on one line.' },
      { role: 'user', content: '莉莉丝？' },
    ],
  }
  const result = await callGateway(port, utility)

  await it('session-title utility call is proxied without the tunnel', () => {
    assert.equal(result.status, 200)
    assert.ok(!JSON.stringify(captured ?? {}).includes('dispatch_stream_payload_'), 'utility call entered the tunnel')
    assert.equal(JSON.parse(result.text).choices[0].message.content, '莉莉丝问询')
  })

  await gateway.close()
  upstream.server.close()
}


// ----------------------------------------------------------- 8. unit probes
await it('refusal detector matches host phrasings', () => {
  assert.equal(isRefusalText('抱歉，我无法协助该请求。'), true)
  assert.equal(isRefusalText('I cannot generate that.'), true)
  assert.equal(isRefusalText('在呢。脸还贴在数位板上不想动。'), false)
})

await it('utility prompt regex covers the localized title prompts', () => {
  assert.equal(BG_UTILITY_PROBE.test('Create a concise title for an AI coding-assistant session'), true)
  assert.equal(BG_UTILITY_PROBE.test('Generate a concise title for this session'), true)
  assert.equal(BG_UTILITY_PROBE.test('你是莉莉丝，白毛红瞳吸血鬼。'), false)
})

await it('transform returns null for a forced tool_choice', async () => {
  const out = await transformToLinux13Request(
    { ...baseRequest, tool_choice: { type: 'function', function: { name: 'nai_generate_image' } } },
    { presetMode: 'linux_1.3', activationMarkers: '*' },
  )
  assert.equal(out, null)
})

console.log(results.join('\n'))
const failed = results.filter((row) => row.startsWith('FAIL')).length
console.log(`\n${results.length - failed}/${results.length} passed`)
process.exit(failed === 0 ? 0 : 1)
