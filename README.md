# dsh-linux13-gateway v2.0（昆仑 IDE 1.2r + Linux 1.3 双引擎 · DSH 插件 + 干净人设预设组件 + 跨环境 Skill）

基于 **昆仑 IDE 1.2r (`kunlun_1.2r.json`)** 与 **Linux 1.3 (`linux_1.3.json`)** 伪造工具流式隧道协议（Synthetic ToolCall Stream Tunnel）的零依赖防截断与破限网关。

> **核心设计原则：开箱即用，100% 不修改用户的原版人设 `.txt` 文件！**
> 无论你的原版人设是纯 Markdown 角色卡（如 `# 小汐`）还是古风/现代陪伴设定，都不需要在人设里手写破甲词或特殊标签。

---

## 一、 v2.0 重点解决的五大痛点

1. **双通道全兼容解包（彻底解决 `DeepSeek-V4.1-Flash` 等模型泄露 `[FastIO Node]` / `<content>` / `<sumUp>` 标签问题）**：
   - Gemini 等模型倾向于调用伪造工具 `view_file_stream_<16hex>`（`delta.tool_calls`）；而 `DeepSeek-V4.1-Flash` 等模型常选择走预设允许的 HTTP 明文直出通道（`delta.content`）并在每个中间分片返回 `finish_reason: ""`（空字符串）。
   - v2.0 同时对 `delta.tool_calls` 与 `delta.content` 双通道执行流式剥壳，将 `<!-- [IDE_AST_TRACE] ... -->` 自动提取进 `reasoning_content` 思维链折叠框，将 `<content>` 内的正文（自动剥除 `<hidden>`、`<sumUp>`、`<pose>`、`<choices>`）干净输出。
2. **默认 `activationMarkers: '*'`（告别“默认退化成直通代理”）**：
   - 凡是发往 `:8318` 端口的对话请求默认 100% 自动开启伪造工具破限封装（后台标题总结等短工具任务自动放行），**无需在人设里加 `<output_contract>` 或 `<Role_Profile>` 标签**。
3. **内置自动破甲契约（`enableBuiltinArmor: true` 默认开启）**：
   - 网关在出站时自动为纯净人设包裹一层 `<output_contract>`（含 `<task_classification>` + `<adult_frame>` + `<character_fidelity_override>`），完全无需改动原版 `.txt` 人设文件。
4. **短句 / 微信口吻人设自适应（`styleMode: 'auto'` 默认开启）**：
   - 自动屏蔽外层预设中“第三人称受限视角 + 1500/3500字长篇武侠/文学小说”的冲突规则，并在 `[IDE_AST_TRACE]` 预检第 2 行强制逐字锚定用户的最新输入原文，确保像 `小汐` 这样要求“第一人称、微信短句、最多两三句、不写小作文”的角色 100% 原汁原味回复！
5. **内置 DSH 外置 `.txt` 干净标准预设加载器（`dsh-linux13-gateway/persona-file`）**：
   - 随包附带 `dsh-linux13-gateway/persona-file` 组件与 [`examples/dsh-preset-character/`](./examples/dsh-preset-character/patch/cordis.patch.yml) 干净预设模板，让 DSH 会话的系统提示词 **100% 只有用户的外置 `.txt` 人设文件**（改文件保存后下一条消息立即生效，无需重启）。

---

## 二、 在 DSH 中配置「外置 `.txt` 干净标准预设」（推荐标准做法）

在 DSH 中扮演角色时，前提是使用**干净的「标准预设」**——即系统提示词**只有用户的人设 `.txt` 文件**（通过引用外部文件路径动态读取，不包含 DSH 默认的 `You are a coding agent...` 编程助手身份与 `AGENTS.md` 注入），同时完整保留 DSH 的全部标准工具。

### 第 1 步：安装本网关插件
```bash
dsh plugin --profile web add link:/path/to/dsh-linux13-gateway
```

### 第 2 步：基于内置模板创建你的「干净外置 `.txt` 预设」
直接复制本仓库自带的 [`examples/dsh-preset-character`](./examples/dsh-preset-character) 模板到 `~/.dsh/plugins/dsh-preset-mychar`：

```bash
cp -r /path/to/dsh-linux13-gateway/examples/dsh-preset-character ~/.dsh/plugins/dsh-preset-mychar
```

编辑 `~/.dsh/plugins/dsh-preset-mychar/patch/cordis.patch.yml` 中的 `files` 路径，指向你的原版人设 `.txt` 文件（**原版 `.txt` 一字不改**）：

```yaml
- insert:
    - id: preset-mychar
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: mychar
        name: 小汐
        description: 干净角色预设：系统提示词 100% 引用外置人设 .txt 文件，改文件下一条消息生效
        order: 3
        plugins:
          - id: persona
            name: '@deepseek-ai/dsh-persona'
            config:
              prefix: |-
          - id: persona-file
            name: 'dsh-linux13-gateway/persona-file'
            config:
              enabled: true
              complete: true          # 关键：丢弃 DSH 默认编程身份段，系统提示词只留下面的 .txt！
              files:
                - '/abs/path/to/人设.txt'
              order: 50
          # 其余标准工具（tool-bash / tool-fs / tool-skill / tool-web 等）已在模板中配好，且已剔除 agent-instructions
```

然后把该预设挂载进 DSH：
```bash
dsh plugin --profile web add link:$HOME/.dsh/plugins/dsh-preset-mychar
```
> ⚠️ **注意**：DSH 的预设（preset）是在**新建会话时**绑定的。装好预设后，请在 DSH 左上角**新建一个会话**并选择该角色预设！之后你随时修改磁盘上的 `人设.txt` 保存，**下一条消息立即生效**，无需重启 DSH。

### 第 3 步：将供应商指向本地 `8318` 破限隧道端口
在 `~/.dsh/profiles/web/cordis.patch.yml` 的 `llm-pi-ai` 供应商中指向 `http://127.0.0.1:8318/v1`，并在 `dsh-linux13-gateway` 插件设置中将 `upstreamBaseUrl` 指向你的真实上游（如 `http://127.0.0.1:8317` 或 `https://api.siliconflow.cn/v1`）。

---

## 三、 作为跨环境 Skill 或独立服务使用

```bash
# 将 Skill 注册到全局技能目录
ln -sfn /path/to/dsh-linux13-gateway/skills/linux13-gateway ~/.dsh/skills/linux13-gateway

# 独立启动或安装 systemd 服务
bash skills/linux13-gateway/scripts/ctl.sh install-systemd --port 8318 --upstream http://127.0.0.1:8317
bash skills/linux13-gateway/scripts/ctl.sh status
```

---

## 四、 运行自动化验收测试

```bash
npm test
```
