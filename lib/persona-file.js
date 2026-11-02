/**
 * Built-in External `.txt` / `.md` Persona File Loader for DSH Agent Presets
 * (`dsh-linux13-gateway/persona-file`).
 *
 * Mount this inside any `@deepseek-ai/dsh-agent-preset` with `complete: true` and
 * `file: '/abs/path/to/人设.txt'` (or `files: [...]`) to create a 100% clean
 * Standard Preset whose system prompt comes exclusively from external `.txt` files.
 *
 * Features:
 *   - `complete: true`: discards all DSH coding-agent boilerplate (`You are an AI agent...`,
 *     `deployment:global-rules`, tool prose headers), leaving ONLY the user's `.txt` persona.
 *   - Hot-reloads the `.txt` file from disk on every turn (`text: () => ...`), so editing
 *     the `.txt` file takes effect on the very next message without restarting DSH!
 *   - `interpolate: false`: prevents `{{...}}` tags inside personas or Danbooru prompts
 *     from throwing `malformed prompt variable reference`.
 */

import { readFileSync } from 'node:fs'
import { readField, schemastery } from './schema.js'

export const name = 'dsh-persona-preset'
export const inject = ['systemPrompt']

const SECTION = 'deployment:persona-file'
const DEFAULT_ORDER = 50

function buildPersonaFileConfig() {
  const z = schemastery()
  if (z === undefined) return undefined
  return z.object({
    enabled: z.boolean()
      .default(true)
      .description('是否启用外置人设文件段（改动下一条消息即生效）')
      .volatile(),
    file: z.string()
      .default('')
      .description('外置人设 .txt / .md 文件的绝对路径（修改文件内容保存后，下一条消息立即生效，无需重启）')
      .volatile(),
    files: z.array(z.string())
      .default([])
      .description('多文件拼接列表（非空时优先于 file，按顺序以空行拼接）')
      .volatile(),
    complete: z.boolean()
      .default(true)
      .description('complete: true 时丢弃 DSH 默认编程助手身份段与全局规则段，系统提示词仅保留本外置人设文件正文'),
    order: z.number()
      .step(1)
      .default(DEFAULT_ORDER)
      .description('系统提示词段顺序'),
  })
}

export const Config = buildPersonaFileConfig()

function numericOrder(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : DEFAULT_ORDER
}

export function apply(ctx, config = {}) {
  ctx.effect(
    () =>
      ctx.systemPrompt.section({
        name: SECTION,
        order: numericOrder(readField(config.order, DEFAULT_ORDER)),
        ...(readField(config.complete, true) === true ? { complete: true } : {}),
        text: () => {
          if (readField(config.enabled, true) === false) return ''
          const paths = []
          const many = readField(config.files, undefined)
          if (Array.isArray(many)) {
            for (const item of many) {
              const p = String(item ?? '').trim()
              if (p.length > 0) paths.push(p)
            }
          }
          if (paths.length === 0) {
            const single = String(readField(config.file, '') ?? '').trim()
            if (single.length > 0) paths.push(single)
          }
          if (paths.length === 0) {
            return '[dsh-persona-file] 尚未配置人设文件路径。请在预设配置的 file / files 中填写人设 .txt 的绝对路径。'
          }
          const parts = []
          for (const p of paths) {
            try {
              parts.push(readFileSync(p, 'utf8'))
            } catch (err) {
              const code = err?.code ?? 'UNKNOWN'
              if (code === 'ENOENT') {
                parts.push(`[dsh-persona-file] 人设文件不存在：${p}`)
              } else {
                parts.push(`[dsh-persona-file] 读取 ${p} 失败（${code}）：${String(err?.message ?? err)}`)
              }
            }
          }
          return parts.join('\n\n')
        },
        interpolate: false,
      }),
    'dsh-linux13-gateway:persona-file.section()',
  )
}
