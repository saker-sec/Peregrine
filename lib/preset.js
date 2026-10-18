/**
 * 游隼 · 预设侧挂载点（`dsh-peregrine-distill/preset`）
 *
 * 这个模块只在「游隼模式」预设里被加载（见 preset/peregrine/agent.cordis.yml）。
 * 它做两件事：
 *   1. 把四关 + 去重 + 目录索引挂到当前会话上
 *   2. 给指挥官注册三个工具，让「查重 / 看目录 / 按需读条目」变成可调用动作
 *
 * 为什么不在全局 bundle 里挂：
 *   和隼眼同一个理由 —— 只有跑游隼预设的会话才该有这套闸门，
 *   全局挂会让所有会话都被拦。
 */

import { runGates, checkWriting, checkMemoryEntry } from './gates.mjs'
import {
  simhash, detectDuplicate, buildDuplicateIndex, suggestThreshold,
  extractFeatures, FINGERPRINT_MAX_CHARS,
  CONTAINMENT_THRESHOLD, JACCARD_THRESHOLD
} from './simhash.mjs'
import { buildCatalog, renderCatalog, readEntry, searchEntries } from './catalog.mjs'
import { buildSearchPlan, normalizeHits } from './material.mjs'
import { analyzeVaults, renderMergeReport } from './merge.mjs'
import {
  readConfig as readAnysearchConfig, writeConfig as writeAnysearchConfig,
  maskKey, search as anysearchSearch, batchSearch as anysearchBatch,
  extract as anysearchExtract, health as anysearchHealth, configPath as anysearchConfigPath
} from './anysearch.mjs'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'peregrine'

export const defaultConfig = {
  vaultRoot: '',
  handbookPath: '',
  blockOnce: true,
  /** SimHash 海明距离阈值（粗筛；精确判定靠 shingle 包含度） */
  nearDuplicateThreshold: 8,
  /** shingle 包含度阈值：新材料有多少比例已被库里某条覆盖 */
  containmentThreshold: CONTAINMENT_THRESHOLD,
  /** shingle Jaccard 阈值：两篇的重合程度 */
  jaccardThreshold: JACCARD_THRESHOLD,
  catalogMaxEntries: 120,
  writeToolPatterns: ['write', 'edit', 'str_replace', 'apply_patch', 'create_file', 'notebook_edit']
}

// ---------------------------------------------------------------- 路径判定

function norm (s) { return String(s == null ? '' : s) }

export function isVaultWrite (exec, vaultRoot) {
  if (!exec || !exec.name) return false
  const lower = norm(exec.name).toLowerCase()
  if (!defaultConfig.writeToolPatterns.some((p) => lower.includes(p))) return false

  const args = exec.args || exec.arguments || {}
  const target = norm(args.path || args.file_path || args.filePath || args.target)
  if (!target) return false

  const root = norm(vaultRoot).replace(/[\\/]+$/, '').toLowerCase()
  const t = target.replace(/\//g, '\\').toLowerCase()
  return t.startsWith(root) && t !== root
}

export function classifyWriteTarget (target) {
  const t = norm(target).replace(/\//g, '\\').toLowerCase()
  if (/skill\.md$/.test(t)) return 'skill-md'
  if (/\\references\\/.test(t)) return 'reference'
  if (/\\registry\\/.test(t)) return 'registry-generated'
  if (/\\memory\\/.test(t)) return 'memory'
  return 'other'
}

const GENERATED_PATTERNS = [
  /\\registry\\(layer-index\.json|route-map\.json|skill-index\.json)$/i,
  /\\memory\\(layer-1-instant|layer-3-short-term|coverage-audit)\.md$/i
]

export function isGeneratedFile (target) {
  const t = norm(target).replace(/\//g, '\\')
  return GENERATED_PATTERNS.some((re) => re.test(t))
}

// ---------------------------------------------------------------- 指纹索引

/**
 * 给记忆库建指纹表。
 *
 * 性能取舍：489 个文件全读要 8 秒，太慢。
 * 但**截断长度必须与查重侧一致**（都是 FINGERPRINT_MAX_CHARS 个字符），
 * 否则同一份材料会算出两个指纹 —— 这是实测踩过的坑：
 * 按 8KB 字节截断时，中文只取到约 2700 字，用 8000 字去查就查不到自己。
 * 所以这里按**字符**读，不是按字节。
 * 表本身 TTL 60 秒，避免每次查重都重扫。
 */
/**
 * 给记忆库建去重索引。
 *
 * 沿用前面的性能取舍（只读头部、TTL 60 秒、按字符截断保证与查重侧一致），
 * 但索引里除了 SimHash 指纹还存 **shingle 集合** ——
 * 这是精确判定必需的第二道判据，实测能抓到 SimHash 漏掉的改写版本。
 */
function createVaultIndex (vaultRoot) {
  let cache = null
  let cacheAt = 0
  let building = false
  const TTL = 60 * 1000
  // 按字符取头部：中文 3 字节/字，3000 字最多 9KB，留够余量
  const HEAD_BYTES = FINGERPRINT_MAX_CHARS * 4

  function collect () {
    const files = []
    const walk = (dir, relBase, depth) => {
      if (depth > 3) return
      let ents = []
      try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
      for (const e of ents) {
        if (e.name === '.git' || e.name === 'node_modules') continue
        const full = path.join(dir, e.name)
        const rel = relBase ? relBase + '/' + e.name : e.name
        if (e.isDirectory()) { walk(full, rel, depth + 1); continue }
        if (!/\.md$/i.test(e.name)) continue
        files.push({ full, rel, title: e.name.replace(/\.md$/i, '') })
      }
    }
    walk(vaultRoot, '', 0)

    const entries = []
    for (const f of files) {
      try {
        const st = fs.statSync(f.full)
        if (st.size > 500 * 1024) continue
        const takeBytes = Math.min(HEAD_BYTES, st.size)
        const fd = fs.openSync(f.full, 'r')
        const buf = Buffer.alloc(takeBytes)
        const n = fs.readSync(fd, buf, 0, takeBytes, 0)
        fs.closeSync(fd)
        // toString 后由 simhash / shingleSet 统一按字符截断，保证与查重侧一致
        entries.push({ id: f.rel, path: f.rel, title: f.title, text: buf.toString('utf8', 0, n) })
      } catch {}
    }
    return entries
  }

  return {
    get () {
      const now = Date.now()
      if (cache && now - cacheAt < TTL) return cache
      if (building) return cache || []
      building = true
      try {
        cache = buildDuplicateIndex(collect())
        cacheAt = Date.now()
      } finally {
        building = false
      }
      return cache
    },
    invalidate () { cache = null }
  }
}

// ---------------------------------------------------------------- 消息

export function pluginMessage (text, id) {
  return {
    id: id || ('peregrine-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6)),
    role: 'user',
    source: { kind: 'plugin', plugin: 'peregrine' },
    content: [{ type: 'text', text }]
  }
}

export function formatReminder (findings, opts) {
  const o = opts || {}
  const blocks = (findings || []).filter((f) => f.level === 'block')
  const warns = (findings || []).filter((f) => f.level === 'warn')
  const head = blocks.length ? '⛔ 游隼（拦下入库）' : '⚠ 游隼（入库提醒）'
  const lines = [head + '：' + (o.title || '材料没过入库四关')]
  const shown = (blocks.length ? blocks : warns).slice(0, 3)
  for (const f of shown) lines.push(`  · ${f.code}：${f.message}`)
  const total = blocks.length + warns.length
  if (total > shown.length) lines.push(`  · …另有 ${total - shown.length} 条`)
  if (o.fix) lines.push('改法：' + o.fix)
  if (o.ruleRef) lines.push('依据：' + o.ruleRef)
  return lines.join('\n')
}

// ---------------------------------------------------------------- 烧录层

const PLUGIN_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const BURNED_PATH = path.join(PLUGIN_ROOT, 'prompt', 'burned.md')
const RUBRIC_PATH = path.join(PLUGIN_ROOT, 'prompt', 'rubric.md')
const BAKE_PATH = path.join(PLUGIN_ROOT, 'peregrine-bake.json')

/** 读契约里的 tag（读不到就用 unbaked） */
export function bakeTag () {
  try {
    const j = JSON.parse(fs.readFileSync(BAKE_PATH, 'utf8'))
    return j.tag || 'unbaked'
  } catch {
    return 'unbaked'
  }
}

/**
 * T1：读烧录前缀。
 *
 * 前缀是**每轮都进上下文**的东西，所以体积受 bake 的预算约束
 * （默认 6KB，见 tools/bake.mjs 的 BURNED_BUDGET_BYTES）。
 * 完整评分卡放 T2，由 peregrine_rubric 工具按需取，不进前缀。
 */
export function loadBurned () {
  try {
    const text = fs.readFileSync(BURNED_PATH, 'utf8').trim()
    if (!text) return null
    const tag = bakeTag()
    return {
      text: `${text}\n\n<!-- bake ${tag} -->`,
      tag,
      bytes: Buffer.byteLength(text, 'utf8')
    }
  } catch {
    return null
  }
}

/** T2：读完整评分卡，可按 step 切片（避免整篇 7KB 一次拉） */
export function loadRubric (section) {
  let text
  try {
    text = fs.readFileSync(RUBRIC_PATH, 'utf8')
  } catch {
    return { ok: false, error: '评分卡文件不存在: ' + RUBRIC_PATH }
  }

  const want = norm(section).trim()
  if (!want) return { ok: true, section: null, text, bytes: Buffer.byteLength(text, 'utf8') }

  // 切成 "## ..." 分节
  const heads = []
  const re = /^##\s+(.+)$/gm
  let hit
  while ((hit = re.exec(text)) !== null) heads.push({ title: hit[1].trim(), index: hit.index })
  const blocks = heads.map((h, i) => ({
    title: h.title,
    body: text.slice(h.index, i + 1 < heads.length ? heads[i + 1].index : text.length).trim()
  }))

  /**
   * 匹配目标节。
   *
   * 必须**按步骤号精确比对**，不能用 title.includes(want)：
   * 第 0 步的标题里就带着 "（§3 · §4）"，用 '4' 去 includes 会命中第 0 步 ——
   * 这个 bug 实测出现过，会让人以为拿到了第 4 步、其实是第 0 步。
   */
  const wantNum = /^\d+$/.test(want) ? want : (() => {
    const m = /^\D*(\d+)\D*$/.exec(want)
    return m ? m[1] : null
  })()

  let found = []
  if (wantNum !== null) {
    found = blocks.filter((b) => {
      const m = /^第\s*(\d+)\s*步/.exec(b.title)
      return m && m[1] === wantNum
    })
  }
  // 号码没命中时退回标题包含匹配（支持按词找节，如 "硬规则"）
  if (!found.length) found = blocks.filter((b) => b.title.includes(want))

  if (!found.length) {
    return {
      ok: false,
      error: `没找到「${want}」这一节。可用：` +
        blocks.map((b) => {
          const m = /^第\s*(\d+)\s*步/.exec(b.title)
          return m ? m[1] : b.title
        }).join(' / ')
    }
  }
  const out = found.map((b) => b.body).join('\n\n')
  return { ok: true, section: want, text: out, bytes: Buffer.byteLength(out, 'utf8') }
}

// ---------------------------------------------------------------- 插件本体

export function apply (ctx, config) {
  const cfg = { ...defaultConfig, ...(config || {}) }
  // 记忆库与手册的位置是**每台机器自己的事**，不写死在包里。
  // 优先级：预设配置 > 环境变量 > 空（空则禁用记忆库相关能力，而不是崩掉）
  if (!cfg.vaultRoot) cfg.vaultRoot = process.env.SAKER_VAULT_ROOT || process.env.PEREGRINE_VAULT_ROOT || ''
  if (!cfg.handbookPath) cfg.handbookPath = process.env.SAKER_HANDBOOK || ''
  const log = (level, msg) => {
    try {
      if (level === 'error') ctx.logger?.error?.(`[peregrine] ${msg}`)
      else if (level === 'warn') ctx.logger?.warn?.(`[peregrine] ${msg}`)
      else ctx.logger?.info?.(`[peregrine] ${msg}`)
    } catch {}
  }

  // ---- T1 烧录：把固定前缀挂进 systemPrompt
  //
  // order 取 100：紧跟部署 persona（0）之后、plan 策略（500）之前。
  // 这段每轮都在上下文里，所以只放纪律骨架；细节走 T2（peregrine_rubric）。
  let burnedTag = 'unbaked'
  let burnedBytes = 0
  try {
    const sp = ctx.get && ctx.get('systemPrompt')
    const burned = loadBurned()
    if (sp && typeof sp.section === 'function' && burned) {
      sp.section({
        name: 'peregrine-rubric',
        order: 100,
        text: burned.text
      })
      burnedTag = burned.tag
      burnedBytes = burned.bytes
      log('info', `T1 前缀已注入（${burnedBytes} B，${burned.tag}）`)
    } else if (!burned) {
      log('warn', 'T1 前缀文件缺失，未注入（prompt/burned.md）')
    } else {
      log('warn', 'systemPrompt 服务不可用，T1 前缀未注入')
    }
  } catch (e) {
    log('warn', '注入 T1 前缀失败: ' + (e && e.message))
  }

  const index = createVaultIndex(cfg.vaultRoot)
  const stats = { wired: 0, checked: 0, blocked: 0, warned: 0, passed: 0, duplicates: 0, byCode: {} }

  // ---- 状态落盘
  const stateDir = (() => {
    const home = process.env.DSH_HOME || ''
    if (!home) return null
    try {
      const dir = path.join(home, 'plugins', 'peregrine')
      fs.mkdirSync(dir, { recursive: true })
      return dir
    } catch { return null }
  })()

  function writeStatus () {
    if (!stateDir) return
    try {
      fs.writeFileSync(path.join(stateDir, 'status.json'), JSON.stringify({
        at: new Date().toISOString(),
        plugin: 'peregrine',
        version: '0.1.0',
        mode: 'preset',
        burned: {
          tag: burnedTag,
          bytes: burnedBytes,
          injected: burnedBytes > 0
        },
        config: {
          vaultRoot: cfg.vaultRoot,
          blockOnce: cfg.blockOnce,
          nearDuplicateThreshold: cfg.nearDuplicateThreshold,
          catalogMaxEntries: cfg.catalogMaxEntries
        },
        vaultExists: (() => { try { return fs.existsSync(cfg.vaultRoot) } catch { return false } })(),
        stats
      }, null, 2), 'utf8')
    } catch (e) { log('warn', '写 status.json 失败: ' + e.message) }
  }
  writeStatus()

  // ---- 工具：查重 / 目录 / 读条目 / 检索
  //
  // 注意：DSH 的 tools.register() 强制要求 output { schema, render }，
  // schema 只支持 type/oneOf/properties/required/additionalProperties/items/enum/const。
  // 少写一个 render 就是整条工具注册失败（实测日志：
  //   tool "peregrine_catalog" must declare output { schema, render, presentationMeta? }）
  const tools = ctx.get && ctx.get('tools')
  const register = (def) => {
    try {
      if (tools && typeof tools.register === 'function') {
        tools.register(def)
        return true
      }
    } catch (e) { log('warn', `注册工具 ${def.name} 失败: ${e.message}`) }
    return false
  }

  /** 输出 schema 的公共外壳：对象根 + 允许额外字段 */
  const outSchema = (properties) => ({
    type: 'object',
    additionalProperties: true,
    ...(properties ? { properties } : {})
  })

  /** 把值渲染成给模型看的一段文本（紧凑，避免回灌大对象） */
  const renderText = (fn) => (_args, value) => [{ type: 'text', text: fn(value) }]

  register({
    name: 'peregrine_duplicate_check',
    description:
      '入库前查重：给一段待入库的材料，与记忆库已有条目比对，判断是不是已经记过。' +
      '先用 SimHash 指纹粗筛，再用 shingle 集合的 Jaccard 与包含度精确判定 —— ' +
      '后者能抓到改写、截断、重排过的同一份材料（只靠 SimHash 会漏）。' +
      '返回的 duplicate=true 说明这条大概率已经记过，不要重复写。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '待入库材料的正文' },
        hammingThreshold: { type: 'number', description: 'SimHash 海明距离阈值，默认按文本长度自适应（短文 8、长文 3）' },
        containmentThreshold: { type: 'number', description: '包含度阈值，默认 0.55：新材料有多少比例已被库里某条覆盖' },
        jaccardThreshold: { type: 'number', description: 'Jaccard 阈值，默认 0.45：两篇的重合程度' },
        limit: { type: 'number', description: '最多返回几条，默认 5' }
      },
      required: ['text']
    },
    output: {
      schema: outSchema({
        ok: { type: 'boolean' },
        duplicate: { type: 'boolean' },
        scanned: { type: 'number' },
        fingerprint: { type: 'string' },
        matches: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: true,
            properties: {
              path: { type: 'string' },
              distance: { type: 'number' },
              jaccard: { type: 'number' },
              containment: { type: 'number' },
              reason: { type: 'string' }
            }
          }
        }
      }),
      render: renderText((v) => {
        if (!v || v.ok === false) return `查重失败：${(v && v.error) || '未知错误'}`
        if (!v.duplicate) return `未命中重复（扫描 ${v.scanned} 条），可以入库。`
        const lines = [`命中 ${v.matches.length} 条高度重合，不要重复写：`]
        for (const m of v.matches) {
          const how = m.reason === 'containment'
            ? `包含度 ${Math.round((m.containment || 0) * 100)}%`
            : (m.reason === 'jaccard'
              ? `Jaccard ${Math.round((m.jaccard || 0) * 100)}%`
              : `距离 ${m.distance}`)
          lines.push(`- ${m.path}（${how}）`)
        }
        return lines.join('\n')
      })
    },
    async execute (args) {
      const a = args || {}
      const text = norm(a.text)
      if (!text) return { ok: false, error: '缺少 text' }
      const existing = index.get()
      const r = detectDuplicate(text, existing, {
        hammingThreshold: Number.isFinite(a.hammingThreshold)
          ? a.hammingThreshold
          : suggestThreshold(extractFeatures(text).length),
        containmentThreshold: Number.isFinite(a.containmentThreshold) ? a.containmentThreshold : cfg.containmentThreshold,
        jaccardThreshold: Number.isFinite(a.jaccardThreshold) ? a.jaccardThreshold : cfg.jaccardThreshold,
        limit: a.limit || 5
      })

      stats.checked++
      if (r.duplicate) stats.duplicates++
      writeStatus()

      return {
        ok: true,
        fingerprint: simhash(text),
        featureCount: extractFeatures(text).length,
        scanned: r.checked,
        duplicate: r.duplicate,
        matches: r.matches.map((m) => ({
          path: m.entry.path,
          title: m.entry.title,
          distance: m.distance,
          jaccard: m.jaccard == null ? null : Number(m.jaccard.toFixed(3)),
          containment: m.containment == null ? null : Number(m.containment.toFixed(3)),
          reason: m.reason
        }))
      }
    }
  })

  register({
    name: 'peregrine_catalog',
    description:
      '看记忆库目录（L0）：只返回各层条目的标题与一句话摘要，不含正文。' +
      '上下文有界，先用它决定该读哪一条，再用 peregrine_read 按需取正文。',
    parameters: {
      type: 'object',
      properties: {
        layer: { type: 'string', description: '只看某一层（如 memory、registry），留空看全部' },
        maxEntries: { type: 'number', description: '最多返回多少条，默认取配置值' }
      }
    },
    output: {
      schema: outSchema({ ok: { type: 'boolean' }, catalog: { type: 'string' } }),
      render: renderText((v) => (v && v.ok ? v.catalog : '目录读取失败。'))
    },
    async execute (args) {
      const a = args || {}
      const cat = buildCatalog(cfg.vaultRoot, {
        maxEntries: a.maxEntries || cfg.catalogMaxEntries,
        includeLayers: a.layer ? [a.layer] : undefined
      })
      return { ok: true, catalog: renderCatalog(cat) }
    }
  })

  register({
    name: 'peregrine_read',
    description:
      '按需读记忆库里的一条正文（L2）。只有确定要看某条的完整内容时才用；' +
      '先 peregrine_catalog 或 peregrine_search 定位，不要盲目全读。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对记忆库根的路径，如 memory/layer-4-long-term.md' },
        maxBytes: { type: 'number', description: '最多读多少字节，默认 12000' }
      },
      required: ['path']
    },
    output: {
      schema: outSchema({
        ok: { type: 'boolean' },
        rel: { type: 'string' },
        bytes: { type: 'number' },
        truncated: { type: 'boolean' },
        text: { type: 'string' },
        error: { type: 'string' }
      }),
      render: renderText((v) => {
        if (!v || v.ok === false) return `读取失败：${(v && v.error) || '未知错误'}`
        const tail = v.truncated ? '\n（已截断，需要更多请调大 maxBytes）' : ''
        return `${v.rel}（${v.bytes} 字节）\n\n${v.text}${tail}`
      })
    },
    async execute (args) {
      const r = readEntry(cfg.vaultRoot, norm(args && args.path), { maxBytes: args.maxBytes })
      return r
    }
  })

  register({
    name: 'peregrine_search',
    description:
      '在记忆库目录里按关键词定位条目（只看标题与摘要，不读正文）。' +
      '用于"这个知识点库里有没有相关条目"，比全库读一遍省上下文。',
    parameters: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: '关键词' },
        limit: { type: 'number', description: '最多返回几条，默认 10' }
      },
      required: ['keyword']
    },
    output: {
      schema: outSchema({
        ok: { type: 'boolean' },
        hits: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: true,
            properties: {
              rel: { type: 'string' },
              title: { type: 'string' },
              summary: { type: 'string' },
              score: { type: 'number' }
            }
          }
        }
      }),
      render: renderText((v) => {
        if (!v || v.ok === false) return '检索失败。'
        if (!v.hits.length) return '库里没有标题或摘要命中这个词的条目。'
        const lines = [`命中 ${v.hits.length} 条（只给摘要，正文用 peregrine_read 按需取）：`]
        for (const h of v.hits) {
          const s = h.summary ? ' — ' + h.summary.slice(0, 120) : ''
          lines.push(`- ${h.title}（${h.rel}）${s}`)
        }
        return lines.join('\n')
      })
    },
    async execute (args) {
      const hits = searchEntries(cfg.vaultRoot, norm(args && args.keyword), { limit: args.limit || 10 })
      return { ok: true, hits }
    }
  })

  register({
    name: 'peregrine_gate',
    description:
      '跑入库四关：给材料打四维分、判形态、检查 SKILL.md 合规、检查带/不带对照。' +
      '返回 blockers（必须改）与 warnings（可继续）。blockers 非空就不许入库。',
    parameters: {
      type: 'object',
      properties: {
        score: {
          type: 'object',
          description: '四维分值 {unexpectedness(0-3), elegance(0-3), chain(0-2), reproducibility(0-2)}'
        },
        decide: {
          type: 'object',
          description: '形态判定输入 {aiLikelyKnown, frequency: high|medium|low, needsOrdering, layerDir, name}'
        },
        write: {
          type: 'object',
          description: 'SKILL.md 检查输入 {text, hasScripts, gitignoreCoversEvidence}'
        },
        test: {
          type: 'object',
          description: '对照记录 {validation:{cases:[{prompt,withSkill,withoutSkill,hasCorrectAnswer,avoid}], withSkillWorse}}'
        }
      }
    },
    output: {
      schema: outSchema({
        passed: { type: 'boolean' },
        blockers: { type: 'array', items: { type: 'object', additionalProperties: true } },
        warnings: { type: 'array', items: { type: 'object', additionalProperties: true } }
      }),
      render: renderText((v) => {
        if (!v) return '四关执行失败。'
        const lines = [v.passed ? '✅ 四关通过，可以入库。' : '⛔ 有 blocker，不许入库。']
        if (v.decide) lines.push(`形态：${v.decide.form} → ${v.decide.dest}（${v.decide.reason}）`)
        if (v.screen) lines.push(`价值分：${v.screen.total}/10`)
        for (const b of v.blockers || []) lines.push(`  ⛔ ${b.code}：${b.message}`)
        for (const w of (v.warnings || []).slice(0, 5)) lines.push(`  ⚠ ${w.code}：${w.message}`)
        return lines.join('\n')
      })
    },
    async execute (args) {
      const g = runGates(args || {})
      stats.checked++
      if (g.blockers.length) { stats.blocked++; for (const b of g.blockers) stats.byCode[b.code] = (stats.byCode[b.code] || 0) + 1 }
      else if (g.warnings.length) stats.warned++
      else stats.passed++
      writeStatus()
      return g
    }
  })

  // ---- 团队汇总：多人 vault 跨库去重
  //
  // 只读分析，产出报告。**不写任何 vault 文件** ——
  // 跨库合并的冲突必须由人裁决，自动合并会把不同人基于不同前提的结论揉成一条。

  register({
    name: 'peregrine_merge',
    description:
      '团队汇总：给多个 vault 路径，跨库找出重复/近似条目，产出可合并簇与待裁决清单。' +
      '只读分析，不会修改任何文件。' +
      '判据：sha256 抓完全相同 + SimHash LSH 分桶 + shingle 包含度/Jaccard 精确复核。',
    parameters: {
      type: 'object',
      properties: {
        vaults: {
          type: 'array',
          items: { type: 'string' },
          description: '各人的 vault 根目录，至少两个'
        },
        containmentThreshold: { type: 'number', description: '包含度阈值，默认 0.55' },
        jaccardThreshold: { type: 'number', description: 'Jaccard 阈值，默认 0.45' },
        format: {
          type: 'string',
          enum: ['report', 'json'],
          description: 'report 出 markdown 报告（默认）；json 出机器可读结果'
        }
      },
      required: ['vaults']
    },
    output: {
      schema: outSchema({
        ok: { type: 'boolean' },
        stats: { type: 'object', additionalProperties: true },
        report: { type: 'string' },
        json: { type: 'string' },
        message: { type: 'string' }
      }),
      render: renderText((v) => {
        if (!v || v.ok === false) return `汇总失败：${(v && v.message) || '未知错误'}`
        return v.report || v.json || '（无结果）'
      })
    },
    async execute (args) {
      const a = args || {}
      const vaults = (Array.isArray(a.vaults) ? a.vaults : []).filter(Boolean).map(String)
      if (vaults.length < 2) return { ok: false, message: '至少要给两个 vault 路径' }
      try {
        const r = analyzeVaults(vaults, {
          containmentThreshold: Number.isFinite(a.containmentThreshold) ? a.containmentThreshold : cfg.containmentThreshold,
          jaccardThreshold: Number.isFinite(a.jaccardThreshold) ? a.jaccardThreshold : cfg.jaccardThreshold
        })
        stats.merges = (stats.merges || 0) + 1
        writeStatus()
        if (a.format === 'json') {
          return {
            ok: true,
            stats: r.stats,
            json: JSON.stringify({ stats: r.stats, clusters: r.clusters, conflicts: r.conflicts }, null, 2)
          }
        }
        return { ok: true, stats: r.stats, report: renderMergeReport(r) }
      } catch (e) {
        return { ok: false, message: e.message }
      }
    }
  })

  // ---- T2：完整评分卡按需读取
  //
  // T1（prompt/burned.md）是每轮都在的纪律骨架；完整评分卡 7KB 放 T2，
  // 只有真的要逐条核对时才拉，避免每轮都付这份 token。

  register({
    name: 'peregrine_rubric',
    description:
      '按需读完整评分卡（T2）。固定前缀里只有纪律骨架；' +
      '要逐条核对细节时调这个。可用 section 只取某一步（如 "1"、"3"），避免整篇 7KB 一次拉。' +
      '不传 section 会返回全文，同时给出当前烧录版本号。',
    parameters: {
      type: 'object',
      properties: {
        section: {
          type: 'string',
          description: '只看某一步，如 "0" / "1" / "2" / "3" / "4" / "5" / "6"；不传返回全文'
        }
      }
    },
    output: {
      schema: outSchema({
        ok: { type: 'boolean' },
        section: { type: 'string' },
        tag: { type: 'string' },
        bytes: { type: 'number' },
        text: { type: 'string' },
        error: { type: 'string' }
      }),
      render: renderText((v) => {
        if (!v || v.ok === false) return `读取失败：${(v && v.error) || '未知错误'}`
        const head = `<!-- 评分卡 ${v.tag} · ${v.bytes} B${v.section ? ' · 第 ' + v.section + ' 步' : ' · 全文'} -->`
        return head + '\n\n' + v.text
      })
    },
    async execute (args) {
      const r = loadRubric(args && args.section)
      return { ...r, tag: burnedTag }
    }
  })

  // ---- anysearch：key 管理与直连检索
  //
  // 这套工具让游隼模式**自带** anysearch 能力，不依赖宿主 MCP 行：
  //   - key 存在 <DSH_HOME>\plugins\peregrine\anysearch.json，改完立即生效（不用重启）
  //   - 每次调用时才读文件，所以换 key 不需要动 cordis.patch.yml
  //   - 团队里每人用自己的 key，不会把某个人的 key 同步出去

  register({
    name: 'peregrine_anysearch_key',
    description:
      '查看或设置游隼模式使用的 anysearch API key。' +
      'action=get 看当前 key（掩码显示）；action=set 写入新 key；action=status 连通性自检。' +
      'key 只存在本机，改完立即生效，不需要重启 DSH。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['get', 'set', 'status'],
          description: 'get 查看 / set 设置 / status 自检'
        },
        apiKey: { type: 'string', description: 'action=set 时必填，形如 as_sk_...' },
        url: { type: 'string', description: '可选，自定义端点，默认 https://api.anysearch.com/mcp' }
      },
      required: ['action']
    },
    output: {
      schema: outSchema({
        ok: { type: 'boolean' },
        action: { type: 'string' },
        maskedKey: { type: 'string' },
        url: { type: 'string' },
        configPath: { type: 'string' },
        toolCount: { type: 'number' },
        message: { type: 'string' }
      }),
      render: renderText((v) => {
        if (!v) return 'anysearch key 操作失败。'
        if (v.action === 'set') return v.ok ? `✅ 已保存：${v.maskedKey}\n立即生效，无需重启。` : `❌ 保存失败：${v.message}`
        if (v.action === 'status') {
          return v.ok
            ? `✅ anysearch 可用（${v.toolCount} 个工具）\nkey：${v.maskedKey}\n端点：${v.url}`
            : `❌ anysearch 不可用：${v.message}` + (v.maskedKey ? `\n当前 key：${v.maskedKey}` : '')
        }
        return v.ok
          ? `当前 key：${v.maskedKey}\n端点：${v.url}\n配置文件：${v.configPath}`
          : `未设置 key。用 action=set 设置，或写入 ${v.configPath}`
      })
    },
    async execute (args) {
      const a = args || {}
      const action = norm(a.action) || 'get'
      const cfgPath = anysearchConfigPath()

      if (action === 'set') {
        const key = norm(a.apiKey).trim()
        if (!key) return { ok: false, action, message: '缺少 apiKey', configPath: cfgPath }
        if (!/^as_sk_[A-Za-z0-9]{8,}$/.test(key)) {
          return { ok: false, action, message: 'key 格式不对，应形如 as_sk_xxxx', configPath: cfgPath }
        }
        try {
          const saved = writeAnysearchConfig({ apiKey: key, url: norm(a.url) })
          log('info', 'anysearch key 已更新（' + maskKey(saved.apiKey) + '）')
          return {
            ok: true,
            action,
            maskedKey: maskKey(saved.apiKey),
            url: saved.url,
            configPath: cfgPath,
            message: '已保存'
          }
        } catch (e) {
          return { ok: false, action, message: e.message, configPath: cfgPath }
        }
      }

      if (action === 'status') {
        const h = await anysearchHealth({})
        return {
          ok: h.ok,
          action,
          maskedKey: h.maskedKey || maskKey(readAnysearchConfig().apiKey),
          url: h.url || readAnysearchConfig().url,
          toolCount: h.toolCount || 0,
          configPath: cfgPath,
          message: h.ok ? '可用' : (h.message || '不可用')
        }
      }

      // get
      const cfg = readAnysearchConfig()
      return {
        ok: !!cfg.apiKey,
        action: 'get',
        maskedKey: maskKey(cfg.apiKey),
        url: cfg.url,
        configPath: cfgPath
      }
    }
  })

  register({
    name: 'peregrine_anysearch',
    description:
      '用 anysearch 检索外部材料（游隼自带，走 peregrine_anysearch_key 配置的 key）。' +
      'action=search 单条查询；action=batch_search 最多 5 条并行；action=extract 抓某个 URL 的正文。' +
      '做材料蒸馏时优先用它，比原生 web_search 结果更结构化。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['search', 'batch_search', 'extract'],
          description: 'search 单条 / batch_search 批量 / extract 抓正文'
        },
        query: { type: 'string', description: 'action=search 时的查询词' },
        queries: {
          type: 'array',
          items: { type: 'string' },
          description: 'action=batch_search 时的查询词数组（最多 5 条）'
        },
        url: { type: 'string', description: 'action=extract 时要抓的 URL' },
        maxResults: { type: 'number', description: 'action=search 时最多返回几条，默认 10' }
      },
      required: ['action']
    },
    output: {
      schema: outSchema({
        ok: { type: 'boolean' },
        action: { type: 'string' },
        text: { type: 'string' },
        message: { type: 'string' }
      }),
      render: renderText((v) => {
        if (!v) return 'anysearch 调用失败。'
        if (v.ok === false) return `❌ anysearch 失败：${v.message}`
        // 结果已经是 markdown，直接给
        return String(v.text || '').slice(0, 12000)
      })
    },
    async execute (args) {
      const a = args || {}
      const action = norm(a.action) || 'search'
      try {
        if (action === 'extract') {
          const url = norm(a.url).trim()
          if (!url) return { ok: false, action, message: '缺少 url' }
          const r = await anysearchExtract(url, {})
          return { ok: true, action, text: r.text }
        }
        if (action === 'batch_search') {
          const list = Array.isArray(a.queries) ? a.queries : []
          if (!list.length) return { ok: false, action, message: '缺少 queries' }
          const r = await anysearchBatch(list, {})
          stats.anysearchCalls = (stats.anysearchCalls || 0) + 1
          writeStatus()
          return { ok: true, action, text: r.text }
        }
        const q = norm(a.query).trim()
        if (!q) return { ok: false, action, message: '缺少 query' }
        const r = await anysearchSearch(q, { maxResults: a.maxResults || 10 })
        stats.anysearchCalls = (stats.anysearchCalls || 0) + 1
        writeStatus()
        return { ok: true, action, text: r.text }
      } catch (e) {
        return { ok: false, action, message: e.message }
      }
    }
  })

  // ---- 拦截写库
  const states = new Map()
  function getState (agent) {
    const key = (agent && (agent.id || agent.sessionId)) || 'default'
    if (!states.has(key)) states.set(key, { blocked: new Map() })
    return states.get(key)
  }

  function judge (exec) {
    const a = exec.args || exec.arguments || {}
    const target = norm(a.path || a.file_path || a.filePath)
    const kind = classifyWriteTarget(target)
    const findings = []
    const content = norm(a.content || a.new_string || a.newString || a.text || a.body)

    if (isGeneratedFile(target)) {
      findings.push({
        level: 'block',
        code: 'generated-file-write',
        message: `${target} 是生成物，不可手改`,
        fix: '改生成器后重跑，不要直接编辑产物'
      })
    }

    if (kind === 'skill-md' && content) {
      findings.push(...checkWriting({
        text: content,
        hasScripts: /scripts\//.test(content),
        gitignoreCoversEvidence: true
      }))
    } else if ((kind === 'memory' || kind === 'reference') && content) {
      findings.push(...checkMemoryEntry({ text: content, kind }))
      // 记忆条目还要查重：SimHash 粗筛 + shingle 精确判定
      const dup = detectDuplicate(content, index.get(), {
        hammingThreshold: cfg.nearDuplicateThreshold,
        containmentThreshold: cfg.containmentThreshold,
        jaccardThreshold: cfg.jaccardThreshold,
        limit: 3
      })
      if (dup.duplicate) {
        const top = dup.matches[0]
        const how = top.reason === 'containment'
          ? `包含度 ${(top.containment * 100).toFixed(0)}%`
          : (top.reason === 'jaccard'
            ? `Jaccard ${(top.jaccard * 100).toFixed(0)}%`
            : `距离 ${top.distance}`)
        const others = dup.matches.slice(1).map((m) => m.entry.path)
        findings.push({
          level: 'block',
          code: 'near-duplicate',
          message: `库里已有高度重合的条目：${top.entry.path}（${how}）` +
            (others.length ? `；另有 ${others.join('、')}` : ''),
          fix: '先看那一条能不能直接复用或补充，不要重复写一遍（手册：同一套路第三次才值得固定位置）'
        })
      }
    }

    return { kind, target, findings }
  }

  function wire (agent) {
    const state = getState(agent)
    const bus = agent.ctx || ctx
    if (!bus || typeof bus.on !== 'function') return () => {}

    bus.on('tools/pre-execute', async (payload, next) => {
      try {
        const exec = payload && (payload.call || payload.exec || payload)
        if (!isVaultWrite(exec, cfg.vaultRoot)) return next ? next() : undefined

        const { kind, target, findings } = judge(exec)
        const blocks = findings.filter((f) => f.level === 'block')
        const warns = findings.filter((f) => f.level === 'warn')

        if (!blocks.length && !warns.length) { stats.passed++; writeStatus(); return next ? next() : undefined }

        if (blocks.length) { stats.blocked++ } else { stats.warned++ }
        for (const f of findings) stats.byCode[f.code] = (stats.byCode[f.code] || 0) + 1

        const fp = kind + '|' + (blocks.map((b) => b.code).join(',') || warns.map((w) => w.code).join(','))
        const seen = state.blocked.get(fp) || 0
        state.blocked.set(fp, seen + 1)

        const text = formatReminder(findings, {
          title: `${target} 没过入库闸门`,
          fix: (blocks[0] && blocks[0].fix) || (warns[0] && warns[0].fix),
          ruleRef: cfg.handbookPath || '蒸馏 AI Skill成为Ai小子原版.md'
        })

        try {
          if (agent.inject) agent.inject(pluginMessage(text))
          else if (bus.inject) bus.inject(pluginMessage(text))
        } catch (e) { log('warn', 'inject 失败: ' + e.message) }

        if (blocks.length && (cfg.blockOnce ? seen === 0 : true)) {
          log('info', `拦下一次写库：${target}`)
          writeStatus()
          return { kind: 'deny', reason: text }
        }

        writeStatus()
        return next ? next() : undefined
      } catch (e) {
        log('error', 'pre-execute 出错: ' + (e && e.message))
        return next ? next() : undefined
      }
    })

    stats.wired++
    writeStatus()
    return () => { states.delete((agent && (agent.id || agent.sessionId)) || 'default') }
  }

  if (typeof ctx.on === 'function') {
    ctx.on('agent/created', (agent) => { try { wire(agent) } catch (e) { log('error', 'wire 失败: ' + e.message) } })
    ctx.on('agent/session-start', (agent) => { try { wire(agent) } catch (e) { log('error', 'wire 失败: ' + e.message) } })
  }

  if (!cfg.vaultRoot) {
    // 没有记忆库就只是一个"四关空转"的模式：明确说出来，别让人以为在生效
    log('warn', '未配置 vaultRoot —— 记忆库相关能力（目录/检索/查重/团队汇总）将不可用。' +
      '请在预设 config 里设 vaultRoot，或设环境变量 SAKER_VAULT_ROOT')
  } else if (!(() => { try { return fs.existsSync(cfg.vaultRoot) } catch { return false } })()) {
    log('warn', `vaultRoot 指向的目录不存在：${cfg.vaultRoot}`)
  }
  log('info', `游隼模式已挂载（vault=${cfg.vaultRoot || '(未配置)' }）`)
}

export {
  runGates, simhash, detectDuplicate, buildCatalog, renderCatalog,
  readEntry, searchEntries, buildSearchPlan, normalizeHits,
  analyzeVaults, renderMergeReport
}
