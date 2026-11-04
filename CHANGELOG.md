# Changelog

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [2.3.0] — 2026-11-04

这一版的主题是**修掉会连带伤人的问题**，其次是补齐安装体验。

### 修复

- **供应商全灭**（严重）。此前插件同时做两件事：给自己的路由注册 `LlmAdapter`，又把同一条路由写进 `llm-pi-ai` 的 provider 表。pi-ai 会为表里每条路由注册 adapter，第二次认领直接抛 `DUPLICATE_ADAPTER`；而它的 `apply()` 没有 try/catch，于是整个命名空间加载失败 —— 用户自己配的 provider **全部从模型页消失**。现已删除 `lib/adapter.js`：网关两端都讲 OpenAI chat-completions，pi-ai 的 `openai-completions` 适配器可以直接对接，插件没有任何理由持有自己的 adapter。

- **拒答重试可能重试同一个引擎**。非流式与流式两处的奇偶判断相反，其中一处必然落在刚刚拒绝的引擎上，白白消耗一次请求。两处统一走 `engineForAttempt()`，并新增断言检查上游实际收到的引擎序列。

- **`/health` 版本号漂移**。原先写死字面量，出现过包是 2.1.0 而 health 报 2.0.0。改为从 `package.json` 读取。

- **后台任务仍进隧道**。会话起标题这类宿主自发的短任务本应透传，但判断逻辑只扫用户消息，而指令文本在 system 消息里，因此从未生效 —— 每次都套上了终端归档外壳，白烧 token 还可能答歪。

- **skill 副本与 `lib/` 不同步**。`skills/linux13-gateway/scripts/server.js` 曾是旧版本。新增字节比对测试，防再犯。

- **供应商行不再被覆盖**。插件每次重载都会重写整条 provider，抹掉用户在「模型」页改过的地址、模型列表与显示名。现在只在缺失时写入，已有则只补缺失的 `apiKeyEnv`。

### 改进

- **真流式转发**。此前整段缓冲后才下发，实测首字节 1.4 秒。现在边收边发；前 200 字符短暂持有用于识别拒答，超过阈值立即放行。真正的拒答很短，跨不过这个窗口。

- **上游断连有兜底**。从中途掐线原先返回裸 502，客户端拿不到已收到的内容。现在以一条可读的错误帧收尾。

- **模型页卡片可编辑**。供应商声明在 `llm-pi-ai` 命名空间下，卡片会渲染出 API 密钥输入框与自定义设置折叠区。宿主只为 `llm-deepseek` 和 `llm-pi-ai` 两个命名空间渲染完整编辑器，插件自有命名空间会落到「其余字段在 cordis.patch.yml 中」的降级形态 —— 这是 2.2.0 卡片没有密钥框的原因。

### 新增

- `examples/dsh-preset-character/如何用agent制作预设.md` —— 一段可直接粘给 DSH agent 的任务说明，用于生成角色预设。预设会把工具清单固化、跟着 DSH 版本走，因此不内置写死的模板。

- `test/coexist.mjs` —— 模拟 `llm-pi-ai` 完整注册流程，断言插件不抢 adapter。
- `test/profile.mjs` —— 按宿主 `resolveProfiles` 规则校验写入的 provider 形状。
- `test/all.mjs` —— 聚合入口，`npm test` 用它。
- `.gitattributes` —— 强制 LF，保证 skill 镜像的字节比对在任意 checkout 下成立。

### 移除

- `lib/adapter.js` —— 见上，不再需要。
- `test/run-tests.mjs` —— v2.0 时代的自包含套件，内容与新测试重复，且已无法运行（断言 `SKILL.md` 以 LF 开头，Windows autocrlf 检出永远不满足）。

### 破坏性变更

无。配置字段只增不减，旧配置文件可直接使用。

---

## 版本号说明

仓库首个提交（`2e61c6d`）的 message 标注为 v2.3，而 `package.json` 当时写的是 `2.2.0`，两者不一致。本版将版本号统一为 **2.3.0**，并让 `/health` 直接读 `package.json`，避免同类漂移。

2.2.0 及更早的改动未在本文件中逐条记录 —— 那些提交早于本 CHANGELOG 的引入。
