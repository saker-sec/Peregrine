import { test } from 'node:test'
import assert from 'node:assert/strict'
import { simhash, hammingDistance, isNearDuplicate, findNearDuplicates, extractFeatures, buildFingerprintIndex, suggestThreshold } from '../lib/simhash.mjs'
import { shingleSet, jaccard, containment, detectDuplicate, buildDuplicateIndex } from '../lib/simhash.mjs'

test('SimHash：同一材料传全文与传头部，指纹必须一致（建表/查重要对齐）', () => {
  const long = '越权判断锚点。凡是响应里同时出现对象 ID、归属字段、状态字段的接口，都要测跨租户读取。'.repeat(100)
  const head = long.slice(0, 3000)
  assert.equal(simhash(long), simhash(head), '长文与它的头部必须算出同一指纹')
})

test('SimHash：超过 3000 字符部分不参与指纹（性能取舍）', () => {
  const a = 'x'.repeat(3000) + '完全不同的一千个字'.repeat(50)
  const b = 'x'.repeat(3000) + '另一段也完全不同'.repeat(50)
  assert.equal(simhash(a), simhash(b), '截断之后的差异不应影响指纹')
})

test('SimHash：相同文本指纹完全一致', () => {
  const a = simhash('分号路径穿越利用了 Servlet 容器的路径参数剥离行为')
  const b = simhash('分号路径穿越利用了 Servlet 容器的路径参数剥离行为')
  assert.equal(a, b)
  assert.equal(hammingDistance(a, b), 0)
})

test('SimHash：指纹是 16 位十六进制（64 bit）', () => {
  const h = simhash('some text about path traversal')
  assert.match(h, /^[0-9a-f]{16}$/)
})

test('SimHash：轻微改动后仍判近似（核心能力）', () => {
  const a = '分号路径穿越利用了 Servlet 容器的路径参数剥离行为，可绕过前置反向代理的路径校验'
  const b = '分号路径穿越利用 Servlet 容器的路径参数剥离行为，可绕过前置反向代理的路径校验规则'
  const d = hammingDistance(simhash(a), simhash(b))
  const th = suggestThreshold(extractFeatures(a).length)
  assert.ok(d <= th, `轻微改动应判近似：距离 ${d}，阈值 ${th}`)
})

test('SimHash：完全不同主题应判为不相似', () => {
  const a = '分号路径穿越利用了 Servlet 容器路径参数剥离'
  const b = 'Kubernetes ingress controller TLS certificate rotation schedule'
  const d = hammingDistance(simhash(a), simhash(b))
  assert.ok(d > 8, `无关主题应远离，实际距离 ${d}`)
})

test('SimHash：阈值自适应 —— 长文严格、短文放宽', () => {
  assert.equal(suggestThreshold(2000), 3, '长文用严格阈值')
  assert.equal(suggestThreshold(50), 8, '短文放宽阈值')
})

test('SimHash：空文本返回全 0', () => {
  assert.equal(simhash(''), '0000000000000000')
})

test('SimHash：海明距离对称', () => {
  const a = simhash('alpha beta gamma')
  const b = simhash('alpha beta delta')
  assert.equal(hammingDistance(a, b), hammingDistance(b, a))
})

test('SimHash：isNearDuplicate 尊重自定义阈值', () => {
  const a = simhash('路径穿越 回显 任意 Origin')
  const b = simhash('路径穿越 回显 任意 Origin 测试')
  assert.equal(isNearDuplicate(a, b, 0), hammingDistance(a, b) === 0)
})

test('特征提取：代码块与图片不进指纹', () => {
  const t1 = '正文内容\n```\nconst x = 1\n```\n图片 ![a](b.png)'
  const t2 = '正文内容\n```\nconst y = 2\n```\n图片 ![c](d.png)'
  const f1 = extractFeatures(t1)
  const f2 = extractFeatures(t2)
  assert.deepEqual(f1.sort(), f2.sort(), '代码块与图片应被剔除，特征应相同')
})

test('特征提取：中文走 bigram，英文走 word', () => {
  const f = extractFeatures('越权IDOR attack')
  assert.ok(f.some((x) => x.startsWith('c:越权')))
  assert.ok(f.some((x) => x === 'w:idor'))
  assert.ok(f.some((x) => x === 'w:attack'))
})

test('查重：能在已有条目里找到近似项并按距离排序', () => {
  const targetText = '分号路径穿越利用 Servlet 容器路径参数剥离行为'
  const target = simhash(targetText)
  const existing = buildFingerprintIndex([
    { id: 'a', path: 'memory/a.md', text: 'Kubernetes ingress TLS 证书轮换' },
    { id: 'b', path: 'memory/b.md', text: '分号路径穿越利用 Servlet 容器路径参数剥离' },
    { id: 'c', path: 'memory/c.md', text: '分号路径穿越利用 Servlet 容器路径参数剥离行为' }
  ])
  const hits = findNearDuplicates(target, existing, { text: targetText })
  assert.ok(hits.length >= 2, '应找到至少两条近似，实际 ' + hits.length)
  assert.equal(hits[0].entry.id, 'c', '最相似的是完全相同那条')
  assert.ok(hits[0].distance <= hits[hits.length - 1].distance, '按距离升序')
  assert.ok(!hits.some((h) => h.entry.id === 'a'), '无关条目不应命中')
})

test('查重：阈值外的不返回', () => {
  const target = simhash('完全无关的主题 A')
  const existing = buildFingerprintIndex([{ id: 'z', path: 'z.md', text: '完全无关的主题 B' }])
  const hits = findNearDuplicates(target, existing, { threshold: 0 })
  for (const h of hits) assert.equal(h.distance, 0)
})

// ================================================================
// 第二道判据：shingle / Jaccard / 包含度
// ================================================================

const DOC = `# 记忆库分层
memory 目录存放跨目标的可复用结论，registry 存放生成的路由表与索引。
写入前必须过写入门：AI 已经会的一律不写，写判断流程不抄原理。
每条条目都要有明确的触发条件，否则以后没人知道什么时候该读它。
带斜体或代码块的格式差异不应影响判重，因为同一份材料经常被重新排版。
证据目录必须进 gitignore，原始请求与响应不允许提交到仓库。
排除掉的发现也要记录，否则下次还会重复测同一个没用的方向。`

test('shingle：集合不受换行与空白影响', () => {
  const a = shingleSet(DOC)
  const b = shingleSet(DOC.replace(/\n/g, '\n\n'))
  assert.equal(jaccard(a, b), 1, '换行重排应完全一致')
})

test('shingle：代码块与链接不参与', () => {
  const a = shingleSet(DOC)
  const b = shingleSet(DOC + '\n\n```\nconst x = 1\n```\n[链接](https://example.com)')
  assert.ok(jaccard(a, b) > 0.9, '追加代码块与链接不应显著改变集合')
})

test('包含度：截断后的文档应完全被原文覆盖', () => {
  const full = shingleSet(DOC)
  const half = shingleSet(DOC.slice(0, Math.floor(DOC.length / 2)))
  assert.equal(containment(full, half), 1, '短的那份应完全包含在长的里面')
  assert.ok(jaccard(full, half) < 0.9, '但 Jaccard 会因并集变大而降低')
})

test('包含度：无关文档接近 0', () => {
  const a = shingleSet(DOC)
  const b = shingleSet('Kubernetes ingress controller TLS certificate rotation for multi-cluster production.')
  assert.ok(containment(a, b) < 0.1)
  assert.ok(jaccard(a, b) < 0.1)
})

test('detectDuplicate：改写过的同一份材料能抓到（SimHash 会漏）', () => {
  const idx = buildDuplicateIndex([{ id: 'x', path: 'memory/x.md', text: DOC }])

  // 替换停用词 + 截断：SimHash 距离会超过阈值
  const rewritten = DOC.slice(0, 300).replace(/的/g, '之').replace(/必须/g, '务必')
  const d = hammingDistance(simhash(DOC), simhash(rewritten))
  assert.ok(d > 3, '前提：SimHash 判不出来（距离 ' + d + '）')

  const r = detectDuplicate(rewritten, idx)
  assert.equal(r.duplicate, true, 'shingle 判据应抓到')
  assert.equal(r.matches[0].entry.id, 'x')
  assert.ok(r.matches[0].containment > 0.55)
})

test('detectDuplicate：无关材料不误报', () => {
  const idx = buildDuplicateIndex([{ id: 'x', path: 'memory/x.md', text: DOC }])
  const r = detectDuplicate('Nginx 反向代理缓存配置与命中率监控实践指南', idx)
  assert.equal(r.duplicate, false)
  assert.equal(r.matches.length, 0)
})

test('detectDuplicate：完全相同应判重复且距离 0', () => {
  const idx = buildDuplicateIndex([{ id: 'x', path: 'memory/x.md', text: DOC }])
  const r = detectDuplicate(DOC, idx)
  assert.equal(r.duplicate, true)
  assert.equal(r.matches[0].distance, 0)
})

test('detectDuplicate：空库不抛错', () => {
  const r = detectDuplicate(DOC, [])
  assert.equal(r.duplicate, false)
  assert.equal(r.checked, 0)
})

test('detectDuplicate：无 shingle 的旧索引回退到 SimHash', () => {
  const idx = [{ id: 'old', path: 'old.md', fingerprint: simhash(DOC) }]
  const r = detectDuplicate(DOC, idx)
  assert.equal(r.duplicate, true)
  assert.equal(r.matches[0].reason, 'simhash')
})
