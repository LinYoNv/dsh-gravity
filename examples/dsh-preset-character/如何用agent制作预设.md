# 让 agent 帮你做一个角色预设

你不用懂 YAML、不用手写一百多行配置。把下面**整段**粘贴给 DSH 里的一个 agent（普通会话就行），它会照着做完。

唯一需要你提供的两样东西：**角色叫什么**、**人设文件放在哪**。

---

## 把下面这段整段贴给 agent

````text
帮我做一个 DSH 角色预设。你按下面的步骤自己做完，做完告诉我怎么用。

【我要的】
- 预设 id：<小写英文，例如 lilith>
- 预设显示名：<中文名，例如 莉莉丝>
- 我的人设文件绝对路径：<例如 D:\瑟瑟\莉莉丝人设.txt>

【背景知识（你要理解的机制）】
DSH 的「Agent 预设」把一套插件组合固化下来。角色预设的关键是这一行：
  - id: persona-file
    name: 'dsh-persona-preset'
    config:
      enabled: true
      complete: true        # 关键：系统提示词里只剩下面 files 的内容
      files:
        - '<我的人设文件路径>'
      order: 50
complete: true 会把 harness 身份段、全局规则、工具说明段全部丢弃，提示词里
只剩我的 .txt 内容。所以：不要加 agent-instructions 插件（它会把 AGENTS.md
以 <system-reminder> 塞进用户消息，complete 压不掉）。

【你要做的步骤】
1. 先找一个已经能正常工作的预设作为模板。本机上 D:\emotion-app\preset-huatu
   通常就是一份完整可用的（如果存在就用它，不存在就问我）。
   用 read 读它的 patch/cordis.patch.yml 全文。

2. 在 <DSH 用户目录>/plugins/dsh-preset-<id> 下创建目录结构：
   - package.json
   - patch/cordis.patch.yml

   package.json 内容：
   {
     "name": "dsh-preset-<id>",
     "version": "1.0.0",
     "private": true,
     "description": "Agent preset「<显示名>」",
     "dsh": { "bundle": { "patch": "./patch/cordis.patch.yml" } }
   }

3. 把模板 cordis.patch.yml 复制过来，改这几处：
   - 顶层 entry id：preset-<id>
   - config.id：<id>
   - config.name：<显示名>
   - config.description：一句话说明
   - config.order：给个不冲突的数字
   - persona-file 段里的 files：换成我给你的绝对路径
   其余插件行原样保留，不要删减、不要「顺手优化」。

4. 装进 profile：
   dsh plugin --profile desktop add link:<你刚创建的目录绝对路径>

5. 校验：确认 profile 的 package.json 里 dsh.profile.bundles 已包含
   dsh-preset-<id>，且 node_modules 下有对应软链。把这两项的实际值贴给我。

6. 告诉我：需要重启 DSH 吗、重启后在哪个界面选到这个预设。

【注意】
- 人设文件我只提供路径，不要去创建或修改它。如果那个路径不存在，直接告诉我，
  不要自己编一个人设内容写进去。
- 改任何已有文件前先备份。
````

---

## 做完之后你会看到什么

重启 DSH，新建会话时在「Agent 预设」列表里能看到你起的名字。选它，这个会话的系统提示词就只有你的人设文件内容。

改人设 `.txt` 并保存后，**下一条消息**就生效，不用重启、不用重开会话。

---

## 为什么不让插件自动创建预设

两个原因：

**预设会把工具清单固化。** 上面那份模板列了 20 多行插件。DSH 升级改了工具名，这份清单就跟着失效，得手动改。插件自动写进去的东西，用户根本不知道有这一份需要维护。

**预设该跟着人设走，不是跟着插件走。** 一个网关插件不该规定你的角色是谁。

所以这里给的是「让 agent 现场生成」这条路——你的 agent 读得到本机真实的模板，生成的清单天然和当前 DSH 版本对齐。升级后让 agent 重跑一遍就行。
