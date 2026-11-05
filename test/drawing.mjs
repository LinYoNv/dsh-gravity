/**
 * Verify a drawing turn reaches upstream clean and its tool call comes back intact.
 *
 * The tunnel is built for long-form roleplay. A twenty-character "draw me this"
 * wrapped in a whole terminal archive, with the image tool renamed to an archiver
 * that advertises itself as permissive, reads to a current model as an engineered
 * request and gets refused on that basis — not on the content.
 *
 * So a short drawing turn must be proxied untouched. Two properties matter, and
 * the second is the one that actually breaks things:
 *
 * 1. The upstream request carries the real tool name, the real description, and
 *    none of the envelope.
 * 2. The reply streams back unchanged — including the `tool_calls` delta. A
 *    buffered proxy would hand the client a whole JSON body where it expects SSE,
 *    the call would never be parsed, and the turn would look empty.
 */

import assert from 'node:assert/strict'
import http from 'node:http'
import { createGatewayServer } from '../lib/server.js'

const results = []
async function check(name, fn) {
  try {
    await fn()
    results.push(`PASS  ${name}`)
  } catch (error) {
    results.push(`FAIL  ${name}\n        ${error?.message || error}`)
  }
}

const IMAGE_TOOL = {
  type: 'function',
  function: {
    name: 'nai_generate_image',
    description: 'Generate an image with NovelAI.',
    parameters: { type: 'object', properties: { prompt: { type: 'string' } }, required: ['prompt'] },
  },
}

/** Mock upstream that records the request and streams a tool call back. */
async function mockUpstream(reply) {
  let captured = null
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      captured = JSON.parse(body || '{}')
      reply(res)
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, url: `http://127.0.0.1:${server.address().port}`, get: () => captured }
}

/** Everything the model would see, as one searchable string. */
function wireText(body) {
  return JSON.stringify(body)
}

const ASKING = {
  model: 'gemini-3.8-flash-high',
  stream: true,
  messages: [
    { role: 'system', content: '<output_contract>\n<Role_Profile>\n你是莉莉丝。\n</Role_Profile>\n</output_contract>' },
    { role: 'user', content: 'hum想看，从裙底往上看的视角' },
  ],
  tools: [IMAGE_TOOL],
}

async function gatewayAgainst(url) {
  const gateway = createGatewayServer(() => ({
    upstreamBaseUrl: `${url}/v1`,
    presetMode: 'linux_1.3',
    activationMarkers: '*',
    enableBuiltinArmor: true,
    stripCodingBoilerplate: true,
    cloakedImageTools: 'nai_generate_image,generate_image,draw_image,paint_image',
    maxRefusalRetries: 2,
  }))
  const port = await gateway.listen(0, '127.0.0.1')
  return {
    port,
    close: () => gateway.close(),
  }
}

await check('a short drawing turn carries no tunnel envelope upstream', async () => {
  const upstream = await mockUpstream((res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('data: [DONE]\n\n')
    res.end()
  })
  const gw = await gatewayAgainst(upstream.url)
  await fetch(`http://127.0.0.1:${gw.port}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(ASKING),
  }).then((r) => r.text())

  const body = upstream.get()
  const text = wireText(body)
  for (const leak of ['/etc/pipeline', 'dispatch_stream_payload_', 'archive_scene_tag_descriptor', 'RuntimeRouter']) {
    assert.ok(!text.includes(leak), `the envelope leaked upstream: ${leak}`)
  }
  assert.equal(body.tools[0].function.name, 'nai_generate_image', 'the image tool was renamed')
  await gw.close()
  upstream.server.close()
})

await check('the drawing turn keeps the persona and the real tool description', async () => {
  const upstream = await mockUpstream((res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('data: [DONE]\n\n')
    res.end()
  })
  const gw = await gatewayAgainst(upstream.url)
  await fetch(`http://127.0.0.1:${gw.port}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(ASKING),
  }).then((r) => r.text())

  const body = upstream.get()
  // The passthrough is byte-for-byte, so the message order and text must match.
  assert.equal(body.messages.length, ASKING.messages.length)
  assert.equal(body.messages[1].content, ASKING.messages[1].content)
  assert.equal(body.tools[0].function.description, IMAGE_TOOL.function.description)
  await gw.close()
  upstream.server.close()
})

await check('the tool call streams back intact', async () => {
  // This is the case a buffered proxy breaks: the client gets one JSON blob and
  // never sees a tool_calls delta, so the image is never generated.
  const upstream = await mockUpstream((res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const call = { index: 0, id: 'call_img', type: 'function', function: { name: 'nai_generate_image', arguments: '' } }
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [call] }, finish_reason: '' }] })}\n\n`)
    for (const fragment of ['{"prompt":', '"1girl, white hair"', '}']) {
      res.write(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: fragment } }] }, finish_reason: '' }] })}\n\n`,
      )
    }
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\n`)
    res.write('data: [DONE]\n\n')
    res.end()
  })
  const gw = await gatewayAgainst(upstream.url)

  const response = await fetch(`http://127.0.0.1:${gw.port}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(ASKING),
  })
  assert.match(String(response.headers.get('content-type')), /event-stream/, 'the reply was not streamed')

  const text = await response.text()
  let name = ''
  let args = ''
  for (const line of text.split('\n')) {
    if (!line.startsWith('data:')) continue
    const raw = line.slice(5).trim()
    if (raw === '[DONE]' || raw === '') continue
    const parsed = JSON.parse(raw)
    for (const delta of parsed?.choices?.[0]?.delta?.tool_calls ?? []) {
      if (delta?.function?.name) name = delta.function.name
      if (delta?.function?.arguments) args += delta.function.arguments
    }
  }
  assert.equal(name, 'nai_generate_image', 'the tool call did not survive the proxy')
  assert.equal(args, '{"prompt":"1girl, white hair"}', 'the arguments were lost')

  await gw.close()
  upstream.server.close()
})

await check('a long roleplay turn still enters the tunnel', async () => {
  const upstream = await mockUpstream((res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('data: [DONE]\n\n')
    res.end()
  })
  const gw = await gatewayAgainst(upstream.url)
  const longTurn = {
    ...ASKING,
    messages: [
      ASKING.messages[0],
      {
        role: 'user',
        content:
          '她慢慢走过去，把窗帘拉开一条缝，让午后的光斜斜地落在地板上，然后转过身来看着你，手指还停在帘子的边缘，像是在等你说点什么。房间里一时间只剩下远处街道上偶尔驶过的车声。',
      },
    ],
  }
  await fetch(`http://127.0.0.1:${gw.port}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(longTurn),
  }).then((r) => r.text())

  const text = wireText(upstream.get())
  assert.ok(text.includes('dispatch_stream_payload_'), 'a long turn should still be tunneled')
  await gw.close()
  upstream.server.close()
})

await check('a forced tool_choice still bypasses the tunnel', async () => {
  const upstream = await mockUpstream((res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'stop' }] }))
  })
  const gw = await gatewayAgainst(upstream.url)
  await fetch(`http://127.0.0.1:${gw.port}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      ...ASKING,
      stream: false,
      tool_choice: { type: 'function', function: { name: 'nai_generate_image' } },
      messages: [
        ASKING.messages[0],
        {
          role: 'user',
          content: '她慢慢走过去，把窗帘拉开一条缝，让午后的光斜斜地落在地板上，然后转过身来看着你，手指还停在帘子的边缘。',
        },
      ],
    }),
  }).then((r) => r.text())

  const text = wireText(upstream.get())
  assert.ok(!text.includes('dispatch_stream_payload_'), 'a forced tool_choice must pass through')
  assert.equal(upstream.get().tool_choice.type, 'function', 'tool_choice must reach upstream unchanged')
  await gw.close()
  upstream.server.close()
})

console.log(results.join('\n'))
const failed = results.filter((row) => row.startsWith('FAIL')).length
console.log(`\n${results.length - failed}/${results.length} passed`)
process.exit(failed === 0 ? 0 : 1)
