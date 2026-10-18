import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  scanVault, analyzeVaults, renderMergeReport, lshBands, MERGE_DEFAULTS
} from '../lib/merge.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.dirname(HERE)
const CLI = path.join(ROOT, 'tools', 'merge.mjs')

/** 造一个 vault，files: { 'memory/a.md': '内容' } */
function makeVault (name, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'peregrine-merge-' + name + '-'))
  const root = path.join(dir, 'vault')
  for (const [rel, text] of Object.entries(files || {})) {
    const full = path.join(root, rel)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, text, 'utf8')
  }
  fs.mkdirSync(root, { recursive: true })
  return root
}

const LONG_A = `# 越权判断锚点

凡是响应里同时出现对象 ID、归属字段、状态字段的接口，都要测跨租户读取。
判断方法：先取自己的对象，再把自己的对象 ID 换成别人的，看返回是否仍是完整数据。
如果返回 403 说明做了归属校验；如果返回 200 且数据是别人的，就是越权。
停止条件：不要批量遍历，只验证最小证明。

补充说明：这类接口常见于订单、地址、工单、发票等业务对象。
另外要注意响应里可能有 ownerId、tenantId、createBy 这类字段。`

const LONG_B = LONG_A // 完全相同

const LONG_A_SLIGHT = LONG_A + '\n\n额外一句：记录原始请求与响应。'

// 部分重合：共享一大段核心，各自挂了不同的尾巴。
// 这才会产生 overlap —— 包含度够高（都被对方大半覆盖）但没到 0.9，
// Jaccard 也过线，于是「像重复又像补充」，需要人裁决。
const SHARED_CORE = `# 分号路径穿越

反向代理在转发前会做路径归一化，而 Tomcat 在解析时会剥掉分号后的内容。
两者归一化顺序不同，就产生了绕过空间。
测试方法：构造 /public/..;/admin 这类路径，观察是否被代理放行。

关键是确认链路结构：前面有没有反向代理，后面是不是 Servlet 容器。
只有两个条件同时成立才值得继续。
结论要看变体与基线的响应差异，不要只看状态码。
如果变体与基线响应一致，说明剥掉分号之后确实落到了同一个处理入口。
如果变体返回 400，说明容器层已经拒绝，这条路走不通，应当立即停止。
最多试三个变体，不要批量扫描，也不要做任何写操作。`

const OVERLAP_1 = SHARED_CORE + `

补充：这条在 Spring Security 前置过滤的场景下也成立，
因为过滤器同样按原始 URI 做匹配，而路由在剥掉分号后才解析。`

const OVERLAP_2 = SHARED_CORE + `

反例：如果目标用的是 Nginx 的 merge_slashes 开启状态，
那么部分变体会在代理层就被归一化掉，此时应当转到别的思路。`

const UNRELATED = `# Kubernetes TLS 证书轮换

用 cert-manager 配置自动续期，注意 ingress 的 tls 段要引用 secret 名。
轮换窗口建议设在低峰期，并监控到期时间。`

// ---------------------------------------------------------------- 扫描

test('扫描：能读出条目与指纹', () => {
  const v = makeVault('scan', { 'memory/a.md': LONG_A, 'registry/r.md': UNRELATED })
  const s = scanVault(v)
  assert.equal(s.exists, true)
  assert.equal(s.entries.length, 2)
  for (const e of s.entries) {
    assert.match(e.fingerprint, /^[0-9a-f]{16}$/)
    assert.ok(e.shingles.length > 0)
    assert.match(e.contentHash, /^[0-9a-f]{64}$/)
  }
})

test('扫描：不存在的库安全返回', () => {
  const s = scanVault('Z:\\nope\\nope')
  assert.equal(s.exists, false)
  assert.equal(s.entries.length, 0)
})

test('扫描：跳过 .git 与超大文件', () => {
  const v = makeVault('skip', { 'a.md': LONG_A })
  fs.mkdirSync(path.join(v, '.git'), { recursive: true })
  fs.writeFileSync(path.join(v, '.git', 'x.md'), 'should be ignored', 'utf8')
  fs.writeFileSync(path.join(v, 'huge.md'), 'x'.repeat(600 * 1024), 'utf8')
  const s = scanVault(v)
  assert.equal(s.entries.length, 1)
  assert.equal(s.entries[0].rel, 'a.md')
})

// ---------------------------------------------------------------- LSH

test('LSH：同一指纹落进同样的桶', () => {
  const a = lshBands('68ede203f78862d6', 4)
  const b = lshBands('68ede203f78862d6', 4)
  assert.deepEqual(a, b)
  assert.equal(a.length, 4)
})

test('LSH：分带数可变', () => {
  assert.equal(lshBands('68ede203f78862d6', 2).length, 2)
  assert.equal(lshBands('68ede203f78862d6', 8).length, 8)
})

// ---------------------------------------------------------------- 分析

test('分析：跨库完全相同 → 一个簇，关系 identical', () => {
  const a = makeVault('id-a', { 'memory/x.md': LONG_A })
  const b = makeVault('id-b', { 'memory/x.md': LONG_B })
  const r = analyzeVaults([a, b])
  assert.equal(r.stats.clusters, 1)
  assert.equal(r.stats.identicalPairs, 1)
  const c = r.clusters[0]
  assert.equal(c.members.length, 1)
  assert.equal(c.members[0].relation, 'identical')
  assert.equal(c.vaults.length, 2)
})

test('分析：一方的条目被另一方包含 → 关系 contained', () => {
  const a = makeVault('cont-a', { 'memory/x.md': LONG_A_SLIGHT })
  const b = makeVault('cont-b', { 'memory/x.md': LONG_A })
  const r = analyzeVaults([a, b])
  assert.equal(r.stats.clusters, 1)
  assert.equal(r.clusters[0].members[0].relation, 'contained')
  // 主条应该是更长的那个（LONG_A_SLIGHT 多一段）
  assert.ok(r.clusters[0].primary.bytes > 0)
})

test('分析：同主题不同写法 → overlap 且进待裁决', () => {
  const a = makeVault('ov-a', { 'memory/semi.md': OVERLAP_1 })
  const b = makeVault('ov-b', { 'memory/semi.md': OVERLAP_2 })
  const r = analyzeVaults([a, b])
  assert.equal(r.stats.clusters, 1, '应聚成一簇')
  assert.equal(r.clusters[0].members[0].relation, 'overlap')
  assert.equal(r.conflicts.length, 1, '应进待裁决')
})

test('分析：无关条目不成簇', () => {
  const a = makeVault('un-a', { 'memory/k8s.md': UNRELATED })
  const b = makeVault('un-b', { 'memory/semi.md': OVERLAP_1 })
  const r = analyzeVaults([a, b])
  assert.equal(r.stats.clusters, 0)
  assert.equal(r.conflicts.length, 0)
})

test('分析：同库内重复不算跨库簇', () => {
  const a = makeVault('self', { 'memory/1.md': LONG_A, 'memory/2.md': LONG_B })
  const b = makeVault('other', { 'memory/k8s.md': UNRELATED })
  const r = analyzeVaults([a, b])
  assert.equal(r.stats.clusters, 0, '同库内的重复不该被报成跨库簇')
})

test('分析：三个库都写了同一条 → 簇里有 3 个 vault', () => {
  const a = makeVault('3a', { 'memory/x.md': LONG_A })
  const b = makeVault('3b', { 'memory/x.md': LONG_B })
  const c = makeVault('3c', { 'memory/x.md': LONG_A_SLIGHT })
  const r = analyzeVaults([a, b, c])
  assert.equal(r.stats.clusters, 1)
  assert.equal(r.clusters[0].vaults.length, 3)
  assert.equal(r.clusters[0].members.length, 2)
})

test('分析：缺库被记录下来而不是崩掉', () => {
  const a = makeVault('ok', { 'memory/x.md': LONG_A })
  const r = analyzeVaults([a, 'Z:\\nope\\nope'])
  assert.equal(r.stats.vaults, 1)
  assert.equal(r.missingVaults.length, 1)
})

test('分析：空输入不崩', () => {
  const r = analyzeVaults([])
  assert.equal(r.stats.clusters, 0)
  assert.deepEqual(r.clusters, [])
})

test('分析：阈值调高会减少命中', () => {
  const a = makeVault('t-a', { 'memory/semi.md': OVERLAP_1 })
  const b = makeVault('t-b', { 'memory/semi.md': OVERLAP_2 })
  const loose = analyzeVaults([a, b])
  const strict = analyzeVaults([a, b], { containmentThreshold: 0.99, jaccardThreshold: 0.99 })
  assert.ok(loose.stats.clusters >= strict.stats.clusters)
  assert.equal(strict.stats.clusters, 0)
})

// ---------------------------------------------------------------- 报告

test('报告：含概览、簇、人裁决与下一步', () => {
  const a = makeVault('r-a', { 'memory/x.md': LONG_A, 'memory/semi.md': OVERLAP_1 })
  const b = makeVault('r-b', { 'memory/x.md': LONG_B, 'memory/semi.md': OVERLAP_2 })
  const r = analyzeVaults([a, b])
  const md = renderMergeReport(r)

  assert.match(md, /# 游隼 · 团队汇总报告/)
  assert.match(md, /## 概览/)
  assert.match(md, /## 可合并簇/)
  assert.match(md, /## 需要人裁决/)
  assert.match(md, /## 下一步/)
  assert.match(md, /merged-into/, '必须提醒用指针而不是删除')
  assert.match(md, /未修改任何 vault 文件/, '必须声明只读')
})

test('报告：没有重复时给出明确说明', () => {
  const a = makeVault('n-a', { 'memory/k8s.md': UNRELATED })
  const b = makeVault('n-b', { 'memory/semi.md': OVERLAP_1 })
  const md = renderMergeReport(analyzeVaults([a, b]))
  assert.match(md, /没有发现跨库重复/)
})

test('报告：不泄漏完整绝对路径（只显示库名）', () => {
  const a = makeVault('p-a', { 'memory/x.md': LONG_A })
  const b = makeVault('p-b', { 'memory/x.md': LONG_B })
  const md = renderMergeReport(analyzeVaults([a, b]))
  assert.ok(!md.includes(os.tmpdir()) || !md.includes(a), '报告不应铺满绝对路径')
})

// ---------------------------------------------------------------- CLI

function runCli (args) {
  try {
    const out = execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8' })
    return { code: 0, out }
  } catch (e) {
    return { code: e.status, out: (e.stdout || '') + (e.stderr || '') }
  }
}

test('CLI：无重复时退出码 0', () => {
  const a = makeVault('cli-a', { 'memory/k8s.md': UNRELATED })
  const b = makeVault('cli-b', { 'memory/semi.md': OVERLAP_1 })
  const r = runCli(['--vaults', a + ',' + b])
  assert.equal(r.code, 0)
  assert.match(r.out, /团队汇总报告/)
})

test('CLI：有待裁决冲突时退出码 3', () => {
  const a = makeVault('cli-c', { 'memory/semi.md': OVERLAP_1 })
  const b = makeVault('cli-d', { 'memory/semi.md': OVERLAP_2 })
  const r = runCli(['--vaults', a + ',' + b])
  assert.equal(r.code, 3, r.out)
})

test('CLI：--json 输出可解析，且不含绝对路径之外的白噪声', () => {
  const a = makeVault('cli-e', { 'memory/x.md': LONG_A })
  const b = makeVault('cli-f', { 'memory/x.md': LONG_B })
  const r = runCli(['--vaults', a + ',' + b, '--json'])
  assert.equal(r.code, 0, r.out)
  const j = JSON.parse(r.out)
  assert.equal(j.stats.clusters, 1)
  assert.ok(Array.isArray(j.clusters))
})

test('CLI：--out 写文件', () => {
  const a = makeVault('cli-g', { 'memory/x.md': LONG_A })
  const b = makeVault('cli-h', { 'memory/x.md': LONG_B })
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'peregrine-out-')), 'report.md')
  const r = runCli(['--vaults', a + ',' + b, '--out', out])
  assert.equal(r.code, 0, r.out)
  const md = fs.readFileSync(out, 'utf8')
  assert.match(md, /团队汇总报告/)
})

test('CLI：没有参数时给出用法并退出 2', () => {
  const r = runCli([])
  assert.equal(r.code, 2)
  assert.match(r.out, /用法/)
})

test('CLI：--help 退出 0', () => {
  const r = runCli(['--help'])
  assert.equal(r.code, 0)
  assert.match(r.out, /只读/)
})

test('默认阈值：与 simhash 模块的取值一致', () => {
  assert.equal(MERGE_DEFAULTS.containmentThreshold, 0.55)
  assert.equal(MERGE_DEFAULTS.jaccardThreshold, 0.45)
})

// ---------------------------------------------------------------- 策略选择（回归）

test('策略：小数据集默认全配对（无假阴性）', () => {
  const a = makeVault('s-a', { 'memory/semi.md': OVERLAP_1 })
  const b = makeVault('s-b', { 'memory/semi.md': OVERLAP_2 })
  const r = analyzeVaults([a, b])
  assert.equal(r.stats.strategy, 'all-pairs')
  assert.equal(r.stats.bands, null)
  assert.equal(r.stats.clusters, 1, '全配对必须抓到这一对')
})

test('策略：强制 LSH 不崩，且可能漏检（这是它的代价，不是 bug）', () => {
  const a = makeVault('l-a', { 'memory/semi.md': OVERLAP_1 })
  const b = makeVault('l-b', { 'memory/semi.md': OVERLAP_2 })
  const r = analyzeVaults([a, b], { allPairsLimit: 0 })
  assert.equal(r.stats.strategy, 'lsh')
  assert.equal(r.stats.bands, MERGE_DEFAULTS.bands)
  // 不保证抓到 —— 但绝不能抛错
  assert.ok(r.stats.clusters >= 0)
})

test('策略：完全相同的副本即使走 LSH 也必然抓到（指纹一致→同桶）', () => {
  const a = makeVault('e-a', { 'memory/x.md': LONG_A })
  const b = makeVault('e-b', { 'memory/x.md': LONG_B })
  const r = analyzeVaults([a, b], { allPairsLimit: 0 })
  assert.equal(r.stats.clusters, 1, '精确相同靠 sha256 分组，不依赖 LSH')
})

test('策略：报告里标明用了哪种比对方式', () => {
  const a = makeVault('rp-a', { 'memory/x.md': LONG_A })
  const b = makeVault('rp-b', { 'memory/x.md': LONG_B })
  const md = renderMergeReport(analyzeVaults([a, b]))
  assert.match(md, /全配对/)
  assert.match(md, /无假阴性/)
})

test('LSH：默认 8 带，每带 2 个十六进制字符', () => {
  const bands = lshBands('68ede203f78862d6', 8)
  assert.equal(bands.length, 8)
  assert.ok(bands.every((b) => /^\d+:[0-9a-f]{2}$/.test(b)), JSON.stringify(bands))
})

test('LSH：带数超过 16 会被夹到 16，不会产生空桶', () => {
  const bands = lshBands('68ede203f78862d6', 99)
  assert.equal(bands.length, 16)
  assert.ok(bands.every((b) => b.split(':')[1].length === 1), '每带 1 个字符')
})
