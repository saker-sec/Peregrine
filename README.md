# 游隼模式（Peregrine）

> DeepSeek Harness 上的**知识入库预设**，与「猎隼模式」同构：指挥官只做决策与派单，
> 执行全部委派给子 agent。它负责一件事 —— **让 AI 帮你提炼知识的时候，不会把垃圾写进你的记忆库**。

English summary: a knowledge-intake preset for [DeepSeek Harness](https://github.com/deepseek-ai).
Before anything lands in a personal memory vault it must pass **four gates** (will AI remember this
anyway? / can it be re-derived? / is it a chain worth keeping? / is it redundant with the vault?),
plus a duplicate check against the existing library. Retrieval is **progressive** (catalog → search →
read) so a 20 MB vault costs a few thousand tokens instead of tens of millions. Writes to the vault
are intercepted on the way in; evidence and session data never touch it.

## 它解决的两个问题

| 问题 | 里面的做法 |
|---|---|
| **怕提炼出来的东西和库里重复** | 入库前先查重：SimHash 粗筛 + shingle 精确判定（实测改写片段也能抓到） |
| **怕整库读进上下文** | 渐进披露 L0 目录 → L1 检索 → L2 读单条，整库正文永不进上下文 |

外加一条纪律：**方法论才入库，证据不进库**。原始请求/响应、截图、会话过程留在 case 目录，
记忆库只放可复用的方法。

---

## 快速开始

```bash
git clone https://github.com/saker-sec/Peregrine.git
cd Peregrine
python scripts/link_deps.py    # 链宿主依赖（无需管理员）
# 在预设 config 里填 vaultRoot（见下），重启 DSH
```

三步之后模式选择页会出现「游隼模式」。完整步骤与验证见 [安装](#安装)。

---

## 安装

### 前置条件

| 项 | 要求 | 怎么查 |
|---|---|---|
| DeepSeek Harness | ≥ 0.2.0-rc.2 | 桌面版，或 `dsh --version` |
| Node.js | **≥ 22** | `node -v` |
| Python | 3.8+（仅辅助脚本用） | `python --version` |
| 一个记忆库目录 | 放你的 `.md` 知识；没有可以先建空目录 | — |

### 方式 A：`file:` 依赖 + junction（推荐，改代码即时生效）

在 `profiles/<profile>/package.json` 里声明：

```jsonc
{
  "dependencies": {
    "dsh-peregrine-distill": "file:<PLUGIN_DIR>"
  },
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-peregrine-distill"]
    }
  }
}
```

```bash
cd "$DSH_HOME/profiles/<profile>"
npm install --legacy-peer-deps
cd <PLUGIN_DIR>
python scripts/link_deps.py
```

### 方式 B：`dsh plugin add`（复制安装）

```bash
dsh plugin --profile <profile> add file:<PLUGIN_DIR>
python <PLUGIN_DIR>/scripts/link_deps.py
```

> ⚠️ 这是**复制**，之后改源码对已装副本无效。改完要重新 add 或跑 `python scripts/sync_profile.py`。

### 配置记忆库位置（必做）

记忆库在哪是**每台机器自己的事**，包里不写死。两种方式，选一种：

**① 预设 config**（推荐）—— 编辑 `preset/peregrine/agent.cordis.yml`：

```yaml
- id: peregrine
  name: 'dsh-peregrine-distill'
  config:
    vaultRoot: '<你的记忆库绝对路径>'      # 例：D:\my-memory-vault
    handbookPath: ''                      # 可选：蒸馏方法的手册路径
```

**② 环境变量** —— 不想改 yml 就设：

```bash
SAKER_VAULT_ROOT=<你的记忆库绝对路径>
SAKER_HANDBOOK=<手册路径>            # 可选
```

> **不配会怎样**：模式照常挂载，但目录/检索/查重/团队汇总会不可用，
> 启动日志会明确警告 `未配置 vaultRoot`。它不会静默降级。

### 重启 DSH

**预设组合是启动时读取的，必须重启**，热装载无效。

---

## 验证安装

| # | 检查 | 通过标准 |
|---|---|---|
| 1 | 模式选择页 | 出现「游隼模式」 |
| 2 | 启动日志 | 出现 `游隼模式已挂载（vault=<你的路径>）`，**没有** `未配置 vaultRoot` 警告 |
| 3 | 会话里问「用 peregrine_catalog 看下记忆库目录」 | 返回条目列表（不是"未配置"） |
| 4 | 跑测试 | `python scripts/link_deps.py && npm test` → **190 用例 / 190 通过 / 0 失败** |

> 两种跑法数字略有差别，都是绿的：`npm test` 跑脚本里列出的 9 个文件 **190/190**；
> `node --test`（自动发现）**191/191**。

> 本仓库自带测试不依赖真实记忆库：需要目录内容的用例会自建临时库，
> 所以在任何机器上都应该全绿。

---

## 排错

| 现象 | 原因 | 处理 |
|---|---|---|
| 模式页没有「游隼模式」 | 没重启 / profile 的 bundles 没加这个包 | 补 `bundles` 再重启（预设是启动时的 revision） |
| 挂载了但工具全无 | 宿主 `defineTool` 注入失败 | 看日志；这是预期降级路径，不算崩 |
| 目录/检索返回空 | `vaultRoot` 没配或路径不存在 | 按上一节配置；日志会有警告 |
| 重启后 yml 改动没生效 | 预设组合读的是 profile 补丁里的内联块 | 跑 `npm run sync`（或手动同步），再重启 |
| 改了代码但行为没变 | 复制安装不感知源码更新 | 重新 add，或 `scripts/sync_profile.py` |

---

## 为什么叫游隼

猎隼模式里已经有 **隼眼** 盯着「执行过程」有没有跑偏。游隼是隼类里俯冲最快的一种，
这里指「一把抓住材料、直接刻进记忆」那道关。两者是同构的兄弟：

| | 猎隼模式（saker） | 游隼模式（peregrine） |
| --- | --- | --- |
| 管什么 | **打点** —— 渗透测试、证据、报告 | **入库** —— 记忆库、四关、去重 |
| 指挥官做什么 | 决策与派单 | 决策与派单 |
| 执行者做什么 | 子 agent 打点并提交结果 | 子 agent 读材料并回摘要 |
| 监军在不在 | 隼眼常驻 | 本体即闸门 |

---

## 它解决的两个问题

你提的两个担心，都做成了机制，不是靠自觉：

### 问题一：怕要提炼的网页和之前重复

**SimHash 粗筛 + shingle 包含度精确判定**，两道锁。

只靠 SimHash 不够 —— 实测数据（拿 `memory/domain-baskets.md` 当靶子）：

| 改写方式 | SimHash 距离 | 只靠 SimHash | 加上包含度 |
| --- | --- | --- | --- |
| 只换 5 个词 | 3 | ✓ | ✓ |
| 换行重排 | 3 | ✓ | ✓ |
| 少了 500 字 | 10 | ✗ 漏 | ✓ |
| 替换停用词 | 12~14 | ✗ 漏 | ✓ |
| 追加 300 字 | 27 | ✗ 漏 | ✓ |
| 摘成 800 字摘要 | 17 | ✗ 漏 | ✓ |
| 完全无关材料 | 30~32 | ✓ 正确不报 | ✓ 正确不报 |

原因是 SimHash 按位投票，**内容位置一偏移，大批特征就错位**。
所以加第二道：把文本切成 5 字符 shingle 集合，用**包含度**（交集 / 较小集合）判定。
集合度量天然不受位置影响。实测包含度分布：

```
改写版本  0.96 ~ 1.00   ← 判重复
无关材料  0.00 ~ 0.06   ← 不误报
```

区分度极高，阈值取 0.55 很安全。

### 问题二：怕整库读进上下文

**渐进披露（Progressive Disclosure）**，三层：

| 层 | 内容 | 大小 | 什么时候拿 |
| --- | --- | --- | --- |
| **L0 目录** | 标题 + 一句话摘要 | ~4.1k tokens | 默认只有这个 |
| **L1 摘要** | 某条的触发条件 | 几百字 | `peregrine_search` 定位后 |
| **L2 正文** | 完整内容 | 有字节上限 | `peregrine_read` 按需 |

实测这个记忆库：

```
全部 .md        495 个，20.4 MB，约 14250k tokens
L0 目录         120 条，6164 字符，约 4109 tokens
节省            99.97%
```

做法来自 Anthropic《Effective context engineering for AI agents》：
「让 agent 自主导航与按需检索 —— progressive disclosure：通过探索逐步发现相关上下文，
只把必要的东西留在工作记忆里」，以及 just-in-time 原则：只保留轻量标识符（路径、索引），
需要时再用工具取那一块。

目录排序也做了取舍：核心索引（`layer-0-entry.md`、`MEMORY.md`）排最前，
`_` 开头的台账靠后，`kb/` 里的 chain 原子知识再靠后（它们靠检索定位，不该抢目录前排）。

---

## 四关（入库纪律）

严格按手册第六章落地，全部零 token 纯代码：

| 关 | 对应手册 | 判什么 | 拦的典型情况 |
| --- | --- | --- | --- |
| **筛** | §6.1 | 四维打分够不够 7 分线 | 非预期性/优雅度/攻击链/可复现性加起来 < 7 |
| **定** | §2 §4 §5 | 该不该落盘、落成什么形态 | AI 已经会却硬写；低频知识写完整 Skill |
| **写** | §6.2 §6.4 | 写的是判断流程还是原理复述 | 缺排他声明；没有判断流程；第一屏没授权提示 |
| **测** | §6.3 | 有没有带/不带对照，有没有 avoid | 没对照；用例没正解；缺 avoid 负向断言 |

每条检查都能追溯到手册原文，12 个 code：`score-below-threshold`、`decided-not-to-write`、
`desc-no-exclusion`、`desc-no-trigger`、`desc-vague`、`no-decision-flow`、
`no-scope-first-screen`、`no-evidence-save`、`no-negatives`、`case-no-avoid`、
`worse-than-baseline`、`generated-file-write`。

---

## 五个工具

指挥官和子 agent 都能用：

| 工具 | 用途 |
| --- | --- |
| `peregrine_duplicate_check` | 入库前查重（SimHash + 包含度） |
| `peregrine_catalog` | 看 L0 目录，决定该读哪条 |
| `peregrine_search` | 按关键词定位条目（不读正文） |
| `peregrine_read` | 按需读某条正文（有字节上限） |
| `peregrine_gate` | 跑入库四关，返回 blockers / warnings |

---

## 编排结构

```
指挥官（你对话的那个）
├── persona            「只做决定，不自己抄写」
├── 子 agent 工具        subagent / subagent_fork（maxDepth: 1）
│   └── 执行者 persona    只读指派范围、只回 300 字摘要、不许入库
├── peregrine          四关 + 查重 + 目录索引
└── 其余                shell / fs / skills / goal / web / todo / present
```

子 agent 被 `toolFilter` 禁掉 `subagent`、`subagent_fork`、`ask_user` —— 不能无限套娃，
也不能绕过指挥官直接问用户。

---

## 目录

```
dsh-peregrine-distill/
├── package.json
├── cordis.patch.yml            bundle 补丁（注册预设根）
├── peregrine-bake.json         元标准契约（tag + 各源 sha256）
├── preset/
│   └── peregrine/
│       ├── preset.yml          显示名「游隼模式」
│       └── agent.cordis.yml    编排（对齐官方 standard 预设）
├── prompt/
│   └── rubric.md               评分卡（六步判断流程 + 输出格式）
├── lib/
│   ├── preset-root.js          预设注册器（进模式选择页）
│   ├── preset.js               预设内挂载点（四关 + 工具 + 拦截）
│   ├── gates.mjs               四关实现（纯函数）
│   ├── simhash.mjs             SimHash + shingle/Jaccard/包含度
│   ├── catalog.mjs             渐进披露索引（L0/L1/L2）
│   ├── material.mjs            anysearch 检索与结果整理
│   └── index.js                旧全局插件入口（已不用，保留兼容）
├── tools/
│   └── bake.mjs                bake / check
└── test/
    ├── gates.test.mjs          四关 + 记忆条目
    ├── simhash.test.mjs        SimHash + 双判据
    ├── catalog.test.mjs        渐进披露
    ├── material.test.mjs       检索与整理
    ├── plugin.test.mjs         旧插件行为
    ├── preset.test.mjs         预设结构与工具注册
    └── real-vault-check.mjs    真实记忆库误报率
```

---

## 测试

```powershell
cd <harness>\plugins-local\dsh-peregrine-distill
node --test test/gates.test.mjs test/simhash.test.mjs test/catalog.test.mjs test/material.test.mjs test/plugin.test.mjs test/preset.test.mjs
```

当前 **121 个测试全绿**。

拿真实记忆库跑（看误报率）：

```powershell
node test/real-vault-check.mjs
```

---

## 元标准契约

```powershell
node tools/bake.mjs bake    # 重新烧录
node tools/bake.mjs check   # PASS / NEEDS RE-DISTILL
```

三个源纳入契约：评分卡、四关实现、蒸馏手册本体。
**手册改了一个字，tag 就会变** —— 这是提醒你「判定基线变了，重新确认一遍」。

---

## 作用范围

游隼的**本体只挂在预设内部**：只有跑「游隼模式」的会话才被管。
其它会话（包括默认模式）完全不受影响 —— 四关不会去拦别人的写入。

安装步骤见上文 [安装](#安装)。接线方式是 profile 补丁里的一行：

```yaml
- id: peregrine-preset-root
  name: 'dsh-peregrine-distill/preset-root'
```

**预设是启动时保留的 revision，必须重启 DSH 才会出现在模式选择页。**

---

## 已知边界

- **只对写库生效**：读库、聊天、写库外文件一律放行
- **`blockOnce: true`**：同一个问题只拦第一次，第二次放行并附问题清单
  （手册：反复拦会空转到超时）
- **判定是形态检查，不是语义理解**：它认得出「有没有排他声明」，
  但判断不了「这条排他声明写得对不对」—— 后者得靠人过一遍评分卡
- **首次查重建索引约 2 秒**，之后 TTL 60 秒内命中缓存约 27ms
- **目录上限 120 条**，超出后靠 `peregrine_search` 定位到具体条目

---

## License

MIT

---

## 踩过的坑（写在这里免得下次重犯）

### 1. 自定义预设注册器不生效

第一版用 `preset-root.js` 调 `agentPresets.register()`，模式选择页就是不出现。
日志（`%APPDATA%\dsh-desktop\logs\harness.log`）给了答案：

```
ERR_PACKAGE_PATH_NOT_EXPORTED: Package subpath './preset-root' is not defined by "exports"
profile inconsistency: the patch layer inserts dsh-peregrine-distill/preset-root, which is not installed
```

**结论**：profile 补丁里插的行，如果引用的包没登记进 `profiles/web/package.json`，
Desktop 会判 `not installed` 并丢弃该行。改用官方的 `@deepseek-ai/dsh-agent-preset`
声明式路径（内置 standard/ptc/minimal/cordis 四个预设都用它），问题消失。

### 2. 工具注册静默失败

```
warn peregrine: 注册工具 peregrine_catalog 失败:
    tool "peregrine_catalog" must declare output { schema, render, presentationMeta? }
```

**DSH 的 `tools.register()` 强制要求 `output: { schema, render }`**，`render` 必须是函数。
`schema` 只支持 `type / oneOf / properties / required / additionalProperties / items / enum / const`
加注解关键字；`additionalProperties` 必须是 **boolean**，`required` 必须是**字符串数组**。

这条已经用测试钉死（`test/preset.test.mjs` 的「工具契约」三例），
以后改工具不会重犯。

### 3. plan-mode 需要非空 section

```
warn agent-preset-registry: agent preset peregrine:
    plan-mode (@deepseek-ai/dsh-plan-mode): PlanModeConfig needs a non-empty `section`
```

Web 会话不该以 plan 模式启动，所以直接 `disabled: true`（对齐猎隼模式的做法）。

### 4. 怎么查这些问题

日志在这里，别再翻 `harness\logs\`（那是旧位置）：

```
<DSH_HOME 的上一级>\logs\harness.log
# Windows 默认：%APPDATA%\dsh-desktop\logs\harness.log
```

抓关键行：

```powershell
Select-String -Path "$env:APPDATA\dsh-desktop\logs\harness.log" -Pattern 'peregrine|agent preset'
```

---

## anysearch：自带的 key 管理

游隼**自带** anysearch，不依赖宿主 MCP 行。原因有三个：

1. 宿主 MCP 的 key 写死在 `cordis.patch.yml`，改一次要重启 DSH
2. 团队里每人该用自己的 key，不能把某个人的 key 同步出去
3. 游隼需要「只在这个模式下用这个 key」，而 MCP 是宿主层、全局共享

### 两个工具

| 工具 | 用途 |
| --- | --- |
| `peregrine_anysearch_key` | `action=get` 看当前 key（掩码）/ `set` 写入新 key / `status` 连通性自检 |
| `peregrine_anysearch` | `action=search` 单条 / `batch_search` 最多 5 条 / `extract` 抓 URL 正文 |

### key 存在哪

```
%APPDATA%\dsh-desktop\harness\plugins\peregrine\anysearch.json
```

```json
{
  "apiKey": "as_sk_...",
  "url": "https://api.anysearch.com/mcp",
  "updatedAt": "2026-10-17T15:40:00.000Z"
}
```

**关键：每次调用时才读文件，所以换 key 立即生效，不用重启 DSH。**

### 怎么用

在游隼模式的会话里直接说：

```
帮我查一下分号路径穿越的最新绕过手法
```

指挥官会用 `peregrine_anysearch`，走你配的 key。

或者显式：

```
把 peregrine_anysearch_key 的 action 设为 status，看 anysearch 通不通
```

### 实测事实（2026-10-17）

- 端点：`POST https://api.anysearch.com/mcp`，JSON-RPC
- 需要 `Accept: application/json, text/event-stream`
- 返回单条 JSON（不是 SSE），**不需要 `mcp-session-id`**
- **不需要代理**，直连可用
- 当前 key 自检通过，暴露 4 个工具：`search` / `batch_search` / `extract` / `get_sub_domains`

### 团队部署时

每人各自设自己的 key。配置文件在本机，不进 git。

方式一，让 agent 设：

```
用 peregrine_anysearch_key 设置 key 为 as_sk_xxxx
```

方式二，直接写文件（PowerShell）：

```powershell
$p = "$env:APPDATA\dsh-desktop\harness\plugins\peregrine\anysearch.json"
$json = '{"apiKey":"as_sk_xxxx","url":"https://api.anysearch.com/mcp"}'
Set-Content -Path $p -Value $json -Encoding UTF8
```

⚠ 宿主 MCP 那一行（`mcp-anysearch`）和这里是**两套独立配置**。
宿主那套供所有模式用 `mcp__anysearch__*` 工具；游隼这套只在游隼模式下用。
如果想让两边一致，把同一个 key 也写进 `cordis.patch.yml` 的 `mcp-anysearch` 行。

---

## 预设声明的单一真源

预设的行必须**内联**写在 profile 补丁里（外链实测不生效），但内联就有两份，容易漂移。

所以：

```
preset/peregrine/agent.cordis.yml      ← 唯一真源，改这里
        │
        │  node tools/sync-preset.mjs
        ▼
profiles/web/cordis.patch.yml          ← 生成物，不要手改
```

| 命令 | 作用 |
| --- | --- |
| `node tools/sync-preset.mjs` | 把真源同步进补丁（写前自动备份） |
| `node tools/sync-preset.mjs --check` | 只检查，未同步返回非 0 |

**这个工具踩过两个坑，都用测试钉死了：**

1. **换行符**：文件主体是 CRLF，生成的块是 LF → 永远对不上。现在跟随文件既有换行符。
2. **锚点错位**：一开始拿「# 游隼模式…」当起点，但它其实是注释块的第二行，
   上面那条 `# -----` 分隔线被留下 → **每同步一次块就长一行**。
   现在改为从 `- id: preset-peregrine` 往回吃连续的注释行。

同理，`plan-mode` 的 `disabled: true` 也必须写在真源里 ——
写在补丁里会被下一次同步覆盖掉（这个坑也踩过一次）。

---

## 烧录：T0 / T1 / T2 三层

沿用猎隼的四层成本模型，落到实处：

| 层 | 内容 | 谁付 token | 变更后 |
| --- | --- | --- | --- |
| **T0** | 四关 + 查重 + 索引（纯代码） | **0** | 改代码即生效 |
| **T1** | `prompt/burned.md`（3.2 KB）→ 注入 systemPrompt | 每轮，约 1k tokens | 必须 `bake` |
| **T2** | `prompt/rubric.md`（7.4 KB）→ `peregrine_rubric` 按需取 | 只在真的要逐条核对时 | 必须 `bake` |

### T1：真正烧进上下文的那一份

`prompt/burned.md` 在插件挂载时被注入 systemPrompt：

```js
sp.section({ name: 'peregrine-rubric', order: 100, text: burned.text })
```

`order: 100` 落在部署 persona（0）之后、plan 策略（500）之前 —— 这是「模式级纪律」该待的位置。

它只放**骨架**：六步流程、七条硬规则、查重、输出结构。
大段表格和例子留在 T2，需要时再拉。

### 体积预算

`tools/bake.mjs` 给 T1 设了 **6144 B 预算**，当前用了 3177 B（52%）。

超预算不会报错，但 `bake` 和 `bake check` 都会打警告：

```
⚠ T1 前缀 7000 B / 预算 6144 B（114%）  ← 超预算，每轮都在多花 token，考虑把细节挪进 rubric.md
```

为什么卡这个：手册 §1 原话「手册越短，留给干活的空间越多」，
某批 Skill 瘦身后平均分从 76.5% 涨到 82.6%，同时 token 消耗降了 1252。
前缀膨胀是渐进的，没人管就会一直涨。

### T2：按需读，而且能只读一步

```
peregrine_rubric { section: "3" }     → 只返回第 3 步
peregrine_rubric {}                    → 返回全文（7.4 KB）
```

**这一步的匹配必须按步骤号精确比对**。早期用 `title.includes('4')` 匹配，
结果第 0 步的标题里有「（§3 · §4）」，`'4'` 命中了第 0 步 ——
调用方以为拿到第 4 步，其实是第 0 步。现在按 `第 N 步` 提取数字比对，
并且有测试逐个编号锁住（0~6 每一个都必须命中自己）。

### bake 契约

```powershell
node tools/bake.mjs bake    # 重新烧录，输出 tag + 前缀体积
node tools/bake.mjs check   # PASS / NEEDS RE-DISTILL
```

五个源纳入契约：T1 前缀、T2 评分卡、四关实现、查重算法、索引算法、手册本体。
**其中任何一个改一个字节，tag 就变**。

当前 tag：`peregrine-rubric-1@6fa2b4aa`。

---

## 团队汇总：每周把大家的记忆合到一起

### 命令

```powershell
node tools/merge.mjs --vaults "D:\alice\vault,D:\bob\vault,D:\carol\vault" --out week42.md
```

| 参数 | 说明 |
| --- | --- |
| `--vaults` | 各人的 vault 根目录，逗号分隔 |
| `--out` | 报告写文件（默认只打 stdout） |
| `--json` | 机器可读输出 |
| `--containment` / `--jaccard` / `--hamming` | 覆盖阈值 |
| `--max-per-vault` | 单库最多扫多少条 |

退出码：`0` 无可裁决冲突 / `3` 有冲突 / `2` 出错。
CI 里用 `3` 就能拦住「没看报告就自动合并」。

会话里也能直接说：

```
用 peregrine_merge 把 D:\alice\vault 和 D:\bob\vault 合一下，看有多少重复
```

### 判据

三层，从便宜到贵：

1. **sha256 完全相同** —— O(n)，抓副本
2. **SimHash 粗筛** —— 海明距离 ≤ 8
3. **shingle 精确复核** —— 包含度 ≥ 0.55 或 Jaccard ≥ 0.45

### 三种关系与对应决策

| 关系 | 含义 | 建议 |
| --- | --- | --- |
| `identical` | 字节完全相同 | 留任一份 |
| `contained` | 被主条包含（一方是另一方的超集） | 留全的那份 |
| `overlap` | 重合但互不包含 | **人裁决**（进「需要人裁决」清单） |

主条选「信息量最大」的（shingle 数量，其次字节数）。

### 规模策略：小库全配对，大库才 LSH

```
条目 ≤ 2000  →  全配对（all-pairs）
条目 > 2000  →  LSH 分带（8 带 × 8 位）
```

为什么默认不全用 LSH：**LSH 是概率算法，天生有假阴性**。
实测 4 带 × 16 位时，海明距离 7 的一对只有约 39% 概率落进同一桶 ——
一半以上的真重复会被漏掉。团队实际规模（几人 × 几百条）全配对只要几秒
（实测 516 条 × 2 库 = 2259ms），没必要为省这点时间牺牲召回。

报告里会明确写出用的是哪一种：

```
比对方式：**全配对**（无假阴性，结果可复现）
```

### 只读，不写

工具**不修改任何 vault 文件**，只产出报告。

这是刻意的：跨库合并的冲突必须有人裁决，自动合并会把不同人基于不同前提的
结论揉成一条，越揉越错。

### 被合并的条目不删，改成指针

报告最后会提醒：

```
status: merged-into:<保留条目的相对路径>
```

直接删会让检索命中过时内容 —— 这是 RAG 知识库更新里最常见的「幽灵数据」坑。

### 已知边界（实测，不是猜测）

**这是字面级去重，抓不到「语义相同但用词完全不同」的两条。**

实测：两段讲同一件事、但几乎每句都换了措辞的文本 ——
Jaccard 只有 0.056、包含度 0.134、海明距离 22，全在阈值外。

要抓那种重复必须上 embedding（语义向量），那是另一套成本。
所以本工具的定位是：**先把机械重复清干净**，语义重复靠人看目录判断。

### 推荐流程

| 步 | 谁做 | 做什么 |
| --- | --- | --- |
| 1 | 每人 | `git checkout -b week-<name>`，commit 本周新增，push |
| 2 | 主库 owner | 把各分支拉到本地不同目录 |
| 3 | 工具 | `node tools/merge.mjs --vaults ... --out report.md` |
| 4 | 人 | 看报告，裁决 `overlap` 的那些 |
| 5 | 主库 owner | 合并 → `bake check` → 打 tag → 进 default |

每人推自己的分支、不推 default —— 直接共享 default 会让冲突变成每天的事。
