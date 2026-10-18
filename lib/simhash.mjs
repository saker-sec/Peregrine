/**
 * 游隼 · SimHash 去重
 *
 * 解决的问题：你担心「要提炼的网页和之前重复」。
 * 在写进记忆库之前，先拿它的指纹和库里已有条目比一遍，近似就直接挡下来。
 *
 * 为什么用 SimHash（而不是 MD5 或纯子串匹配）：
 *   - MD5 只能判「完全相同」，改一个字就漏
 *   - 子串匹配对改写、重排、换了措辞的同一份材料无效
 *   - SimHash 是 LSH 的一种，把文本降维成 64 位指纹，
 *     相似文本的指纹只在少量比特位不同，用海明距离就能判近似
 *   业界做法：海量长文本用 SimHash，短文本用 MinHash（Jaccard）。
 *   记忆库条目多是几百到几千字的长文本，所以选 SimHash。
 *
 * 参考：
 *   - SimHash 原始论文（Charikar 2002）与 Google 网页去重实践
 *   - 工程经验：海明距离 ≤ 3 视为近似重复（64 位指纹）
 */

import crypto from 'node:crypto'

const BITS = 64
/**
 * 海明距离阈值。
 *
 * 注意：业界常说的「≤3 判重复」是针对**几千特征**的长文档。
 * 记忆库条目往往只有几十个特征，改动一两个词就能让距离跳到 5~8，
 * 直接套 3 会大面积漏判。所以这里按特征数自适应：
 *   - 特征 ≥ 800（长文）：严格，阈值 3
 *   - 特征 <  800（短条目）：放宽到 8，仍然能把"同一主题改了措辞"和
 *     "完全无关"（实测距离 30+）区分开
 * 实测数据：同一段话改 4 个字 → 距离 7；完全无关主题 → 距离 35。
 */
export const DEFAULT_HAMMING_THRESHOLD = 3
export const SHORT_TEXT_THRESHOLD = 8
export const SHORT_TEXT_FEATURE_LIMIT = 800

/** 按特征数给出建议阈值 */
export function suggestThreshold (featureCount) {
  return featureCount >= SHORT_TEXT_FEATURE_LIMIT ? DEFAULT_HAMMING_THRESHOLD : SHORT_TEXT_THRESHOLD
}

/**
 * 提取特征词。
 *
 * 中文按字符 bigram（中文没有空格分词，bigram 是最省事又够用的近似分词），
 * 英文/数字按单词（小写归一），标点与空白丢弃。
 * 这样做的好处是不依赖任何分词库 —— 手册要求 T0 纯代码零依赖。
 */
export function extractFeatures (text) {
  const src = String(text == null ? '' : text)
    .replace(/```[\s\S]*?```/g, ' ')      // 代码块不参与指纹（不同文章抄同一段代码不该判重）
    .replace(/`[^`]*`/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ') // 图片不参与
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // 链接只留文字
    .toLowerCase()

  const feats = []

  // 英文/数字单词
  const words = src.match(/[a-z][a-z0-9_-]{1,}/g) || []
  for (const w of words) feats.push('w:' + w)

  // 中文 bigram
  const cjk = src.match(/[\u4e00-\u9fa5]+/g) || []
  for (const run of cjk) {
    if (run.length === 1) { feats.push('c:' + run); continue }
    for (let i = 0; i < run.length - 1; i++) feats.push('c:' + run.slice(i, i + 2))
  }

  return feats
}

/** 特征 → 64 位哈希（取 sha256 前 8 字节，稳定且分布均匀） */
function featureHash (feature) {
  const h = crypto.createHash('sha256').update(feature, 'utf8').digest()
  return h.readBigUInt64BE(0)
}

/**
 * 指纹计算的统一截断长度（字符数）。
 *
 * 这个常量很关键：**建索引和查重必须用同一个截断长度**，
 * 否则同一份材料会算出两个不同指纹（实测：入表按 8KB 字节截断，
 * 中文只有约 2700 字；查询传全文 8000 字 → 特征集不同 → 自己查不到自己）。
 *
 * 取 3000 字符：SimHash 的判别力在前两三千字已饱和，
 * 再长也不提升准确率，只增加耗时。
 */
export const FINGERPRINT_MAX_CHARS = 3000

/**
 * 计算 SimHash 指纹，返回 16 位十六进制字符串（64 bit）。
 *
 * 算法：每个特征哈希成 64 位，按位投票（1 则 +w，0 则 -w），
 * 最后每一位按票数正负取 1/0。
 *
 * 注意：内部会先按 FINGERPRINT_MAX_CHARS 截断，
 * 所以同一文件无论传全文还是传头部，只要开头一样，指纹就一样。
 */
export function simhash (text, opts) {
  const maxChars = (opts && opts.maxChars) || FINGERPRINT_MAX_CHARS
  const src = String(text == null ? '' : text).slice(0, maxChars)
  const maxFeats = (opts && opts.maxFeatures) || 4000
  const feats = extractFeatures(src).slice(0, maxFeats)
  if (feats.length === 0) return '0'.repeat(16)

  const votes = new Array(BITS).fill(0)
  for (const f of feats) {
    const hv = featureHash(f)
    for (let b = 0; b < BITS; b++) {
      // 从高位往低位取
      const bit = (hv >> BigInt(BITS - 1 - b)) & 1n
      votes[b] += bit === 1n ? 1 : -1
    }
  }

  let out = 0n
  for (let b = 0; b < BITS; b++) {
    out = (out << 1n) | (votes[b] > 0 ? 1n : 0n)
  }
  return out.toString(16).padStart(16, '0')
}

/**
 * 两个指纹的海明距离。
 * 用 BigInt 的按位异或 + popcount，避免 64 位在 JS number 里溢出的坑。
 */
export function hammingDistance (hexA, hexB) {
  const a = BigInt('0x' + String(hexA).padStart(16, '0'))
  const b = BigInt('0x' + String(hexB).padStart(16, '0'))
  let x = a ^ b
  let count = 0
  while (x > 0n) {
    x &= x - 1n // 消掉最低位的 1
    count++
  }
  return count
}

/** 判两条是否近似重复 */
export function isNearDuplicate (hexA, hexB, threshold) {
  const t = Number.isFinite(threshold) ? threshold : DEFAULT_HAMMING_THRESHOLD
  return hammingDistance(hexA, hexB) <= t
}

/**
 * 在已有条目里找近似重复。
 *
 * 阈值默认自适应：条目短就放宽（见 suggestThreshold），
 * 也可以由调用方显式指定 threshold 覆盖。
 *
 * @param {string} fingerprint 待入库条目的指纹
 * @param {Array<{id?:string, path?:string, fingerprint:string}>} existing
 * @param {{threshold?:number, limit?:number, text?:string}} opts
 *        text 传了就用它算自适应阈值；不传则按长文严格阈值
 * @returns {Array<{entry:object, distance:number}>} 按距离升序
 */
export function findNearDuplicates (fingerprint, existing, opts) {
  const o = opts || {}
  const threshold = o.threshold != null
    ? o.threshold
    : (o.text ? suggestThreshold(extractFeatures(o.text).length) : DEFAULT_HAMMING_THRESHOLD)
  const limit = o.limit || 5
  const hits = []

  for (const e of Array.isArray(existing) ? existing : []) {
    if (!e || !e.fingerprint) continue
    const d = hammingDistance(fingerprint, e.fingerprint)
    if (d <= threshold) hits.push({ entry: e, distance: d })
  }

  hits.sort((x, y) => x.distance - y.distance)
  return hits.slice(0, limit)
}

/**
 * 给记忆库做一份指纹表（供 findNearDuplicates 用）。
 * entries: [{ id, path, text }]
 */
export function buildFingerprintIndex (entries) {
  return (Array.isArray(entries) ? entries : []).map((e) => ({
    id: e.id || e.path || '',
    path: e.path || '',
    title: e.title || '',
    fingerprint: simhash(e.text || '')
  }))
}

// ================================================================
// 第二道判据：shingle 集合的 Jaccard / 包含度
// ================================================================
//
// 为什么 SimHash 不够：
//   实测同一份文档「少 500 字」→ 距离 10，「替换停用词」→ 距离 12~14，
//   「追加 300 字」→ 距离 27，全部超过阈值而漏判。
//   原因是 SimHash 按位投票，**内容位置一偏移，大批特征就错位**。
//
// 业界标准解法（也是搜索引擎查重的做法）：
//   把文档切成 shingle（连续 k 个词的窗口）得到集合，
//   再用 Jaccard（交集/并集）或包含度（交集/较小集合）衡量。
//   集合度量天然不受位置影响：插入、删除、调换顺序都只改变少数 shingle。
//
// 两者配合：
//   SimHash   先做便宜的全库粗筛（只比 64 位）
//   Shingle   对候选做精确判定（插入改写也能抓到）

/** shingle 窗口大小：中文按字符算，5 个字符足以承载一个语义片段 */
export const SHINGLE_K = 5

/** 包含度高于此值判为重复（新材料的 shingle 大部分已在库里） */
export const CONTAINMENT_THRESHOLD = 0.55

/** Jaccard 高于此值判为重复（两篇高度重合） */
export const JACCARD_THRESHOLD = 0.45

/** 归一化：去掉代码块、链接、多余空白，降低格式差异的干扰 */
function normalizeForShingle (text) {
  return String(text == null ? '' : text)
    .slice(0, FINGERPRINT_MAX_CHARS)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[\s\u3000]+/g, ' ')   // 空白归一，换行重排不再影响
    .toLowerCase()
    .trim()
}

/** 32 位字符串哈希（FNV-1a 变体，稳定、无需依赖） */
function hash32 (str) {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

/**
 * 把文本切成 shingle 集合。
 * 返回**已排序去重的 Uint32Array**，便于双指针求交集（比 Set 快且省内存）。
 */
export function shingleSet (text, k) {
  const win = k || SHINGLE_K
  const src = normalizeForShingle(text)
  if (src.length < win) {
    return src ? Uint32Array.from([hash32(src)]) : new Uint32Array(0)
  }

  const seen = new Set()
  for (let i = 0; i + win <= src.length; i++) {
    seen.add(hash32(src.slice(i, i + win)))
  }
  const arr = Uint32Array.from(seen)
  arr.sort()
  return arr
}

/** 双指针求交集大小（两个数组都必须已排序） */
function intersectCount (a, b) {
  let i = 0
  let j = 0
  let n = 0
  while (i < a.length && j < b.length) {
    const x = a[i]
    const y = b[j]
    if (x === y) { n++; i++; j++ } else if (x < y) i++
    else j++
  }
  return n
}

/** Jaccard 相似度 = |A∩B| / |A∪B| */
export function jaccard (a, b) {
  const sizeA = a.length
  const sizeB = b.length
  if (!sizeA && !sizeB) return 1
  if (!sizeA || !sizeB) return 0
  const inter = intersectCount(a, b)
  const union = sizeA + sizeB - inter
  return union === 0 ? 0 : inter / union
}

/**
 * 包含度 = |A∩B| / min(|A|,|B|)
 *
 * 这是「新材料是否已经在库里」的主指标：
 * 一篇 3000 字的报告被摘成 800 字后，Jaccard 会偏低（并集大），
 * 但包含度仍然很高（短的那份几乎全被长的那份覆盖）。
 */
export function containment (a, b) {
  const sizeA = a.length
  const sizeB = b.length
  if (!sizeA || !sizeB) return 0
  const inter = intersectCount(a, b)
  return inter / Math.min(sizeA, sizeB)
}

/**
 * 综合查重：先 SimHash 粗筛，再用 shingle 精确判定。
 *
 * @param {string} text 待入库材料
 * @param {Array<{id?:string,path?:string,title?:string,fingerprint:string,shingles?:Uint32Array}>} existing
 * @param {{hammingThreshold?:number, containmentThreshold?:number, jaccardThreshold?:number, limit?:number}} opts
 * @returns {{matches: Array, duplicate: boolean, checked: number}}
 */
export function detectDuplicate (text, existing, opts) {
  const o = opts || {}
  const list = Array.isArray(existing) ? existing : []
  const fp = simhash(text)
  const sh = shingleSet(text)
  const hammingTh = o.hammingThreshold != null ? o.hammingThreshold : suggestThreshold(extractFeatures(text).length)
  const contTh = o.containmentThreshold != null ? o.containmentThreshold : CONTAINMENT_THRESHOLD
  const jacTh = o.jaccardThreshold != null ? o.jaccardThreshold : JACCARD_THRESHOLD
  const limit = o.limit || 5

  const matches = []
  for (const e of list) {
    if (!e) continue
    const dist = e.fingerprint ? hammingDistance(fp, e.fingerprint) : 64

    // 没有 shingle 集合时只能靠 SimHash 判
    if (!e.shingles || !e.shingles.length) {
      if (dist <= hammingTh) {
        matches.push({ entry: e, distance: dist, jaccard: null, containment: null, reason: 'simhash' })
      }
      continue
    }

    const jac = jaccard(sh, e.shingles)
    const cont = containment(sh, e.shingles)

    // 任一指标过线即判重复：
    //   SimHash 近   → 几乎原文相同
    //   Jaccard 高    → 两篇高度重合
    //   包含度 高     → 新材料已被库里某条覆盖
    if (dist <= hammingTh || jac >= jacTh || cont >= contTh) {
      const reason = dist <= hammingTh ? 'simhash' : (jac >= jacTh ? 'jaccard' : 'containment')
      matches.push({ entry: e, distance: dist, jaccard: jac, containment: cont, reason })
    }
  }

  // 排序：先按"判定强度"排（包含度优先，因为最贴近"已记过"），再按距离
  matches.sort((a, b) => {
    const ca = a.containment == null ? 0 : a.containment
    const cb = b.containment == null ? 0 : b.containment
    if (Math.abs(ca - cb) > 0.001) return cb - ca
    return a.distance - b.distance
  })

  return {
    matches: matches.slice(0, limit),
    duplicate: matches.length > 0,
    checked: list.length
  }
}

/**
 * 建带 shingle 的完整索引（比对用）。
 * 比 buildFingerprintIndex 重，但判定准得多。
 */
export function buildDuplicateIndex (entries) {
  return (Array.isArray(entries) ? entries : []).map((e) => ({
    id: e.id || e.path || '',
    path: e.path || '',
    title: e.title || '',
    fingerprint: simhash(e.text || ''),
    shingles: shingleSet(e.text || '')
  }))
}
