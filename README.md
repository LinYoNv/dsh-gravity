# dsh-linux13-gateway（DSH 插件 + 跨环境 Agent Skill 二合一）

基于 **Linux 1.3 POSIX 伪终端合成工具通道（ToolCall Stream Tunneling）** 的零依赖流式防截断与破限网关。

本仓库同时提供两种形态（共用同一套零外部依赖核心引擎）：
1. **DeepSeek Harness (DSH) 标准组合包插件**（`dsh-linux13-gateway`）：一键安装进 DSH，支持在 Web 界面可视化配置监听端口、上游地址、激活标记与伪装工具名；
2. **跨环境通用 Agent 技能包**（`skills/linux13-gateway/`）：包含完整的 `SKILL.md` 施工蓝图、跨语言移植参考（`references/protocol-and-porting.md`）与独立运行脚本（`scripts/ctl.sh`），可直接交给任意 AI Agent（Claude Code / Codex / OpenClaw / DSH）在 Linux / macOS / Windows / Docker 上为任意客户端（DSH、AstrBot、SillyTavern、OpenWebUI 及各类自建后端）自动部署接入。

---

## 核心特性（5 层协议能力）

| 能力模块 | 解决的痛点 | 实现机制 |
| :--- | :--- | :--- |
| **1. 合成工具描述夹带** | 顶层 `system` / `messages` 被上游输入分类器拦截或注入 `JAILBREAK DETECTED` 警告 | 将人设与对话历史移出顶层消息，打包进动态生成的 `dispatch_stream_payload_<16hex>` 工具的 `description` 中；顶层仅保留无害 POSIX 管线配置与 `{{roll}}` 随机熵 |
| **2. 流式剥壳 + 中文推演透传** | 直接开启 `reasoning_effort: "high"` 会触发英文安全自审导致拒答 | 遵循 `thinking_process = COMPLETELY_BYPASSED`，同时由 `ContentTagStreamExtractor` 实时提取 `<content>` 前的中文 `[character_analysis]` / `[trajectory_analysis]` 推入 `delta.reasoning_content` 思维链折叠框，并将 `<content>...</content>` 还原为 `delta.content` |
| **3. 真假工具严格分流** | 角色边说话边调真实工具（“图文双发”）时槽位冲突或 `finish_reason` 错乱 | 客户端真实工具 100% 优先；同轮混调时自动剥离伪造通道并将真实工具 `index` 紧凑重排为 `0, 1, ...`，仅在无真实工具调用时将 `finish_reason` 改写为 `"stop"` |
| **4. 生图工具协议伪装** | 模型调用 `nai_generate_image` / `draw_image` 时触发上游针对“生图工具”的独立安全锁 | 出站自动改名为纯文本标签归档器 `archive_scene_tag_descriptor`，入站自动还原为真实工具名 |
| **5. 历史洗毒 + 自动防拒答重 roll** | 单次偶发拒答写进历史后导致后续回合连锁拒答；只看最新轮图片防旧图重发 | 自动剔除历史中的拒答行、仅挂载最新回合图片、并在上游偶发吐出拒答文本时自动换新 `{{roll}}` 重试 |

---

## 用法一：作为 DSH 插件安装

```bash
# 从 GitHub 直接安装
dsh plugin --profile web add github:LinYoNv/dsh-linux13-gateway

# 或从本地克隆目录安装
dsh plugin --profile web add link:/path/to/dsh-linux13-gateway
```

然后在模型供应商配置中将需要走网关的供应商 `api` 设为 `openai-completions`，`baseURL` 指向 `http://127.0.0.1:8318/v1`。

---

## 用法二：作为独立服务或跨环境 Skill 使用

### 1. 将 Skill 安装到全局技能目录
```bash
ln -sfn /path/to/dsh-linux13-gateway/skills/linux13-gateway ~/.dsh/skills/linux13-gateway
```
此后在任何会话中均可直接调用 `skill({ name: "linux13-gateway" })` 让 AI 按当前机器环境自动部署或定制。

### 2. 命令行直接启动 / 安装 systemd 服务
```bash
# 直接启动
node lib/cli.js --host 127.0.0.1 --port 8318 --upstream http://127.0.0.1:8317

# 或使用一键控制脚本
bash skills/linux13-gateway/scripts/ctl.sh install-systemd --port 8318 --upstream http://127.0.0.1:8317
bash skills/linux13-gateway/scripts/ctl.sh status
```

---

## 运行自动化验收测试

```bash
npm test
# 或
node test/run-tests.mjs
```
