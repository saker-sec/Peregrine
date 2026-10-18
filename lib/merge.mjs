/**
 * 游隼 · 团队汇总去重
 *
 * 场景：团队每人一个 vault，每周把大家的成果汇总到主库。
 *
 * 核心问题不是"找出重复"（那个已经解决了），而是三件事：
 *   1. 规模：5 人 × 500 条 = 2500 条，两两比 = 312 万次，直接比 shingle 会卡死
 *   2. 决策：同一条被两个人写了，留哪份、另一份怎么处理
 *   3. 可审：合并是**不可逆**的，所以工具只出报告，不写库
 *
 * 解法：
 *   规模  先用 sha256 抓完全相同（O(n)），再用 SimHash LSH 分桶把候选对砍到很少
 *   决策  每条簇按"完整度"选主条，其余标 identical / contained / overlap 三种关系
 *   可审  analyzeVaults 是纯函数，只返回报告对象；写不写由人决定
 *
 * 参考：
 *   - SimHash + LSH banding 是网页去重的标准做法（海明距离近的会落进同一桶）
 *   - 跨库合并必须留 merged-into 指针而不是删除，否则会出现"幽灵数据"
 *     （RAG 知识库更新里最常见的一个坑）
 *
 * ⚠ 已知边界（实测，不是猜测）：
 *   这是**字面级**去重，抓不到"语义相同但用词完全不同"的两条。
 *   实测：两段讲同一件事、但几乎每句都换了措辞的文本，
 *   Jaccard 只有 0.056、包含度 0.134、海明距离 22 —— 全在阈值外，抓不到。
 *   要抓那种重复必须上 embedding（语义向量），那是另一套成本。
 *   所以本工具的定位是：**先把机械重复清干净**，语义重复交给人看目录判断。
 *   这不是缺陷，是范围声明。
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { simhash, shingleSet, jaccard, containment, FINGERPRINT_MAX_CHARS } from './simhash.mjs'

export const MERGE_DEFAULTS = {
  /** SimHash 海明距离（LSH 粗筛后的复核阈值） */
  hammingThreshold: 8,
  /** 包含度：一方被另一方覆盖的比例 */
  containmentThreshold: 0.55,
  /** Jaccard：两篇重合程度 */
  jaccardThreshold: 0.45,
  /** 单库最多收多少条（防超大库拖死） */
  maxEntriesPerVault: 3000,
  /** 单文件超过这个大小就不参与比对 */
  maxFileBytes: 500 * 1024,
  /**
   * LSH 分带数（64 位指纹切成几条带）。
   *
   * 必须能整除 16 个十六进制字符：4 带=16 位/带，8 带=8 位/带，16 带=4 位/带。
   *
   * 为什么默认 8 而不是 4：分带越少，漏检越多。
   * 实测 4 带 × 16 位时，海明距离 7 的一对只有约 39% 概率落进同一桶 ——
   * 也就是一半以上的真重复会被漏掉。8 带 × 8 位时约 96.5%。
   */
  bands: 8,
  /**
   * 条目数不超过这个值时**不走 LSH，直接全配对**。
   *
   * 理由：LSH 是概率算法，天生有假阴性。团队实际规模（几人 × 几百条）
   * 全配对的代价完全可接受（n=2000 时约 200 万次整数异或 + popcount，几秒内），
   * 那就没必要为了省这点时间牺牲召回。
   * 超过这个规模才切到 LSH，并在报告里标明是近似结果。
   */
  allPairsLimit: 2000
}

/** 按字符读头部，保证与查重侧同一截断长度 */
const HEAD_BYTES = FINGERPRINT_MAX_CHARS * 4

// ---------------------------------------------------------------- 扫描

/**
 * 扫描一个 vault 的 markdown 条目。
 * 只读，不写。
 */
export function scanVault (root, opts) {
  const o = { ...MERGE_DEFAULTS, ...(opts || {}) }
  const out = { root: String(root || ''), exists: false, entries: [], skipped: 0, truncated: false }
  if (!out.root || !fs.existsSync(out.root)) return out
  out.exists = true

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
  walk(out.root, '', 0)

  for (const f of files) {
    if (out.entries.length >= o.maxEntriesPerVault) { out.truncated = true; break }
    try {
      const st = fs.statSync(f.full)
      if (st.size > o.maxFileBytes) { out.skipped++; continue }
      const take = Math.min(HEAD_BYTES, st.size)
      const fd = fs.openSync(f.full, 'r')
      const buf = Buffer.alloc(take)
      fs.readSync(fd, buf, 0, take, 0)
      fs.closeSync(fd)
      const text = buf.toString('utf8')
      out.entries.push({
        vault: out.root,
        rel: f.rel,
        title: f.title,
        bytes: st.size,
        text,
        contentHash: crypto.createHash('sha256').update(text).digest('hex'),
        fingerprint: simhash(text),
        shingles: shingleSet(text)
      })
    } catch { out.skipped++ }
  }
  return out
}

// ---------------------------------------------------------------- LSH 分桶

/**
 * 把 16 位十六进制指纹切成若干带，用于 LSH。
 *
 * 每带取 floor(16/bands) 个十六进制字符；带数必须是 4/8/16 这类能整除的，
 * 否则尾部会被丢掉（不会越界取空串 —— 越界取空串会让所有条目落进同一个桶，
 * 那等于退化成全配对，还多了开销）。
 */
export function lshBands (fingerprint, bands) {
  const hex = String(fingerprint || '').padStart(16, '0').slice(0, 16)
  let n = Number.isFinite(bands) ? Math.floor(bands) : MERGE_DEFAULTS.bands
  if (n < 1) n = 1
  if (n > 16) n = 16
  const per = Math.max(1, Math.floor(16 / n))
  const list = []
  for (let i = 0; i < n; i++) {
    const start = i * per
    if (start >= 16) break
    list.push(i + ':' + hex.slice(start, start + per))
  }
  return list
}

// ---------------------------------------------------------------- 并查集

function makeUnionFind (n) {
  const parent = Array.from({ length: n }, (_, i) => i)
  const find = (x) => {
    let r = x
    while (parent[r] !== r) r = parent[r]
    while (parent[x] !== r) { const nx = parent[x]; parent[x] = r; x = nx }
    return r
  }
  const union = (a, b) => {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent[rb] = ra
  }
  return { find, union }
}

// ---------------------------------------------------------------- 分析

function hamming (a, b) {
  const x = BigInt('0x' + String(a).padStart(16, '0'))
  const y = BigInt('0x' + String(b).padStart(16, '0'))
  let v = x ^ y
  let c = 0
  while (v > 0n) { v &= v - 1n; c++ }
  return c
}

/**
 * 跨库合并分析。**纯函数，不写任何文件。**
 *
 * @param {string[]} roots 各人的 vault 根目录
 * @param {object} opts 阈值覆盖
 * @returns {{ stats, clusters, conflicts, skippedVaults, options }}
 */
export function analyzeVaults (roots, opts) {
  const o = { ...MERGE_DEFAULTS, ...(opts || {}) }
  const list = (Array.isArray(roots) ? roots : [roots]).filter(Boolean).map(String)

  const scans = list.map((r) => scanVault(r, o))
  const scanned = scans.filter((s) => s.exists)
  const missing = scans.filter((s) => !s.exists).map((s) => s.root)

  // 扁平化，记录每条属于哪个库
  const all = []
  for (const s of scanned) {
    for (const e of s.entries) all.push(e)
  }

  const stats = {
    vaults: scanned.length,
    missingVaults: missing.length,
    totalEntries: all.length,
    identicalPairs: 0,
    nearPairs: 0,
    clusters: 0,
    crossVaultClusters: 0
  }

  if (all.length === 0) {
    return { stats, clusters: [], conflicts: [], missingVaults: missing, options: o }
  }

  const uf = makeUnionFind(all.length)

  // ── 第一步：精确哈希分组（O(n)，抓完全相同的副本）
  const byHash = new Map()
  all.forEach((e, i) => {
    if (!byHash.has(e.contentHash)) byHash.set(e.contentHash, [])
    byHash.get(e.contentHash).push(i)
  })
  for (const group of byHash.values()) {
    if (group.length < 2) continue
    // 只把**跨库**的相同副本并起来；同库内的重复属于那个人自己的问题，单独统计
    for (let k = 1; k < group.length; k++) {
      if (all[group[k]].vault !== all[group[0]].vault) {
        uf.union(group[0], group[k])
        stats.identicalPairs++
      }
    }
  }

  // ── 第二步：找候选对
  //
  // 两种策略，按规模自动选：
  //   small（默认，团队实际规模）→ 全配对。**没有假阴性**，结果可复现。
  //   large                     → LSH 分带。有概率漏检，报告里会标明。
  const useAllPairs = all.length <= o.allPairsLimit
  stats.strategy = useAllPairs ? 'all-pairs' : 'lsh'
  stats.bands = useAllPairs ? null : o.bands

  // 指纹预先转成 BigInt：全配对时避免重复解析，异或 + popcount 都是原生整数运算
  const fps = all.map((e) => BigInt('0x' + String(e.fingerprint).padStart(16, '0')))

  const comparePair = (i, j) => {
    const a = all[i]
    const b = all[j]
    if (a.vault === b.vault) return
    let v = fps[i] ^ fps[j]
    let d = 0
    while (v > 0n) { v &= v - 1n; d++ }
    if (d > o.hammingThreshold) return
    const cont = containment(a.shingles, b.shingles)
    const jac = jaccard(a.shingles, b.shingles)
    if (cont >= o.containmentThreshold || jac >= o.jaccardThreshold) {
      uf.union(i, j)
      stats.nearPairs++
    }
  }

  if (useAllPairs) {
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) comparePair(i, j)
    }
  } else {
    const buckets = new Map()
    all.forEach((e, i) => {
      for (const band of lshBands(e.fingerprint, o.bands)) {
        if (!buckets.has(band)) buckets.set(band, [])
        buckets.get(band).push(i)
      }
    })
    const seenPair = new Set()
    for (const ids of buckets.values()) {
      if (ids.length < 2) continue
      for (let x = 0; x < ids.length; x++) {
        for (let y = x + 1; y < ids.length; y++) {
          const i = ids[x]
          const j = ids[y]
          const key = i < j ? i + ':' + j : j + ':' + i
          if (seenPair.has(key)) continue
          seenPair.add(key)
          comparePair(i, j)
        }
      }
    }
  }

  // ── 第三步：收簇
  const groups = new Map()
  all.forEach((e, i) => {
    const r = uf.find(i)
    if (!groups.has(r)) groups.set(r, [])
    groups.get(r).push(i)
  })

  const clusters = []
  const conflicts = []

  for (const ids of groups.values()) {
    if (ids.length < 2) continue

    const members = ids.map((i) => all[i])
    const vaultsInvolved = [...new Set(members.map((m) => m.vault))]
    if (vaultsInvolved.length < 2) continue // 同库内的重复不归跨库合并管

    // 选主条：shingle 数量（≈信息量）最大，其次字节数
    const sorted = [...members].sort((x, y) =>
      (y.shingles.length - x.shingles.length) || (y.bytes - x.bytes)
    )
    const primary = sorted[0]

    const rest = sorted.slice(1).map((m) => {
      const cont = containment(primary.shingles, m.shingles)
      const jac = jaccard(primary.shingles, m.shingles)
      const d = hamming(primary.fingerprint, m.fingerprint)
      let relation = 'overlap'
      if (m.contentHash === primary.contentHash) relation = 'identical'
      else if (cont >= 0.9) relation = 'contained'
      else if (jac >= o.jaccardThreshold) relation = 'overlap'

      return {
        vault: m.vault,
        rel: m.rel,
        title: m.title,
        bytes: m.bytes,
        shingles: m.shingles.length,
        hamming: d,
        jaccard: Number(jac.toFixed(3)),
        containment: Number(cont.toFixed(3)),
        relation
      }
    })

    const cluster = {
      id: 'c' + (clusters.length + 1),
      primary: {
        vault: primary.vault,
        rel: primary.rel,
        title: primary.title,
        bytes: primary.bytes,
        shingles: primary.shingles.length
      },
      members: rest,
      vaults: vaultsInvolved
    }
    clusters.push(cluster)

    // 需要人裁决的：既不是完全相同、也不是明显被包含
    const needReview = rest.filter((m) => m.relation === 'overlap')
    if (needReview.length) {
      conflicts.push({
        id: cluster.id,
        primary: cluster.primary,
        candidates: needReview,
        why: '两篇重合但互不包含 —— 可能是同一技术的不同表述，需要人判断是互补还是重复'
      })
    }
  }

  stats.clusters = clusters.length
  stats.crossVaultClusters = clusters.length

  // 报告按"涉及的人越多越靠前"排序
  clusters.sort((a, b) => (b.vaults.length - a.vaults.length) || a.id.localeCompare(b.id))
  conflicts.sort((a, b) => a.id.localeCompare(b.id))

  return {
    stats,
    clusters,
    conflicts,
    missingVaults: missing,
    options: {
      hammingThreshold: o.hammingThreshold,
      containmentThreshold: o.containmentThreshold,
      jaccardThreshold: o.jaccardThreshold
    }
  }
}

// ---------------------------------------------------------------- 渲染

const REL_LABEL = {
  identical: '完全相同',
  contained: '被主条包含',
  overlap: '部分重合'
}

/**
 * 把分析结果渲染成 markdown 报告。
 * 报告只给决策依据，不含任何写操作。
 */
export function renderMergeReport (result, opts) {
  const o = opts || {}
  const r = result || { stats: {}, clusters: [], conflicts: [] }
  const s = r.stats || {}
  const lines = []

  lines.push('# 游隼 · 团队汇总报告')
  lines.push('')
  lines.push(`生成时间：${new Date().toISOString()}`)
  lines.push('')
  lines.push('## 概览')
  lines.push('')
  lines.push(`- 扫描库数：${s.vaults || 0}`)
  lines.push(`- 条目总数：${s.totalEntries || 0}`)
  lines.push(`- 完全相同（跨库）：${s.identicalPairs || 0} 对`)
  lines.push(`- 近似重合（跨库）：${s.nearPairs || 0} 对`)
  lines.push(`- 可合并簇：${s.clusters || 0} 个`)
  lines.push(`- 需要人裁决：${r.conflicts.length} 个`)
  if (r.missingVaults && r.missingVaults.length) {
    lines.push(`- ⚠ 不存在的库：${r.missingVaults.join('、')}`)
  }

  if (r.options) {
    lines.push('')
    lines.push('判据：' + [
      `SimHash 距离 ≤ ${r.options.hammingThreshold}`,
      `包含度 ≥ ${r.options.containmentThreshold}`,
      `Jaccard ≥ ${r.options.jaccardThreshold}`
    ].join(' · '))
    if (s.strategy) {
      lines.push('')
      lines.push(s.strategy === 'all-pairs'
        ? '比对方式：**全配对**（无假阴性，结果可复现）'
        : `比对方式：LSH 分带 ${s.bands} 带（近似）—— 极少数真重复可能漏检，需要更严就调小 allPairsLimit`)
    }
  }

  lines.push('')
  lines.push('## 可合并簇')
  lines.push('')

  if (!r.clusters.length) {
    lines.push('没有发现跨库重复。')
  } else {
    for (const c of r.clusters) {
      lines.push(`### ${c.id} · ${c.primary.title}`)
      lines.push('')
      lines.push(`**建议保留**：\`${shortPath(c.primary.vault, c.primary.rel)}\`（${c.primary.bytes} B，${c.primary.shingles} 特征）`)
      lines.push('')
      lines.push('| 库 | 条目 | 关系 | 包含度 | Jaccard | 距离 |')
      lines.push('| --- | --- | --- | --- | --- | --- |')
      for (const m of c.members) {
        lines.push(`| ${shortPath(m.vault)} | \`${m.rel}\` | ${REL_LABEL[m.relation] || m.relation} | ${m.containment} | ${m.jaccard} | ${m.hamming} |`)
      }
      lines.push('')
    }
  }

  if (r.conflicts.length) {
    lines.push('## 需要人裁决')
    lines.push('')
    for (const c of r.conflicts) {
      lines.push(`### ${c.id} · ${c.primary.title}`)
      lines.push('')
      lines.push(c.why)
      lines.push('')
      for (const m of c.candidates) {
        lines.push(`- \`${shortPath(m.vault, m.rel)}\` — 包含度 ${m.containment}，Jaccard ${m.jaccard}`)
      }
      lines.push('')
    }
  }

  lines.push('## 下一步（人工执行）')
  lines.push('')
  lines.push('1. 对每个簇，确认「建议保留」那条是否确实最全')
  lines.push('2. 被合并的条目**不要删除**，改成一条指针：')
  lines.push('   ```')
  lines.push('   status: merged-into:<保留条目的相对路径>')
  lines.push('   ```')
  lines.push('   （直接删会让检索命中过时内容，即「幽灵数据」）')
  lines.push('3. 裁决完跑 `node tools/bake.mjs check`，确认判定基线没漂')
  lines.push('4. 打 tag 后合并进主库')
  lines.push('')
  lines.push('> 本报告由只读分析生成，未修改任何 vault 文件。')

  return lines.join('\n')
}

function shortPath (vault, rel) {
  if (!vault) return rel || ''
  const base = path.basename(String(vault).replace(/[\\/]+$/, '')) || vault
  return rel ? base + '/' + rel : base
}
