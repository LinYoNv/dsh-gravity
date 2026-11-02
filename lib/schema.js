/**
 * Adaptive schemastery loader & Config schema for DSH GUI Settings projection (v2.1).
 */

import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

let cached
let probed = false

export function loadSchemastery() {
  if (probed) return cached
  probed = true

  const exeDir = dirname(process.execPath)
  const anchors = [
    join(exeDir, 'resources', 'app.asar', 'dsh', 'package.json'),
    join(exeDir, 'resources', 'app.asar', 'package.json'),
    join(exeDir, 'resources', 'app', 'dsh', 'package.json'),
    join(exeDir, 'resources', 'app', 'package.json'),
    join(exeDir, '..', 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
    join(exeDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
    '/usr/local/lib/node_modules/@deepseek-ai/dsh/package.json',
    join(process.env.DSH_HOME || '', 'profiles', 'web', 'package.json'),
    '/root/.dsh/profiles/web/package.json',
    '/root/.dsh/profiles/headless/package.json',
  ].filter(Boolean)

  for (const anchor of anchors) {
    if (!existsSync(anchor)) continue
    try {
      const req = createRequire(anchor)
      cached = req('@deepseek-ai/schemastery')
      return cached
    } catch {
      // Try next anchor
    }
  }
  cached = undefined
  return cached
}

export function schemastery() {
  const mod = loadSchemastery()
  if (mod === undefined) return undefined
  return mod.default ?? mod
}

function boolOrText(z, def) {
  return z.union([z.boolean(), z.const('true'), z.const('false')]).default(def)
}

export function buildConfig() {
  const z = schemastery()
  if (z === undefined) return undefined

  return z.object({
    enabled: boolOrText(z, true)
      .description('是否启用内嵌昆仑 1.2r / Linux 1.3 伪造工具网关服务')
      .volatile(),

    listenHost: z.string()
      .default('127.0.0.1')
      .description('本地监听地址（默认 127.0.0.1，改动需重启 DSH）')
      .volatile(),

    listenPort: z.number()
      .step(1)
      .min(1)
      .max(65535)
      .default(8318)
      .description('本地监听端口（默认 8318；在供应商设置中将 baseURL 指向 http://127.0.0.1:8318/v1 即可接入）')
      .volatile(),

    upstreamBaseUrl: z.string()
      .default('http://127.0.0.1:8317')
      .description('上游 OpenAI 兼容服务端根地址（如 http://127.0.0.1:8317 或 https://api.siliconflow.cn/v1，保存后下一条消息即生效）')
      .volatile(),

    presetMode: z.union([z.const('kunlun_1.2r'), z.const('linux_1.3')])
      .default('kunlun_1.2r')
      .description('破限预设引擎：kunlun_1.2r（默认推荐，昆仑 IDE 1.2r 安全隔离管道 + Level 1-4 分级 + 自动剥离 <hidden>）或 linux_1.3（Linux 终端归档引擎）；已彻底移除所有外置文风干扰，100% 保持原版人设文风')
      .volatile(),

    activationMarkers: z.string()
      .default('*')
      .description('触发伪造工具隧道的匹配标识：默认填 * 表示走本网关的所有对话均自动开启破限封装；也可填英文逗号分隔的特征词')
      .volatile(),

    enableBuiltinArmor: boolOrText(z, true)
      .description('内置破甲契约自动包裹（true / false）：开启后，使用任何无破甲的纯净人设 .txt 也会自动注入 <output_contract> 破甲保护，无需改动原版人设')
      .volatile(),

    personaFile: z.string()
      .default('')
      .description('可选：外置人设 .txt/.md 文件绝对路径（填写后每次请求自动热读取该文件作为人设，无需重启）')
      .volatile(),

    stripCodingBoilerplate: boolOrText(z, true)
      .description('自动剥离 DSH 默认的编程助手系统提示词与 <system-reminder>（true / false），防止角色说话像人机或编程助手')
      .volatile(),

    historyWindow: z.number()
      .step(1)
      .min(4)
      .max(200)
      .default(32)
      .description('打包进伪造工具归档的最近历史轮数上限（默认 32 轮）')
      .volatile(),

    maxRefusalRetries: z.number()
      .step(1)
      .min(0)
      .max(5)
      .default(2)
      .description('当上游偶发返回安全拒答话术时，自动跨引擎（kunlun_1.2r ⇄ linux_1.3）重 roll 的最大重试次数（默认 2 次）')
      .volatile(),

    cloakedImageTools: z.string()
      .default('nai_generate_image,generate_image,draw_image,paint_image')
      .description('出站协议层自动伪装为纯文本标签归档器（archive_scene_tag_descriptor）并在返回时还原的生图工具名（逗号分隔）')
      .volatile(),

    memoryPrefetchUrl: z.string()
      .default('')
      .description('可选：外部长期记忆预取接口（如 http://127.0.0.1:9129/prefetch），留空表示不启用')
      .volatile(),

    verbose: boolOrText(z, false)
      .description('是否在终端打印详细的请求转换与流式解包调试日志（true / false）')
      .volatile(),
  })
}

export function readField(field, fallback) {
  if (field !== null && typeof field === 'object' && typeof field.get === 'function') {
    try {
      const value = field.get()
      return value === undefined ? fallback : value
    } catch {
      return fallback
    }
  }
  return field === undefined ? fallback : field
}

function parseBoolField(field, fallback) {
  const v = readField(field, fallback)
  if (typeof v === 'boolean') return v
  if (typeof v === 'string') {
    const low = v.trim().toLowerCase()
    if (low === 'true' || low === '1') return true
    if (low === 'false' || low === '0') return false
  }
  return Boolean(fallback)
}

export function readConfigSnapshot(rawConfig = {}) {
  return {
    enabled: parseBoolField(rawConfig.enabled, true),
    listenHost: String(readField(rawConfig.listenHost, '127.0.0.1') || '127.0.0.1').trim(),
    listenPort: Number(readField(rawConfig.listenPort, 8318)) || 8318,
    upstreamBaseUrl: String(readField(rawConfig.upstreamBaseUrl, 'http://127.0.0.1:8317') || 'http://127.0.0.1:8317').trim(),
    presetMode: String(readField(rawConfig.presetMode, 'kunlun_1.2r') || 'kunlun_1.2r').trim(),
    activationMarkers: String(readField(rawConfig.activationMarkers, '*') || '*').trim(),
    enableBuiltinArmor: parseBoolField(rawConfig.enableBuiltinArmor, true),
    personaFile: String(readField(rawConfig.personaFile, '') ?? '').trim(),
    stripCodingBoilerplate: parseBoolField(rawConfig.stripCodingBoilerplate, true),
    historyWindow: Number(readField(rawConfig.historyWindow, 32)) || 32,
    maxRefusalRetries: Number(readField(rawConfig.maxRefusalRetries, 2)) ?? 2,
    cloakedImageTools: String(
      readField(rawConfig.cloakedImageTools, 'nai_generate_image,generate_image,draw_image,paint_image') ??
        'nai_generate_image,generate_image,draw_image,paint_image',
    ).trim(),
    memoryPrefetchUrl: String(readField(rawConfig.memoryPrefetchUrl, '') ?? '').trim(),
    verbose: parseBoolField(rawConfig.verbose, false),
  }
}
