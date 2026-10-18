import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildSearchPlan, normalizeHits, toScoreInput, SOURCE_KINDS } from '../lib/material.mjs'

test('检索计划：四类来源各出一条查询（§6.1）', () => {
  const p = buildSearchPlan({ topic: '分号路径穿越', components: ['Tomcat', 'Spring Security'] })
  assert.equal(p.queries.length, 4)
  const kinds = p.queries.map((q) => q.kind).sort()
  assert.deepEqual(kinds, ['advisory', 'blog', 'conference', 'ctf'])
})

test('检索计划：搜索词带上具体组件，不写空泛词（§6.2 纪律 2 反面）', () => {
  const p = buildSearchPlan({ topic: 'semicolon path traversal', components: ['Tomcat'] })
  for (const q of p.queries) {
    assert.match(q.q, /Tomcat/, '应包含组件名: ' + q.q)
    assert.doesNotMatch(q.q.toLowerCase(), /^security$|^hacking$/)
  }
})

test('检索计划：topic 过泛给出提示', () => {
  const p = buildSearchPlan({ topic: '安全' })
  assert.ok(p.notes.some((n) => n.includes('过于宽泛')))
})

test('检索计划：没给 components 会提示补细节', () => {
  const p = buildSearchPlan({ topic: 'HTTP 请求走私' })
  assert.ok(p.notes.some((n) => n.includes('components')))
})

test('检索计划：空 topic 不产出查询', () => {
  const p = buildSearchPlan({})
  assert.equal(p.queries.length, 0)
  assert.ok(p.notes.length > 0)
})

test('检索计划：可指定只搜某几类来源', () => {
  const p = buildSearchPlan({ topic: 'XSS 绕过', kinds: ['ctf'] })
  assert.equal(p.queries.length, 1)
  assert.equal(p.queries[0].kind, 'ctf')
})

test('结果整理：没有出处的条目被丢弃（无法回填 references）', () => {
  const r = normalizeHits([
    { title: 'a', url: '', snippet: 'x'.repeat(100) },
    { title: 'b', url: 'https://example.com/b', snippet: 'y'.repeat(100) }
  ])
  assert.equal(r.items.length, 1)
  assert.equal(r.dropped, 1)
})

test('结果整理：重复 url 去重', () => {
  const r = normalizeHits([
    { title: 'a', url: 'https://x/1', snippet: 'a'.repeat(50) },
    { title: 'a2', url: 'https://x/1', snippet: 'b'.repeat(50) }
  ])
  assert.equal(r.items.length, 1)
  assert.equal(r.dropped, 1)
})

test('结果整理：内容过少标记 substance=false（§6.1 没给步骤和边界价值低）', () => {
  const r = normalizeHits([{ title: 'a', url: 'https://x/1', snippet: 'short' }])
  assert.equal(r.items[0].substance, false)
  assert.match(r.items[0].note, /步骤和边界/)
})

test('结果整理：内容充足不标记', () => {
  const r = normalizeHits([{ title: 'a', url: 'https://x/1', snippet: 'z'.repeat(200) }])
  assert.equal(r.items[0].substance, true)
  assert.equal(r.items[0].note, '')
})

test('打分输入：缺省维度补 0', () => {
  const s = toScoreInput({ unexpectedness: 3 })
  assert.equal(s.unexpectedness, 3)
  assert.equal(s.elegance, 0)
  assert.equal(s.chain, 0)
  assert.equal(s.reproducibility, 0)
})

test('来源类型：四类都有标签和提示（§6.1）', () => {
  const keys = Object.keys(SOURCE_KINDS).sort()
  assert.deepEqual(keys, ['advisory', 'blog', 'conference', 'ctf'])
  for (const k of keys) {
    assert.ok(SOURCE_KINDS[k].label)
    assert.ok(SOURCE_KINDS[k].hint)
  }
})
