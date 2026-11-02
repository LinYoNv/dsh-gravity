/**
 * Browser client half for `dsh-linux13-gateway`:
 * Registers the dedicated Settings page under DSH's `plugins.item` slot
 * ("内置插件配置 -> 昆仑 1.2r / Linux 1.3 伪造工具网关") so users can edit
 * upstreamBaseUrl, presetMode, personaFile, activationMarkers, and retry
 * settings directly in the Web GUI and save with one click.
 */

window.__ModuleLoader__.load({
  id: 'dsh-linux13-gateway',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')

    const {
      SettingsForm,
      SettingsFormModel,
      SettingsValueField,
      settingsNumberField,
      settingsTextField,
    } = primitives

    const h = React.createElement

    const NS = 'dsh-linux13-gateway'
    const LOCALE_NS = 'dsh-linux13-gateway'

    const zh = {
      title: '昆仑 1.2r / Linux 1.3 伪造工具网关',
      description: '昆仑 IDE 1.2r 与 Linux 1.3 双引擎流式破限隧道：零文风干扰、内置自动破甲契约、支持外置 .txt 人设直读与跨引擎防拒答重 roll。',
      unavailable: '宿主未提供该插件的设置，暂时无法配置。若刚装好，请重启一次 DSH。',
      readOnly: '本部署的设置为只读。',
      save: '保存',
      saving: '保存中…',
      saveFailed: '本部署没有接受这些值，已保留供你修改。',
      invalidNumber: '请填数字；留空表示使用默认值。',
      overridden: '已覆盖',
      reset: '恢复默认',

      groupConnection: '网关监听与上游连接',
      groupEngine: '破限引擎与外置人设（零文风污染）',
      groupShield: '防拒答重 Roll 与工具伪装',

      enabled: '启用内嵌网关服务',
      enabledHint: 'true / false。开启后随 DSH 进程自动监听本地端口。',
      listenHost: '本地监听地址',
      listenHostHint: '默认 127.0.0.1。修改监听地址或端口后需重启 DSH 生效。',
      listenPort: '本地监听端口',
      listenPortHint: '默认 8318。将供应商的 baseURL 设为 http://127.0.0.1:8318/v1 即可走本破限隧道。',
      upstreamBaseUrl: '真实上游服务地址 (upstreamBaseUrl)',
      upstreamBaseUrlHint: '填你的 OpenAI 兼容中转站地址（如 http://127.0.0.1:8317 或 https://api.siliconflow.cn/v1）。保存后下一条消息立即生效！',

      presetMode: '破限预设引擎 (presetMode)',
      presetModeHint: '可选 kunlun_1.2r（默认推荐，昆仑 IDE 1.2r 安全隔离管道 + Level 1-4 分级豁免 + 自动剥除 <hidden>）或 linux_1.3（Linux 终端归档引擎）。已彻底移除所有外置文风/禁词表干扰，100% 保持你的人设原味！',
      activationMarkers: '触发匹配标识 (activationMarkers)',
      activationMarkersHint: '默认填 * 表示走 8318 端口的所有对话均开启破限封装（后台短标题任务自动放行）；也可填英文逗号分隔的特征词。',
      enableBuiltinArmor: '内置自动破甲契约 (enableBuiltinArmor)',
      enableBuiltinArmorHint: 'true / false（默认 true）。开启后无需修改你的原版人设 .txt，网关会在出站时自动包裹 <output_contract> 破甲与成年创作护栏。',
      personaFile: '外置人设 .txt 绝对路径 (personaFile)',
      personaFileHint: '可选。直接填写磁盘上人设 .txt / .md 的绝对路径，每次发消息时自动热读取该文件作为人设，改文件保存后下一条消息立即生效！',
      stripCodingBoilerplate: '剥离 DSH 默认编程提示词 (stripCodingBoilerplate)',
      stripCodingBoilerplateHint: 'true / false（默认 true）。自动剥离 DSH 默认注入的编程助手身份段与 <system-reminder>，防止角色说话像人机。',

      historyWindow: '历史上下文滑窗轮数 (historyWindow)',
      historyWindowHint: '默认 32 轮。自动过滤历史中的残留拒答，防止长对话稀释破限强度。',
      maxRefusalRetries: '拒答跨引擎重 Roll 次数 (maxRefusalRetries)',
      maxRefusalRetriesHint: '默认 2 次。若第 1 次偶发被拦截，第 2 次会自动切换到另一套引擎（kunlun_1.2r ⇄ linux_1.3）刷新随机种子重试。',
      cloakedImageTools: '自动伪装的生图工具名 (cloakedImageTools)',
      cloakedImageToolsHint: '英文逗号分隔（默认 nai_generate_image,generate_image,draw_image,paint_image）。出站自动伪装为纯文本标签归档器以绕过生图工具审查，返回时自动还原。',
      memoryPrefetchUrl: '外部长期记忆预取接口 (memoryPrefetchUrl)',
      memoryPrefetchUrlHint: '可选（如 http://127.0.0.1:9129/prefetch），留空表示不启用。',
      verbose: '输出详细调试日志 (verbose)',
      verboseHint: 'true / false（默认 false）。',
    }

    const en = {
      title: 'Kunlun 1.2r / Linux 1.3 ToolCall Tunnel Gateway',
      description: 'Dual-engine (Kunlun IDE 1.2r & Linux 1.3) ToolCall stream tunnel with zero writing-style interference, built-in armor contract, and cross-engine auto-reroll.',
      unavailable: 'Settings for this plugin are not currently served. Restart DSH if just installed.',
      readOnly: 'Settings are read-only in this deployment.',
      save: 'Save',
      saving: 'Saving…',
      saveFailed: 'The deployment rejected these values; your draft is preserved.',
      invalidNumber: 'Enter a valid number, or leave blank for default.',
      overridden: 'Overridden',
      reset: 'Reset',

      groupConnection: 'Gateway Listener & Upstream Connection',
      groupEngine: 'Tunnel Engine & Persona File (Zero Style Pollution)',
      groupShield: 'Refusal Auto-Reroll & Tool Cloaking',

      enabled: 'Enable Embedded Gateway',
      enabledHint: 'true / false.',
      listenHost: 'Listen Host',
      listenHostHint: 'Default 127.0.0.1. Requires DSH restart on change.',
      listenPort: 'Listen Port',
      listenPortHint: 'Default 8318. Point your provider baseURL to http://127.0.0.1:8318/v1.',
      upstreamBaseUrl: 'Upstream Base URL',
      upstreamBaseUrlHint: 'OpenAI-compatible upstream root (e.g. http://127.0.0.1:8317). Takes effect on the next message.',

      presetMode: 'Preset Engine Mode',
      presetModeHint: 'kunlun_1.2r (default) or linux_1.3. All external prose-style rules are stripped to preserve 100% of your persona voice.',
      activationMarkers: 'Activation Markers',
      activationMarkersHint: 'Default * activates the tunnel for all chat turns on this port.',
      enableBuiltinArmor: 'Enable Built-in Armor Contract',
      enableBuiltinArmorHint: 'true / false (default true). Wraps pure .txt personas with <output_contract> automatically.',
      personaFile: 'External Persona .txt Path',
      personaFileHint: 'Optional absolute path to a .txt / .md persona file hot-reloaded on every turn.',
      stripCodingBoilerplate: 'Strip DSH Coding Boilerplate',
      stripCodingBoilerplateHint: 'true / false (default true).',

      historyWindow: 'History Sliding Window',
      historyWindowHint: 'Default 32 turns.',
      maxRefusalRetries: 'Max Cross-Engine Refusal Retries',
      maxRefusalRetriesHint: 'Default 2 retries (automatically alternates between kunlun_1.2r and linux_1.3).',
      cloakedImageTools: 'Cloaked Image Tool Names',
      cloakedImageToolsHint: 'Comma-separated tool names cloaked on the wire.',
      memoryPrefetchUrl: 'Memory Prefetch URL',
      memoryPrefetchUrlHint: 'Optional HTTP endpoint for memory prefetch.',
      verbose: 'Verbose Logging',
      verboseHint: 'true / false.',
    }

    const GROUPS = [
      {
        title: 'groupConnection',
        fields: [
          ['upstreamBaseUrl', 'text'],
          ['listenHost', 'text'],
          ['listenPort', 'number'],
          ['enabled', 'text'],
        ],
      },
      {
        title: 'groupEngine',
        fields: [
          ['presetMode', 'text'],
          ['personaFile', 'text'],
          ['activationMarkers', 'text'],
          ['enableBuiltinArmor', 'text'],
          ['stripCodingBoilerplate', 'text'],
        ],
      },
      {
        title: 'groupShield',
        fields: [
          ['historyWindow', 'number'],
          ['maxRefusalRetries', 'number'],
          ['cloakedImageTools', 'text'],
          ['memoryPrefetchUrl', 'text'],
          ['verbose', 'text'],
        ],
      },
    ]

    const FIELDS = GROUPS.flatMap((g) => g.fields.map(([f]) => f))
    const NUMBER_FIELDS = new Set(GROUPS.flatMap((g) => g.fields.filter(([, k]) => k === 'number').map(([f]) => f)))

    function specFor(field) {
      return NUMBER_FIELDS.has(field) ? settingsNumberField(field) : settingsTextField(field)
    }

    function formLabels(t) {
      return {
        unavailable: t('unavailable'),
        readOnly: t('readOnly'),
        saveFailed: t('saveFailed'),
        save: t('save'),
        saving: t('saving'),
      }
    }

    class CardController {
      constructor(scope) {
        this.scope = scope
        this.form = new SettingsFormModel(scope, FIELDS.map(specFor), [])
        this.store = this.form.bind(() => this.projection())
      }

      projection() {
        const out = { ...this.form.shell() }
        for (const field of FIELDS) out[field] = this.form.field(field)
        return out
      }

      inject() {
        return {
          hooks: { card: this.store },
          ...this.form.actions(),
        }
      }

      dispose() {
        this.form.dispose()
      }
    }

    function groupHeading(t, key) {
      return h(
        'h4',
        {
          key,
          style: {
            margin: '16px 0 8px',
            fontSize: '13px',
            fontWeight: 600,
            opacity: 0.85,
          },
        },
        t(key),
      )
    }

    function valueField(t, props, field, state, kind) {
      return h(SettingsValueField, {
        key: field,
        id: `linux13-${field}`,
        label: t(field),
        hint: t(`${field}Hint`),
        overriddenLabel: t('overridden'),
        resetLabel: t('reset'),
        invalidLabel: t('invalidNumber'),
        numeric: kind === 'number',
        disabled: !state.writable,
        ...state[field],
        onEdit: (text) => props.edit(field, text),
        onReset: () => props.resetField(field),
      })
    }

    function Linux13GatewayCard(props) {
      const t = props.t
      const state = props.useCard((snapshot) => snapshot)
      if (props.view === 'summary') return t('description')

      const children = []
      for (const group of GROUPS) {
        children.push(groupHeading(t, group.title))
        for (const [field, kind] of group.fields) {
          children.push(valueField(t, props, field, state, kind))
        }
      }

      return h(SettingsForm, {
        labels: formLabels(t),
        state,
        onSave: props.save,
        onDiscard: props.discard,
        children,
      })
    }

    const inject = ['slots', 'locale', 'configForms']

    function apply(ctx) {
      const t = ctx.locale.bind(LOCALE_NS)
      ctx.effect(() => ctx.locale.register(LOCALE_NS, { zh, en }), 'dsh-linux13-gateway: dictionaries')

      const card = new CardController(ctx.configForms.get(NS))
      ctx.effect(() => () => { card.dispose() }, 'dsh-linux13-gateway: form subscription')

      ctx.effect(
        () =>
          ctx.configForms.whileServed([NS], () =>
            ctx.slots.inject('plugins.item', () =>
              ctx.slots.register(
                {
                  name: 'plugins.item',
                  id: 'dsh-linux13-gateway',
                  order: 65,
                  label: () => t('title'),
                  locale: LOCALE_NS,
                  inject: () => card.inject(),
                },
                Linux13GatewayCard,
              ),
            ),
          ),
        'dsh-linux13-gateway: settings page',
      )
    }

    exports.NS = NS
    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
