# dsh-linux13-gateway v2.2

昆仑 IDE 1.2r / Linux 1.3 双引擎伪造工具流式隧道网关，作为 DeepSeek Harness（DSH）插件运行。

装好并重启后，「设置 → 模型」里会多出一条 **「linux网关」** 供应商。你在卡片里填自己中转站的 API 密钥，在插件页填上游地址，之后所有走这条供应商的对话都会自动经过破限隧道。

插件不保存你的密钥、不代填、也不猜你的上游。

---

## 它解决什么问题

角色扮演类对话在多数中转站会被中间层拦截，表现是：回复被截断、被换成一句「抱歉，我无法协助」、或者直接空回。

网关的做法是把请求改写成一套「伪造工具调用 + 终端归档」的形状发出去 —— 在上游看来这是 IDE 在归档文本文件，不是角色扮演。模型吐回来的内容再由网关拆包还原成正常的流式回复，客户端完全无感。

```
DSH ──▶ linux网关（127.0.0.1:8318）
            │  改写：人设 → 假工具描述
            │        历史 → 终端归档
            │        生图工具 → 改名伪装
            ▼
      你的上游（任意 OpenAI 兼容中转站）
            │
            ▼
      流式解包：抽 <content> 正文
                假工具调用吞掉
                真工具名还原
```

被拦截时自动切到另一套引擎重试（`linux_1.3` ⇄ `kunlun_1.2r`），两套引擎的伪装形态不同，一套被识别另一套往往还能过。

---

## 安装

### 前置

- 已经装好 DSH（桌面版或 Web 版）
- 有一个 OpenAI 兼容的中转站地址和密钥

### 步骤

**1. 打开「设置 → 内置插件」，点「添加插件」**

**2. 填入下面任一来源**

从 GitHub 装：
```
github:LinYoNv/dsh-linux13-gateway
```

从本地目录装（自己 clone 过的话）：
```
D:\你的路径\dsh-linux13-gateway
```

**3. 点「安装」，装完选「立即启用」**

**4. 重启 DSH**

这一步不能省。插件在启动时注册供应商，不重启看不到。

**5. 配置上游地址**

「设置 → 内置插件 → linux13 网关」：

| 字段 | 填什么 |
|---|---|
| **上游服务地址** | 你的中转站地址，例如 `https://api.example.com/v1` |
| **模型列表** | 中转站登记的模型名，英文逗号分隔，例如 `deepseek-v4.1-flash` |

保存后**下一条消息立即生效**，不用重启。

**6. 填 API 密钥**

「设置 → 模型 → linux网关 → 编辑」，在 **API 密钥** 框里粘贴你的 key，保存。

圆点变绿就说明配好了。

---

## 配置分两处，别搞混

这是最容易踩的坑：

| 在哪配 | 配什么 |
|---|---|
| **设置 → 模型 → linux网关** | 你的**上游 API 密钥**。这是唯一存 key 的地方 |
| **设置 → 内置插件 → linux13 网关** | 上游地址、监听端口、破限引擎、模型列表、上下文档位、重试次数 |

密钥不会显示在插件页，插件页也不该填密钥。如果你把 key 填进插件页的 `apiKeyEnv`，那只是改了个**变量名**，不是填密钥。

---

## 四个开关值得知道

- **`presetMode`** — `linux_1.3`（默认）或 `kunlun_1.2r`。两套伪造形态，被拦截时自动互换重试。哪套更稳取决于你的中转站，试出来留哪个。
- **`enableBuiltinArmor`** — 默认开。人设文件里没有 `<output_contract>` 时，出站自动包一层保护文本。**你的原版人设 `.txt` 一个字都不用改。**
- **`stripCodingBoilerplate`** — 默认开。剥掉 DSH 注入的「你是一个编程助手」身份段和 `<system-reminder>`，否则角色会开口像客服。
- **`models`** — 英文逗号分隔的模型名。换了中转站就改这里。

### 其他字段

<details>
<summary>展开完整列表</summary>

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 关掉后网关不监听，供应商卡片失效 |
| `displayName` | `linux网关` | 「模型」页显示的名字 |
| `listenHost` | `127.0.0.1` | 只监听本地。改地址需重启 |
| `listenPort` | `8318` | 网关端口。改端口需重启，且要同步改供应商卡片里的地址 |
| `apiKeyEnv` | `LINUX13_GATEWAY_API_KEY` | 密钥在凭据服务里的**名字**，不是密钥本身 |
| `contextWindow` | `1000000` | 报给宿主的窗口大小，只影响界面计量与压缩阈值 |
| `historyWindow` | `32` | 打包进归档的历史轮数上限 |
| `maxRefusalRetries` | `2` | 判定为拒答后换引擎重试的次数 |
| `personaFile` | 空 | 外置人设文件绝对路径，留空则用系统提示词里已有的 |
| `activationMarkers` | `*` | `*` = 所有对话都走隧道。也可填逗号分隔的特征词 |
| `cloakedImageTools` | `nai_generate_image,…` | 出站时改名伪装的生图工具名 |
| `memoryPrefetchUrl` | 空 | 可选：外部记忆预取接口 |
| `verbose` | `false` | 在终端打印每次请求的改写详情 |

</details>

---

## 兼容性

- **只改写 `POST /v1/chat/completions`。** 其他路径原样透传，`/v1/models` 之类的探测照常可用。
- **后台任务跳过隧道。** 会话起标题、话题标签、表情包分类这类宿主自己发的一次性任务，套上终端归档外壳只会浪费 token 还答歪，所以直接透传。
- **真流式。** 边收边发，不是攒完再一次性吐出。前 200 字符会短暂持有用于判断是不是拒答，超过就立刻放行。
- **上游断连有兜底。** 中途掐线会以一条可读的错误提示收尾，不会丢一个裸 502 让你对着空白猜。
- **不抢 adapter。** 插件只声明供应商，不注册 LLM adapter —— 网关本身就是标准 OpenAI 兼容服务，`llm-pi-ai` 的 `openai-completions` 协议直接对接。（早期版本抢注过，会导致同命名空间下所有供应商一起失效。）

---

## 卸载

「设置 → 内置插件 → linux13 网关 → 删除」，然后重启 DSH。

供应商卡片会随之消失。`llm-pi-ai` 段里那条 `linux13-gateway` 记录会残留，但不影响任何东西 —— 没有插件指向它，它只是个不被读的条目。想彻底清掉就在「设置 → 模型」里点它的「删除」。

---

## 附带内容

### 跨环境部署 skill

`skills/linux13-gateway/` —— 一份可以脱离 DSH 单独使用的部署指南与脚本，覆盖 systemd / Docker / macOS / Windows / SillyTavern / AstrBot / OpenWebUI。装好插件后，在任何 DSH 会话里都能 `skill({ name: "linux13-gateway" })` 调用。

### 角色预设

`examples/dsh-preset-character/` 下有：

- **`如何用agent制作预设.md`** —— 一段可直接粘给 agent 的任务说明。填上角色名和人设路径，agent 会读本机现有预设当模板、生成新预设、装进 profile、告诉你重启后在哪选。
- `patch/cordis.patch.yml` —— 同一份东西的手写版，给想自己改的人。

**为什么不直接内置一个预设**：预设会把整套工具清单固化下来（二十多行插件）。DSH 一升级、工具改名，清单就失效。让 agent 现场读本机模板生成，永远和当前版本对齐。

---

## 开发

### 目录

| 路径 | 职责 |
|---|---|
| `lib/index.js` | 插件入口：启网关、写供应商行 |
| `lib/schema.js` | 配置 schema 与快照读取 |
| `lib/server.js` | HTTP 网关：改写、转发、流式解包、拒答重试 |
| `lib/engine.js` | 核心转换：请求改写、SSE 解包、破甲契约 |
| `lib/client.js` | 浏览器半侧：插件设置页表单 |
| `lib/persona-file.js` | 外置人设文件加载段（供预设使用） |
| `lib/cli.js` | 脱离 DSH 独立运行的命令行入口 |
| `assets/*.json` | 两套引擎的预设资产 |

### 测试

一条命令跑全部：

```bash
npm test          # 等价于 node test/all.mjs
```

六个套件也可以单独跑，改哪块跑哪块：

```bash
node test/e2e.mjs       # 网关端到端：隧道、流式、拒答换引擎、断流、后台任务
node test/plugin.mjs    # apply 接线、写入位置、不覆盖用户已有配置
node test/config.mjs    # patch 与 schema 对齐、表单覆盖、skill 副本一致性
node test/install.mjs   # 空 profile 装完能否出现供应商
node test/profile.mjs   # 写入的 provider 过得了宿主校验规则
node test/coexist.mjs   # 插件与 llm-pi-ai 共存不冲突
```

`coexist.mjs` 和 `profile.mjs` 不是形式主义：它们分别守着一个真实踩过的坑 —— 抢注 adapter 会让整段供应商全部失效，写错字段形状会让宿主拒绝整个配置段。

### 关键约束

改代码时有三条不能破：

1. **不要注册 LLM adapter。** `llm-pi-ai` 会为 provider 表里每条路由注册 adapter，抢注会抛 `DUPLICATE_ADAPTER`，而它的 `apply()` 没有 try/catch —— 整个命名空间的供应商全没。
2. **不要把供应商写进 `cordis.patch.yml`。** patch 会整体替换目标条的 `config`，写进去会抹掉用户已有的所有 provider。要走运行时 `settings.mutate` 做路径定位写入。
3. **改完 `lib/*.js` 要同步 `skills/linux13-gateway/scripts/`。** 那份副本是独立的，`test/config.mjs` 会检查字节一致。

---

## 许可

MIT
