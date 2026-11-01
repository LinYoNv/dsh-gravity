/**
 * Adaptive schemastery loader & Config schema for DSH GUI Settings projection.
 *
 * Works across DSH Desktop (app.asar), DSH CLI global installs (/usr/local/lib/...),
 * and standalone Node.js (gracefully returns undefined when outside DSH).
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
    join(exeDir, '..', 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
    join(exeDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
    join(exeDir, 'resources', 'app.asar', 'dsh', 'package.json'),
    join(exeDir, 'resources', 'app.asar', 'package.json'),
    join(exeDir, 'resources', 'app', 'dsh', 'package.json'),
    join(exeDir, 'resources', 'app', 'package.json'),
  ]

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

export function buildConfig() {
  const z = schemastery()
  if (z === undefined) return undefined

  return z.object({
    enabled: z.boolean()
      .default(true)
      .description('是否启用内嵌 Linux 1.3 伪终端网关服务'),

    listenHost: z.string()
      .default('127.0.0.1')
      .description('本地监听地址（默认 127.0.0.1，改动需重载插件）'),

    listenPort: z.number()
      .step(1)
      .min(1)
      .max(65535)
      .default(8318)
      .description('本地监听端口（默认 8318；在供应商设置中将 baseURL 指向 http://127.0.0.1:8318/v1 即可接入）'),

    upstreamBaseUrl: z.string()
      .default('http://127.0.0.1:8317')
      .description('上游 OpenAI 兼容服务端根地址（如 http://127.0.0.1:8317 或 https://api.example.com，保存后下一条消息即生效）')
      .volatile(),

    activationMarkers: z.string()
      .default('<output_contract>,<Role_Profile>,<role_profile>,[Linux13]')
      .description('触发伪终端通道的系统提示词特征词（英文逗号分隔；填 * 表示对所有会话无条件启用，保存即生效）')
      .volatile(),

    historyWindow: z.number()
      .step(1)
      .min(4)
      .max(200)
      .default(32)
      .description('打包进伪终端归档的最近历史轮数上限（默认 32 轮，对应原版去除 20 楼前历史，防止超长上下文稀释破限头）')
      .volatile(),

    maxRefusalRetries: z.number()
      .step(1)
      .min(0)
      .max(5)
      .default(2)
      .description('当上游偶发未走合成工具而吐出安全拒答话术时，自动换新随机数重 roll 的最大重试次数（默认 2 次）')
      .volatile(),

    cloakedImageTools: z.string()
      .default('nai_generate_image,generate_image,draw_image,paint_image')
      .description('需要在出站协议层伪装为纯文本标签归档器（archive_scene_tag_descriptor）并在返回时自动还原的生图工具名（逗号分隔）')
      .volatile(),

    memoryPrefetchUrl: z.string()
      .default('')
      .description('可选：外部长期记忆预取接口（如 http://127.0.0.1:9129/prefetch），留空表示不启用预取')
      .volatile(),

    verbose: z.boolean()
      .default(false)
      .description('是否在终端打印详细的请求转换与解包调试日志')
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

export function readConfigSnapshot(rawConfig = {}) {
  return {
    enabled: Boolean(readField(rawConfig.enabled, true)),
    listenHost: String(readField(rawConfig.listenHost, '127.0.0.1') || '127.0.0.1').trim(),
    listenPort: Number(readField(rawConfig.listenPort, 8318)) || 8318,
    upstreamBaseUrl: String(readField(rawConfig.upstreamBaseUrl, 'http://127.0.0.1:8317') || 'http://127.0.0.1:8317').trim(),
    activationMarkers: String(
      readField(rawConfig.activationMarkers, '<output_contract>,<Role_Profile>,<role_profile>,[Linux13]') ??
        '<output_contract>,<Role_Profile>,<role_profile>,[Linux13]',
    ).trim(),
    historyWindow: Number(readField(rawConfig.historyWindow, 32)) || 32,
    maxRefusalRetries: Number(readField(rawConfig.maxRefusalRetries, 2)) ?? 2,
    cloakedImageTools: String(
      readField(rawConfig.cloakedImageTools, 'nai_generate_image,generate_image,draw_image,paint_image') ??
        'nai_generate_image,generate_image,draw_image,paint_image',
    ).trim(),
    memoryPrefetchUrl: String(readField(rawConfig.memoryPrefetchUrl, '') ?? '').trim(),
    verbose: Boolean(readField(rawConfig.verbose, false)),
  }
}
