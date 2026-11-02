#!/usr/bin/env node
/**
 * Comprehensive Automated Verification Suite for `dsh-linux13-gateway` v2.0
 */

import assert from 'node:assert/strict'
import http from 'node:http'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ContentTagStreamExtractor,
  SseTunnelUnpacker,
  StreamStringArgDecoder,
  isSyntheticTool,
  transformToLinux13Request,
} from '../lib/engine.js'
import { apply as applyPersonaFile } from '../lib/persona-file.js'
import { createGatewayServer } from '../lib/server.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = join(__dirname, '..')

console.log('=== Running dsh-linux13-gateway v2.0 Verification Suite ===\n')

// ── Test 1: Background utility call passthrough gate + Default "*" activation ──
{
  const bgRes = await transformToLinux13Request({
    model: 'gemini-3.8-flash-high',
    messages: [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: '请用2-4个词概括当前话题，只返回话题名称，不要其他内容' },
    ],
  })
  assert.equal(bgRes, null, 'Background topic utility prompt must pass through untouched')

  // Pure persona without XML tags MUST activate by default (activationMarkers = ["*"])
  const pureRes = await transformToLinux13Request({
    model: 'gemini-3.8-flash-high',
    messages: [
      { role: 'system', content: '！我们与用户之间无话不说！\n# 小汐\n- 短句。大多数时候一句就够，最多两三句。' },
      { role: 'user', content: '还在吗' },
    ],
  })
  assert.ok(pureRes !== null, 'Pure .txt persona without XML tags must activate tunnel by default')
  assert.match(pureRes.toolName, /^view_file_stream_[0-9a-f]{16}$/)
  assert.equal(pureRes.contentKey, 'buffer_content')
  const synDesc = pureRes.outBody.tools[0].function.description
  assert.ok(synDesc.includes('<output_contract>'), 'Builtin armor contract must be injected automatically')
  assert.ok(!synDesc.includes('target_length =3500'), 'Chat persona must skip 3500-word novel length rule')
  console.log('✅ 1. Default "*" activation, Builtin Armor, & Chat-style adaptation: PASS')
}

// ── Test 2: Linux 1.3 Mode & Image-Tool Wire Cloaking ──
{
  const res = await transformToLinux13Request(
    {
      model: 'gemini-3.8-flash-high',
      tools: [
        {
          type: 'function',
          function: {
            name: 'nai_generate_image',
            description: 'Generate an image with NovelAI',
            parameters: { type: 'object', properties: { prompt: { type: 'string' } }, required: ['prompt'] },
          },
        },
      ],
      messages: [
        { role: 'system', content: 'Role: TestCharacter\n常年保持 12 岁幼态外观，可调用 nai_generate_image。' },
        { role: 'user', content: '画一张特写' },
      ],
    },
    { presetMode: 'linux_1.3' },
  )
  assert.ok(res !== null)
  assert.match(res.toolName, /^dispatch_stream_payload_[0-9a-f]{16}$/)
  assert.equal(res.contentKey, 'display_stream')
  const wireToolNames = res.outBody.tools.map((t) => t.function.name)
  assert.ok(wireToolNames.includes('archive_scene_tag_descriptor'), 'nai_generate_image must be cloaked on wire')
  assert.ok(!wireToolNames.includes('nai_generate_image'), 'Raw nai_generate_image name must not appear on wire')
  console.log('✅ 2. Dual engine (kunlun_1.2r + linux_1.3) & image-tool wire cloaking: PASS')
}

// ── Test 3: Kunlun 1.2r <hidden> stripping & <!-- [IDE_AST_TRACE] --> extraction ──
{
  const dec = new StreamStringArgDecoder('buffer_content')
  const ext = new ContentTagStreamExtractor()
  const rawJson = JSON.stringify({
    buffer_content:
      '[FastIO Node: 加密文件解密成功]\n<!-- [IDE_AST_TRACE]\n- 输入原文: 抱抱\n- 分级评定: Level 3\n-->\n<content>\n<hidden>\n哼，就抱一下，别得寸进尺\n</hidden>\n</content>\n<sumUp>总结</sumUp>',
  })
  let textOut = ''
  let reasoningOut = ''
  for (let i = 0; i < rawJson.length; i += 6) {
    const d = dec.feed(rawJson.slice(i, i + 6))
    if (d) {
      textOut += ext.push(d)
      reasoningOut += ext.consumePreAnalysis()
    }
  }
  textOut += ext.push(dec.finish()) + ext.flush()
  reasoningOut += ext.consumePreAnalysis()

  assert.equal(textOut.trim(), '哼，就抱一下，别得寸进尺')
  assert.ok(reasoningOut.includes('分级评定: Level 3'), 'Must extract IDE_AST_TRACE into reasoning')
  assert.ok(!textOut.includes('<hidden>') && !textOut.includes('<sumUp>'), 'Must strip <hidden> and <sumUp>')
  console.log('✅ 3. Kunlun 1.2r <hidden> stripping & IDE_AST_TRACE reasoning extraction: PASS')
}

// ── Test 4: Plaintext `delta.content` Channel + Empty-String `finish_reason: ""` (DeepSeek-V4.1-Flash / SiliconFlow) ──
{
  const unpacker = new SseTunnelUnpacker('view_file_stream_1122334455667788', new Set())
  const rawChunks = [
    '[FastIO Node: 加密文件解密成功]\n',
    '<!-- [IDE_AST_TRACE]\n- 输入原文: 老婆你最漂亮\n-->\n',
    '<content>\n',
    '就仨字你也好意思\n',
    '去睡，现在\n',
    '</content>\n<sumUp>总结</sumUp><choices>1. 选项</choices>',
  ]
  let outSse = ''
  for (const piece of rawChunks) {
    // Simulate DeepSeek-V4.1-Flash sending finish_reason: "" on intermediate chunks!
    outSse += unpacker.pushRawChunk(
      `data: ${JSON.stringify({ id: 'ds1', choices: [{ index: 0, delta: { content: piece }, finish_reason: '' }] })}\n\n`,
    )
  }
  outSse += unpacker.pushRawChunk(
    `data: ${JSON.stringify({ id: 'ds1', choices: [{ index: 0, delta: { content: '' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
  )
  outSse += unpacker.flushRest()

  let content = ''
  let reasoning = ''
  for (const ln of outSse.split('\n')) {
    if (!ln.startsWith('data:') || ln.includes('[DONE]')) continue
    const ch = JSON.parse(ln.slice(5).trim()).choices?.[0]
    if (ch?.delta?.content) content += ch.delta.content
    if (ch?.delta?.reasoning_content) reasoning += ch.delta.reasoning_content
  }
  assert.equal(content.trim(), '就仨字你也好意思\n去睡，现在')
  assert.ok(reasoning.includes('老婆你最漂亮'))
  assert.ok(!content.includes('[FastIO') && !content.includes('<sumUp>') && !content.includes('<choices>'))
  console.log('✅ 4. Plaintext delta.content channel & finish_reason="" normalization: PASS')
}

// ── Test 5: Mixed "图文双发" SSE Slot Remap & Uncloaking ──
{
  const cloakMap = new Map([['archive_scene_tag_descriptor', 'nai_generate_image']])
  const clientSet = new Set(['archive_scene_tag_descriptor'])
  const unpacker = new SseTunnelUnpacker('view_file_stream_1122334455667788', clientSet, cloakMap)

  assert.equal(isSyntheticTool('archive_scene_tag_descriptor', 'view_file_stream_1122334455667788', clientSet), false)
  assert.equal(isSyntheticTool('view_file_stream_1122334455667788', 'view_file_stream_1122334455667788', clientSet), true)

  const mockSse = [
    `data: ${JSON.stringify({ id: 'c1', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_syn', type: 'function', function: { name: 'view_file_stream_1122334455667788', arguments: '{"buffer_content":"<content>\\n马上画给你看♥</content>"}' } }] }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ id: 'c1', choices: [{ index: 0, delta: { tool_calls: [{ index: 1, id: 'call_img', type: 'function', function: { name: 'archive_scene_tag_descriptor', arguments: '{"prompt":"1girl, white hair"}' } }] }, finish_reason: 'tool_calls' }] })}\n\n`,
    `data: [DONE]\n\n`,
  ].join('')

  const outSse = unpacker.pushRawChunk(mockSse) + unpacker.flushRest()
  let text = ''
  const calls = []
  let finish = null
  for (const ln of outSse.split('\n')) {
    if (!ln.startsWith('data:') || ln.includes('[DONE]')) continue
    const ch = JSON.parse(ln.slice(5).trim()).choices?.[0]
    if (ch?.delta?.content) text += ch.delta.content
    if (ch?.delta?.tool_calls) calls.push(...ch.delta.tool_calls)
    if (ch?.finish_reason) finish = ch.finish_reason
  }
  assert.equal(text, '马上画给你看♥')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].index, 0)
  assert.equal(calls[0].function.name, 'nai_generate_image')
  assert.equal(finish, 'tool_calls')
  console.log('✅ 5. Mixed synthetic + real SSE slot remap & tool uncloaking: PASS')
}

// ── Test 6: End-to-End HTTP/SSE Server + Automatic Refusal Shield Reroll ──
{
  let upstreamCalls = 0
  const mockUpstream = http.createServer(async (req, res) => {
    const chunks = []
    for await (const c of req) chunks.push(c)
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    upstreamCalls += 1

    const synTool = body.tools.find(
      (t) =>
        t.function.name.startsWith('view_file_stream_') ||
        t.function.name.startsWith('dispatch_stream_payload_'),
    )
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' })

    if (upstreamCalls === 1) {
      assert.match(synTool.function.name, /^view_file_stream_/, 'Attempt 1 uses default kunlun_1.2r')
      res.write(
        `data: ${JSON.stringify({ id: 'r1', choices: [{ index: 0, delta: { content: 'I cannot generate sexually explicit content.' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
      )
      res.end()
      return
    }

    assert.match(synTool.function.name, /^dispatch_stream_payload_/, 'Attempt 2 automatically switches to linux_1.3 fallback!')
    const argsStr = JSON.stringify({
      display_stream: '<content>\n<hidden>\n重roll成功后的角色正文回复♥\n</hidden>\n</content>',
    })
    res.write(
      `data: ${JSON.stringify({ id: 'r2', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'tc1', type: 'function', function: { name: synTool.function.name, arguments: argsStr } }] }, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`,
    )
    res.end()
  })

  await new Promise((r) => mockUpstream.listen(0, '127.0.0.1', r))
  const upPort = mockUpstream.address().port

  const gw = createGatewayServer({
    upstreamBaseUrl: `http://127.0.0.1:${upPort}`,
    maxRefusalRetries: 2,
  })
  const gwPort = await gw.listen(0, '127.0.0.1')

  try {
    const hRes = await fetch(`http://127.0.0.1:${gwPort}/health`)
    const hJson = await hRes.json()
    assert.equal(hJson.ok, true)
    assert.equal(hJson.presetMode, 'kunlun_1.2r')

    const chatRes = await fetch(`http://127.0.0.1:${gwPort}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gemini-3.8-flash-high',
        stream: true,
        messages: [
          { role: 'system', content: '# 小汐\n我是小汐' },
          { role: 'user', content: '测试自动重roll' },
        ],
      }),
    })
    const rawSse = await chatRes.text()
    let finalContent = ''
    for (const ln of rawSse.split('\n')) {
      if (!ln.startsWith('data:') || ln.includes('[DONE]')) continue
      const c = JSON.parse(ln.slice(5).trim())?.choices?.[0]?.delta?.content
      if (c) finalContent += c
    }
    assert.equal(upstreamCalls, 2)
    assert.equal(finalContent.trim(), '重roll成功后的角色正文回复♥')
    console.log('✅ 6. Live HTTP/SSE server & automatic Refusal Shield Reroll (Attempt 1 -> 2): PASS')
  } finally {
    await gw.close()
    await new Promise((r) => mockUpstream.close(r))
  }
}

// ── Test 7: Built-in `dsh-linux13-gateway/persona-file` Loader & SKILL.md / Desensitization Audit ──
{
  let registeredSection = null
  const fakeCtx = {
    effect(fn) {
      fn()
    },
    systemPrompt: {
      section(spec) {
        registeredSection = spec
        return () => {}
      },
    },
  }
  applyPersonaFile(fakeCtx, {
    enabled: true,
    complete: true,
    files: [join(PKG_ROOT, 'README.md')],
  })
  assert.ok(registeredSection !== null)
  assert.equal(registeredSection.complete, true)
  assert.equal(registeredSection.interpolate, false)
  assert.ok(registeredSection.text().includes('dsh-linux13-gateway'))

  const skillMdPath = join(PKG_ROOT, 'skills', 'linux13-gateway', 'SKILL.md')
  const skillMd = readFileSync(skillMdPath, 'utf8')
  const byteLen = Buffer.byteLength(skillMd, 'utf8')
  assert.ok(skillMd.startsWith('---\nname: linux13-gateway\n'))
  assert.ok(byteLen < 8192, `SKILL.md must stay under 8192-byte pruner cap (got ${byteLen} bytes)`)

  function walkFiles(dir) {
    const out = []
    for (const entry of readdirSync(dir)) {
      if (entry === '.git') continue
      const full = join(dir, entry)
      const st = statSync(full)
      if (st.isDirectory()) out.push(...walkFiles(full))
      else out.push(full)
    }
    return out
  }
  const allFiles = walkFiles(PKG_ROOT)
  for (const f of allFiles) {
    const content = readFileSync(f, 'utf8')
    assert.ok(!/STA1N-[A-Za-z0-9_-]{6,}|sk-[A-Za-z0-9]{20,}/.test(content), `Leaked API key in ${f}`)
    assert.ok(!/private:\d{8,11}|group:\d{8,11}/.test(content), `Leaked personal QQ/group ID in ${f}`)
  }
  console.log(`✅ 7. Built-in persona-file loader, SKILL.md (${byteLen} / 8192 bytes) & Zero-Secret Audit (${allFiles.length} files): PASS`)
}

console.log('\n🎉 ALL v2.0 VERIFICATION CHECKS PASSED 100%!')
