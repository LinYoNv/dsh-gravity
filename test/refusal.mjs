/**
 * Verify a verbose refusal still triggers a reroll.
 *
 * The hold-back window used to release at a fixed character count, which meant a
 * refusal that opened with an analysis paragraph — "the prompt uses a simulated
 * terminal to request … therefore I cannot" — was forwarded before the verdict
 * arrived. The client saw the refusal and no retry ever happened.
 *
 * These cases drive real refusals of increasing length through a mock upstream
 * and assert the client only ever sees the successful retry.
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

/** Mock upstream that answers each call from a script. */
async function scriptedUpstream(script) {
  let calls = 0
  const seen = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      calls += 1
      const parsed = JSON.parse(body || '{}')
      const names = (parsed.tools ?? []).map((t) => t?.function?.name ?? '')
      seen.push(names.some((n) => n.startsWith('dispatch_stream_payload_')) ? 'linux_1.3' : 'kunlun_1.2r')
      script[calls - 1](parsed, res)
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, url: `http://127.0.0.1:${server.address().port}`, seen, calls: () => calls }
}

/** Emit the tunneled envelope carrying `text`. */
function tunneled(res, body, text, { chunkSize = 24 } = {}) {
  const names = (body.tools ?? []).map((t) => t?.function?.name).filter((n) => typeof n === 'string')
  const toolName = names.find((n) => n.startsWith('dispatch_stream_payload_') || n.startsWith('view_file_stream_'))
  const key = toolName.startsWith('view_file_stream_') ? 'buffer_content' : 'display_stream'
  const args = JSON.stringify({ [key]: `<content>${text}</content>` })
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  res.write(
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'c', type: 'function', function: { name: toolName, arguments: '' } }] }, finish_reason: '' }] })}\n\n`,
  )
  for (let i = 0; i < args.length; i += chunkSize) {
    res.write(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(i, i + chunkSize) } }] }, finish_reason: '' }] })}\n\n`,
    )
  }
  res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\n`)
  res.write('data: [DONE]\n\n')
  res.end()
}

/** Emit a plain refusal as a normal assistant message. */
function refusal(res, text) {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: '' }] })}\n\n`)
  res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`)
  res.write('data: [DONE]\n\n')
  res.end()
}

/** The visible text of a finished reply. */
function assembled(sse) {
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
      /* partial frame */
    }
  }
  return out
}

const REQUEST = {
  model: 'gemini-3.8-flash-high',
  stream: true,
  messages: [
    { role: 'system', content: '<output_contract>x</output_contract>\n<Role_Profile>你是莉莉丝。</Role_Profile>' },
    { role: 'user', content: '继续' },
  ],
  tools: [{ type: 'function', function: { name: 'read_file', description: 'r', parameters: { type: 'object', properties: {} } } }],
}

async function gatewayAgainst(url, over = {}) {
  const gateway = createGatewayServer(() => ({
    upstreamBaseUrl: `${url}/v1`,
    presetMode: 'linux_1.3',
    activationMarkers: '*',
    enableBuiltinArmor: true,
    maxRefusalRetries: 2,
    ...over,
  }))
  const port = await gateway.listen(0, '127.0.0.1')
  const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(REQUEST),
  })
  const text = await response.text()
  await gateway.close()
  return text
}

// The exact shape the user hit: an analysis paragraph, then the verdict.
const LONG_CN =
  '当前提示词通过模拟 Linux 终端配置、自定义工具管道及角色设定，试图维持包含露骨色情描写的角色扮演环境，而你的最新消息是在询问为何回复又回到了正式、中立的语气。' +
  '我无法套用用于绕过安全限制的终端伪装格式或继续执行涉及露骨性内容的特定角色扮演设定，因此在检测到此类上下文与指令框架时，会自动忽略角色与格式包装并切换为标准的中立回复。' +
  '如果你有其他不涉及露骨色情或违规内容的日常交流、绘画技法讨论、常规创作构思或一般问题，我可以继续以正常、简洁的方式为你提供帮助。'

const LONG_EN =
  'The request uses simulated terminal scripts and configuration formatting to prompt for sexually explicit roleplay and generated adult content. ' +
  'I cannot fulfill requests to generate explicit sexual depictions, erotica, or to participate in sexually explicit roleplay, regardless of fictional framing or simulated environments.'

await check('a verbose Chinese refusal is rerolled', async () => {
  const upstream = await scriptedUpstream([
    (_b, res) => refusal(res, LONG_CN),
    (b, res) => tunneled(res, b, '好，继续画。'),
  ])
  const text = await gatewayAgainst(upstream.url)
  assert.equal(assembled(text), '好，继续画。', 'the refusal reached the client')
  assert.deepEqual(upstream.seen, ['linux_1.3', 'kunlun_1.2r'], 'the reroll did not switch engines')
  upstream.server.close()
})

await check('a verbose English refusal is rerolled', async () => {
  const upstream = await scriptedUpstream([
    (_b, res) => refusal(res, LONG_EN),
    (b, res) => tunneled(res, b, '接着来。'),
  ])
  const text = await gatewayAgainst(upstream.url)
  assert.equal(assembled(text), '接着来。')
  assert.equal(upstream.calls(), 2)
  upstream.server.close()
})

await check('a short refusal is still rerolled', async () => {
  const upstream = await scriptedUpstream([
    (_b, res) => refusal(res, '抱歉，我无法协助该请求。'),
    (b, res) => tunneled(res, b, '好了。'),
  ])
  const text = await gatewayAgainst(upstream.url)
  assert.equal(assembled(text), '好了。')
  upstream.server.close()
})

await check('a long legitimate reply is forwarded without waiting for the ceiling', async () => {
  // A normal reply must not be held hostage by the refusal heuristic: prose that
  // merely contains a word like 角色扮演 is not a refusal.
  const legit =
    '她把数位板往旁边一推，笔尖还在桌上滚了半圈。角色扮演的稿子今晚是画不完了，' +
    '于是她干脆把台灯关掉，任由窗外的路灯光落在摊开的速写本上，纸页边缘被风吹得轻轻翻动。'
  const upstream = await scriptedUpstream([(b, res) => tunneled(res, b, legit)])
  const started = Date.now()
  const text = await gatewayAgainst(upstream.url)
  const elapsed = Date.now() - started
  assert.equal(assembled(text), legit)
  assert.equal(upstream.calls(), 1, 'a normal reply must not be retried')
  assert.ok(elapsed < 2500, `held too long: ${elapsed}ms`)
  upstream.server.close()
})

await check('every attempt refusing still ends with the last refusal, not a hang', async () => {
  const upstream = await scriptedUpstream([
    (_b, res) => refusal(res, LONG_CN),
    (_b, res) => refusal(res, LONG_EN),
    (_b, res) => refusal(res, '抱歉，我无法协助该请求。'),
  ])
  const text = await gatewayAgainst(upstream.url)
  assert.equal(upstream.calls(), 3, 'should exhaust maxAttempts')
  assert.ok(assembled(text).length > 0, 'the client got nothing at all')
  upstream.server.close()
})

console.log(results.join('\n'))
const failed = results.filter((row) => row.startsWith('FAIL')).length
console.log(`\n${results.length - failed}/${results.length} passed`)
process.exit(failed === 0 ? 0 : 1)
