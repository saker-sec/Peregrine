/**
 * 游隼 · 元标准烧录
 *
 * 对齐猎隼那套的 bake 契约：把「元标准」（手册 + 评分卡）哈希成一个 tag。
 * 元标准变了 → tag 变 → 提醒需要重新确认判定基线。
 *
 * 用法：
 *   node tools/bake.mjs bake    重新计算并写入 peregrine-bake.json
 *   node tools/bake.mjs check   对比盘上文件与契约，报告是否漂移
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.dirname(HERE)

const CONTRACT = path.join(ROOT, 'peregrine-bake.json')

/**
 * T1 固定前缀的体积预算（字节）。
 *
 * 为什么要卡：前缀每轮都在上下文里，占的是"留给干活的空间"。
 * 手册 §1 原话「AI 一次能看见的内容有上限……手册越短，留给干活的空间越多」，
 * 某批 Skill 瘦身后平均分从 76.5% 涨到 82.6% 同时 token 降了 1252。
 * 超预算不报错但必须显式警告 —— 让它成为一个有意识的选择，不是慢慢膨胀。
 */
const BURNED_BUDGET_BYTES = 6144

/** 元标准源：变了就说明"判定基线"变了 */
function metaSources () {
  const list = [
    // T1：真正烧进 systemPrompt 的固定前缀（每轮都读）
    { id: 'burned', label: 'T1 烧录前缀', file: path.join(ROOT, 'prompt', 'burned.md'), budget: BURNED_BUDGET_BYTES },
    // T2：按需读取的完整评分卡（不每轮读）
    { id: 'rubric', label: 'T2 完整评分卡', file: path.join(ROOT, 'prompt', 'rubric.md') },
    { id: 'gates', label: '四关实现', file: path.join(ROOT, 'lib', 'gates.mjs') },
    // 查重与索引算法也是判定基线：改了阈值或特征提取，"什么算重复"就变了
    { id: 'dedup', label: '查重算法', file: path.join(ROOT, 'lib', 'simhash.mjs') },
    { id: 'catalog', label: '索引算法', file: path.join(ROOT, 'lib', 'catalog.mjs') }
  ]
  // 手册本体：若配置了路径也纳入
  const handbook = process.env.PEREGRINE_HANDBOOK
    || process.env.SAKER_HANDBOOK || ''
  list.push({ id: 'handbook', label: '蒸馏手册', file: handbook, optional: true })
  return list
}

function sha256File (file) {
  try {
    const buf = fs.readFileSync(file)
    return { sha256: crypto.createHash('sha256').update(buf).digest('hex'), bytes: buf.length }
  } catch (e) {
    return { sha256: null, bytes: 0, missing: true, error: e.code || e.message }
  }
}

function computeContract () {
  const sources = metaSources().map((s) => {
    const h = sha256File(s.file)
    return {
      id: s.id,
      label: s.label,
      path: s.file,
      optional: !!s.optional,
      ...(s.budget ? { budget: s.budget } : {}),
      ...h
    }
  })
  const present = sources.filter((s) => s.sha256)
  const tag = crypto
    .createHash('sha256')
    .update(present.map((s) => `${s.id}:${s.sha256}`).join('|'))
    .digest('hex')
    .slice(0, 8)

  // T1 前缀是每轮成本，单独算清楚
  const burned = sources.find((s) => s.id === 'burned')
  const prefix = burned
    ? {
        bytes: burned.bytes,
        budget: burned.budget,
        withinBudget: burned.bytes <= burned.budget,
        ratio: burned.budget ? Math.round((burned.bytes / burned.budget) * 100) : null
      }
    : null

  return {
    version: 2,
    tag: `peregrine-rubric-1@${tag}`,
    rubricVersion: 1,
    bakedAt: new Date().toISOString(),
    prefix,
    sources
  }
}

function loadContract () {
  try {
    return JSON.parse(fs.readFileSync(CONTRACT, 'utf8'))
  } catch {
    return null
  }
}

/** 打印 T1 前缀的体积情况；超预算给警告但不阻断 */
function reportPrefix (c) {
  if (!c.prefix) return
  const p = c.prefix
  const bar = p.withinBudget ? '✓' : '⚠'
  console.log(
    `  ${bar} T1 前缀 ${p.bytes} B / 预算 ${p.budget} B（${p.ratio}%）` +
    (p.withinBudget ? '' : '  ← 超预算，每轮都在多花 token，考虑把细节挪进 rubric.md')
  )
}

const cmd = process.argv[2] || 'check'

if (cmd === 'bake') {
  const c = computeContract()
  fs.writeFileSync(CONTRACT, JSON.stringify(c, null, 2) + '\n', 'utf8')
  console.log(`已烧录: ${c.tag}`)
  reportPrefix(c)
  console.log('')
  for (const s of c.sources) {
    const state = s.sha256 ? `${s.sha256.slice(0, 12)}… (${s.bytes} B)` : `(缺失${s.optional ? '，可选' : ''})`
    console.log(`  ${String(s.id).padEnd(9)} ${state.padEnd(28)} ${s.path}`)
  }
  process.exit(0)
}

// check
const old = loadContract()
if (!old) {
  console.log('NEEDS RE-DISTILL — 还没有契约，先跑 `node tools/bake.mjs bake`')
  process.exit(1)
}

const now = computeContract()
const drifted = []
for (const s of now.sources) {
  const prev = (old.sources || []).find((x) => x.id === s.id)
  if (!prev) { drifted.push(`${s.id}: 新增源`); continue }
  if (prev.sha256 !== s.sha256) {
    drifted.push(`${s.id}: sha 变了（${String(prev.sha256).slice(0, 10)}… → ${String(s.sha256).slice(0, 10)}…）`)
  }
}

// 前缀超预算：即使没漂移也要提醒
const overBudget = now.prefix && !now.prefix.withinBudget

if (drifted.length === 0) {
  if (overBudget) reportPrefix({ prefix: now.prefix })
  console.log(`PASS — 元标准未变（${old.tag}）`)
  process.exit(0)
}

console.log(`NEEDS RE-DISTILL — 元标准变了（旧 ${old.tag}，新 ${now.tag}）`)
for (const d of drifted) console.log(`  · ${d}`)
reportPrefix(now)
console.log('\n判定基线变了，请重新确认四关规则仍符合手册，然后跑 `node tools/bake.mjs bake`。')
process.exit(2)
