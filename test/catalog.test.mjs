import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildCatalog, renderCatalog, readEntry, searchEntries, summarizeMarkdown } from '../lib/catalog.mjs'

function makeVault () {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'peregrine-vault-'))
  fs.mkdirSync(path.join(root, 'memory'), { recursive: true })
  fs.mkdirSync(path.join(root, 'registry'), { recursive: true })

  fs.writeFileSync(path.join(root, 'memory', 'a.md'),
    '# 越权判断锚点\n\n凡是响应里同时出现对象 ID、归属字段、状态字段的接口，都要测跨租户读取。\n', 'utf8')
  fs.writeFileSync(path.join(root, 'memory', 'b.md'),
    '# 分号路径穿越\n\n触发：目标前面有反向代理且后端是 Java Servlet 容器时读这条。\n', 'utf8')
  fs.writeFileSync(path.join(root, 'registry', 'r.md'),
    '# 路由表\n\n按触发条件查表。\n', 'utf8')
  fs.writeFileSync(path.join(root, 'memory', 'big.md'),
    '# 大文件\n\n' + 'x'.repeat(50000), 'utf8')

  return root
}

test('目录：能列出各层的条目', () => {
  const root = makeVault()
  const cat = buildCatalog(root)
  assert.equal(cat.exists, true)
  const layers = cat.layers.map((l) => l.layer).sort()
  assert.deepEqual(layers, ['memory', 'registry'])
  assert.ok(cat.totalEntries >= 4)
})

test('目录：只给标题与摘要，不给全文（渐进披露的核心）', () => {
  const root = makeVault()
  const cat = buildCatalog(root)
  const a = cat.layers.find((l) => l.layer === 'memory').entries.find((e) => e.rel.endsWith('a.md'))
  assert.equal(a.title, '越权判断锚点')
  assert.ok(a.summary.includes('跨租户读取'))
  assert.ok(!('text' in a), '目录项不应携带正文')
  assert.ok(a.summary.length <= 241, '摘要要有上限')
})

test('目录：渲染成文本，不含整篇正文', () => {
  const root = makeVault()
  const text = renderCatalog(buildCatalog(root))
  assert.match(text, /记忆库目录/)
  assert.match(text, /越权判断锚点/)
  assert.ok(text.length < 4000, '目录文本必须短，实际 ' + text.length)
})

test('目录：maxEntries 生效，超出标记 truncated', () => {
  const root = makeVault()
  const cat = buildCatalog(root, { maxEntries: 2 })
  assert.equal(cat.totalEntries, 2)
  assert.equal(cat.truncated, true)
})

test('目录：vault 不存在时安全返回', () => {
  const cat = buildCatalog('Z:\\nope\\nope')
  assert.equal(cat.exists, false)
  assert.match(renderCatalog(cat), /不存在|不可读/)
})

test('按需读：能读单条正文', () => {
  const root = makeVault()
  const r = readEntry(root, 'memory/a.md')
  assert.equal(r.ok, true)
  assert.match(r.text, /跨租户读取/)
  assert.equal(r.truncated, false)
})

test('按需读：路径穿越必须被拒', () => {
  const root = makeVault()
  for (const bad of ['../etc/passwd', 'memory/../../x.md', '..\\..\\windows\\win.ini']) {
    const r = readEntry(root, bad)
    assert.equal(r.ok, false, '应拒绝: ' + bad)
  }
})

test('按需读：不存在的条目给出明确错误', () => {
  const root = makeVault()
  const r = readEntry(root, 'memory/none.md')
  assert.equal(r.ok, false)
  assert.match(r.error, /不存在/)
})

test('按需读：超大文件被截断并标记', () => {
  const root = makeVault()
  const r = readEntry(root, 'memory/big.md', { maxBytes: 1000 })
  assert.equal(r.ok, true)
  assert.equal(r.truncated, true)
  assert.ok(r.text.length <= 1000)
})

test('检索：按关键词定位到该读哪条', () => {
  const root = makeVault()
  const hits = searchEntries(root, '路径穿越')
  assert.ok(hits.length >= 1)
  assert.ok(hits[0].rel.includes('b.md'))
})

test('检索：标题命中加权更高', () => {
  const root = makeVault()
  const hits = searchEntries(root, '越权')
  assert.ok(hits.length >= 1)
  assert.equal(hits[0].rel, 'memory/a.md')
})

test('检索：空关键词返回空', () => {
  const root = makeVault()
  assert.deepEqual(searchEntries(root, '  '), [])
})

test('摘要：优先取 frontmatter 的 description', () => {
  const md = '---\nname: x\ndescription: >-\n  这是描述，应该优先被取到。\n---\n\n# 标题\n\n正文第一段。\n'
  const s = summarizeMarkdown(md)
  assert.equal(s.title, '标题')
  assert.match(s.summary, /描述/)
})

test('摘要：没有 frontmatter 时取第一段正文', () => {
  const s = summarizeMarkdown('# 标题\n\n这是第一段。\n\n第二段。')
  assert.equal(s.title, '标题')
  assert.match(s.summary, /第一段/)
})
