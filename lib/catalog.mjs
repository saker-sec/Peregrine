/**
 * 游隼 · 渐进披露索引（Progressive Disclosure）
 *
 * 解决的问题：你担心「把一整个记忆库读入上下文，占大量 token」。
 *
 * 做法来自 Anthropic《Effective context engineering for AI agents》：
 *   「让 agent 自主导航与按需检索 → progressive disclosure：
 *     通过探索逐步发现相关上下文，只把必要的东西留在工作记忆里」
 *   以及「just in time」：不要预先加载全部数据，只保留轻量标识符（路径、索引），
 *   需要时再用工具把那一块取出来。
 *
 * 落到这里分三层：
 *   L0  目录层  只有「编号分类 → 条目名 + 一句话」，几十行，永远可付
 *   L1  摘要层  某一条的标题、触发条件、锚点，几百字
 *   L2  正文层  真正要用时才读全文
 *
 * 指挥官默认只拿 L0；需要哪条再要 L1；确实要抄规则时才要 L2。
 * 这样 481 个 .md 的记忆库不会一次性压进上下文。
 */

import fs from 'node:fs'
import path from 'node:path'

/** 记忆库的分层目录（对齐手册 §5 的编号分类 + vault 实际结构） */
export const LAYER_ORDER = [
  '00-routing',
  'memory',
  'registry',
  'agents',
  'archive'
]

/**
 * 扫描深度上限。
 * 记忆库里真正的主力是 `memory/kb/` 下几百个 -chain.md，
 * 必须递归进去；但也不能无限深，否则一条链能扫出几千个文件。
 */
export const MAX_SCAN_DEPTH = 3

/** 单条摘要最多多少字 —— 再多就没有"渐进"的意义了 */
export const SUMMARY_MAX_CHARS = 240

/** L0 目录最多返回多少条 —— 防止目录本身就把上下文撑爆 */
export const CATALOG_MAX_ENTRIES = 120

/**
 * 层内优先级：同一层里先列哪些。
 *
 * 排序意图（越靠前越该被先看到）：
 *   1. 核心索引    MEMORY.md / layer-0-entry.md / user-profile.md —— 进库入口
 *   2. 浅层普通条目 memory/*.md（不含下划线前缀）
 *   3. 工作记录    _ 开头（_rejection / _source-closed 这类台账）
 *   4. 子目录条目  kb/*.md
 *   5. chain 原子知识（靠检索定位，不该抢目录前排）
 */
function entryPriority (rel, depth) {
  let p = depth * 20

  const base = rel.split('/').pop()

  // 核心索引最优先 —— 这几份是"进库先读"的
  if (/^(MEMORY|SKILL|user-profile|layer-0-entry|layer-1-instant|layer-2-working|layer-3-short-term|layer-4-long-term)\.md$/i.test(base)) {
    return -100 + depth
  }

  // 下划线开头的是台账/来源记录，靠后
  if (base.startsWith('_')) p += 60

  // kb/ 里的原子知识更靠后（数量多，靠检索）
  if (rel.includes('/kb/')) p += 40

  // chain 是原子结论，再靠后
  if (/-chain\.md$/i.test(rel)) p += 15

  return p
}

function safeReaddir (dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }) } catch { return [] }
}

function readText (file, maxBytes) {
  try {
    const st = fs.statSync(file)
    if (!st.isFile()) return null
    const cap = maxBytes || 64 * 1024
    if (st.size > cap) {
      // 超大文件只读开头，避免一次吃进几百 KB
      const fd = fs.openSync(file, 'r')
      const buf = Buffer.alloc(cap)
      const n = fs.readSync(fd, buf, 0, cap, 0)
      fs.closeSync(fd)
      return buf.toString('utf8', 0, n)
    }
    return fs.readFileSync(file, 'utf8')
  } catch { return null }
}

/** 从 markdown 里抽标题与第一段有信息量的文字 */
export function summarizeMarkdown (text) {
  const src = String(text || '')
  const lines = src.split(/\r?\n/)

  let title = ''
  for (const l of lines) {
    const m = /^#{1,3}\s+(.+)$/.exec(l.trim())
    if (m) { title = m[1].trim(); break }
  }

  // 找第一段非标题、非代码、非表格、非空的行
  let para = ''
  for (const raw of lines) {
    const l = raw.trim()
    if (!l) continue
    if (l.startsWith('#')) continue
    if (l.startsWith('|')) continue
    if (l.startsWith('```')) continue
    if (/^[-*+]\s/.test(l)) continue
    if (l.startsWith('>')) { para = l.replace(/^>\s*/, ''); break }
    para = l
    break
  }

  // frontmatter description 优先（比正文第一段更能说明"这条是什么"）
  const fm = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---/.exec(src)
  if (fm) {
    const desc = extractFrontmatterField(fm[1], 'description')
    if (desc) para = desc
  }

  let summary = (para || '').replace(/\s+/g, ' ').trim()
  if (summary.length > SUMMARY_MAX_CHARS) summary = summary.slice(0, SUMMARY_MAX_CHARS) + '…'
  return { title: title || path.basename(''), summary }
}

/**
 * 从 frontmatter 正文里取一个字段的值。
 * 支持 `key: 值`、`key: >-` 折叠块、多行续写。
 * 逐行扫描，不依赖 yaml 库（T0 要零依赖）。
 */
function extractFrontmatterField (block, key) {
  const lines = String(block || '').split(/\r?\n/)
  const re = new RegExp('^' + key + ':\\s*(.*)$')
  let collecting = false
  const parts = []

  for (const line of lines) {
    if (!collecting) {
      const m = re.exec(line)
      if (!m) continue
      collecting = true
      const first = m[1].trim()
      // 折叠/字面块标记本身不是内容
      if (first && !/^[>|][-+]?$/.test(first)) {
        // 去掉包裹引号
        parts.push(first.replace(/^['"]|['"]$/g, ''))
        // 单行值且下一行不缩进 → 结束（继续扫描也无害，后面会被新 key 截断）
      }
      continue
    }
    // 收集缩进的续行
    if (/^\s+\S/.test(line)) {
      parts.push(line.trim())
      continue
    }
    // 遇到下一个顶层 key 或结束
    if (/^[A-Za-z_][\w-]*:/.test(line) || line.trim() === '') {
      if (line.trim() === '') continue
      break
    }
  }

  const value = parts.join(' ').replace(/\s+/g, ' ').trim()
  return value || ''
}

/**
 * 生成 L0 目录：只列「分类 → 条目名 + 一句话」。
 * 这是指挥官唯一默认看到的东西。
 *
 * 递归扫描各层（memory/kb/ 这种子目录必须进得去），
 * 但每层内的条目先按"浅层优先、chain 靠后"排序再截断，
 * 这样目录既覆盖到位，又不会被几百条 chain 淹没。
 *
 * @param {string} vaultRoot
 * @param {{maxEntries?:number, includeLayers?:string[], maxDepth?:number}} opts
 */
export function buildCatalog (vaultRoot, opts) {
  const o = opts || {}
  const maxEntries = o.maxEntries || CATALOG_MAX_ENTRIES
  const layers = Array.isArray(o.includeLayers) && o.includeLayers.length ? o.includeLayers : LAYER_ORDER
  const maxDepth = o.maxDepth != null ? o.maxDepth : MAX_SCAN_DEPTH

  const out = { vault: vaultRoot, exists: false, layers: [], totalEntries: 0, truncated: false }

  if (!vaultRoot || !fs.existsSync(vaultRoot)) return out
  out.exists = true

  // 先收集每层的全部候选（递归），排序后再按全局上限截断
  const collected = []
  for (const layer of layers) {
    const dir = path.join(vaultRoot, layer)
    if (!fs.existsSync(dir)) continue

    const found = []
    const walk = (d, relBase, depth) => {
      if (depth > maxDepth) return
      for (const ent of safeReaddir(d)) {
        if (ent.name === '.git' || ent.name === 'node_modules') continue
        const full = path.join(d, ent.name)
        const rel = relBase ? relBase + '/' + ent.name : ent.name
        if (ent.isDirectory()) { walk(full, relBase, depth) ; continue }
        if (!/\.md$/i.test(ent.name)) continue
        found.push({ full, rel, depth })
      }
    }
    walk(dir, '', 0)

    // 层内排序：浅的、非 chain 的排前面
    found.sort((a, b) => {
      const pa = entryPriority(a.rel, a.depth)
      const pb = entryPriority(b.rel, b.depth)
      if (pa !== pb) return pa - pb
      return a.rel.localeCompare(b.rel)
    })

    collected.push({ layer, found })
  }

  let count = 0
  for (const { layer, found } of collected) {
    const entries = []
    for (const f of found) {
      if (count >= maxEntries) { out.truncated = true; break }
      const text = readText(f.full, 16 * 1024)
      if (text == null) continue
      const { title, summary } = summarizeMarkdown(text)
      entries.push({
        rel: layer + '/' + f.rel,
        title: title || f.rel.replace(/\.md$/i, ''),
        summary,
        bytes: (() => { try { return fs.statSync(f.full).size } catch { return 0 } })()
      })
      count++
    }
    if (entries.length) out.layers.push({ layer, entries })
    if (count >= maxEntries) { out.truncated = true; break }
  }

  out.totalEntries = count
  return out
}

/**
 * 把 L0 目录渲染成一段紧凑文本（喂给指挥官时用这个，不是 JSON）。
 * 目的：同样的信息，字符数越少越好。
 */
export function renderCatalog (catalog, maxChars) {
  const cap = maxChars || 6000
  if (!catalog || !catalog.exists) return '(记忆库不存在或不可读)'

  const lines = [`记忆库目录（${catalog.totalEntries} 条，只列标题与一句话摘要；正文按需再读）`]
  for (const layer of catalog.layers) {
    lines.push('')
    lines.push(`## ${layer.layer}`)
    for (const e of layer.entries) {
      // 标题是给人/模型第一眼认出「这条讲什么」的关键，必须带上
      const head = e.title ? `${e.title}（${e.rel}）` : e.rel
      const s = e.summary ? ' — ' + e.summary : ''
      lines.push(`- ${head}${s}`)
      if (lines.join('\n').length > cap) {
        lines.push('- …（目录已截断，用 peregrine_index 按层再取）')
        return lines.join('\n')
      }
    }
  }
  if (catalog.truncated) lines.push('\n（条目数已达上限，只显示了前 ' + catalog.totalEntries + ' 条）')
  return lines.join('\n')
}

/**
 * L2：按需读一条正文，带字节上限。
 * 手册与 Anthropic 都强调「just in time」+ 有界取用。
 */
export function readEntry (vaultRoot, rel, opts) {
  const o = opts || {}
  const maxBytes = o.maxBytes || 12000

  if (!vaultRoot || !rel) return { ok: false, error: '缺少参数' }

  // 防路径穿越：只允许 vault 内的相对路径
  const normalized = String(rel).replace(/\\/g, '/').replace(/^\/+/, '')
  if (normalized.includes('..')) return { ok: false, error: '非法路径' }

  const full = path.join(vaultRoot, normalized)
  const rootResolved = path.resolve(vaultRoot)
  if (!path.resolve(full).startsWith(rootResolved)) return { ok: false, error: '路径越界' }
  if (!fs.existsSync(full)) return { ok: false, error: '条目不存在: ' + normalized }

  const text = readText(full, maxBytes)
  if (text == null) return { ok: false, error: '读取失败' }

  const st = fs.statSync(full)
  return {
    ok: true,
    rel: normalized,
    bytes: st.size,
    truncated: st.size > maxBytes,
    text
  }
}

/**
 * 在记忆库里按关键词做轻量检索（不引入向量库，纯子串 + 命中计数）。
 * 目的不是"搜得准"，是"有个便宜的入口能定位到该读哪条"。
 */
export function searchEntries (vaultRoot, keyword, opts) {
  const o = opts || {}
  const limit = o.limit || 10
  const kw = String(keyword || '').trim().toLowerCase()
  if (!kw) return []

  const catalog = buildCatalog(vaultRoot, { maxEntries: o.maxScan || 400 })
  const hits = []

  for (const layer of catalog.layers) {
    for (const e of layer.entries) {
      const hay = (e.title + ' ' + e.summary).toLowerCase()
      if (!hay.includes(kw)) continue
      // 命中次数 + 标题命中加权
      let score = hay.split(kw).length - 1
      if (e.title.toLowerCase().includes(kw)) score += 3
      hits.push({ rel: e.rel, title: e.title, summary: e.summary, score })
    }
  }

  hits.sort((a, b) => b.score - a.score)
  return hits.slice(0, limit)
}
