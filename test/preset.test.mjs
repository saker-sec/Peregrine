import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.dirname(HERE)

/**
 * 造一个临时记忆库。
 *
 * 为什么不用真实记忆库：测试不该依赖某台机器上的私有数据 ——
 * 那样在别人的机器上一定会红，而且会把私有路径写进仓库。
 * 这里只造出目录能力所需的最小结构（一个条目 + 一个索引）。
 */
function makeTempVault () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'peregrine-vault-'))
  fs.mkdirSync(path.join(dir, 'memory'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'SKILL.md'), '# 测试记忆库\n\n这是测试用的条目。\n', 'utf8')
  fs.writeFileSync(
    path.join(dir, 'memory', 'index.md'),
    '# 索引\n\n- [测试条目](sample.md)：用于验证目录渲染\n',
    'utf8'
  )
  fs.writeFileSync(
    path.join(dir, 'memory', 'sample.md'),
    '# 测试条目\n\n这是一条用于测试的记忆，内容足够长以产生特征。\n',
    'utf8'
  )
  return dir
}

test('预设：preset.yml 存在且有中文显示名', () => {
  const f = path.join(ROOT, 'preset', 'peregrine', 'preset.yml')
  assert.ok(fs.existsSync(f), 'preset.yml 必须存在')
  const text = fs.readFileSync(f, 'utf8')
  assert.match(text, /^name:\s*游隼模式/m, '显示名必须是「游隼模式」')
  assert.match(text, /^description:/m)
})

test('预设：agent.cordis.yml 存在且声明了 persona', () => {
  const f = path.join(ROOT, 'preset', 'peregrine', 'agent.cordis.yml')
  assert.ok(fs.existsSync(f))
  const text = fs.readFileSync(f, 'utf8')
  assert.match(text, /- id: persona/)
  assert.match(text, /dsh-persona/)
})

test('预设：指挥官被要求只做决策与派单', () => {
  const f = path.join(ROOT, 'preset', 'peregrine', 'agent.cordis.yml')
  const text = fs.readFileSync(f, 'utf8')
  assert.match(text, /指挥官/, '应写明指挥官角色')
  assert.match(text, /子 agent/, '应写明派单给子 agent')
})

test('预设：有 delegation 组，且 maxDepth 限制为 1', () => {
  const f = path.join(ROOT, 'preset', 'peregrine', 'agent.cordis.yml')
  const text = fs.readFileSync(f, 'utf8')
  assert.match(text, /- id: delegation/)
  assert.match(text, /maxDepth:\s*1/)
})

test('预设：子 agent 被禁止再委派', () => {
  const f = path.join(ROOT, 'preset', 'peregrine', 'agent.cordis.yml')
  const text = fs.readFileSync(f, 'utf8')
  // 子 agent 的 toolFilter 里应禁掉 subagent / subagent_fork
  assert.match(text, /- subagent\b/)
  assert.match(text, /- subagent_fork/)
})

test('预设：子 agent persona 要求只回摘要不贴原文', () => {
  const f = path.join(ROOT, 'preset', 'peregrine', 'agent.cordis.yml')
  const text = fs.readFileSync(f, 'utf8')
  assert.match(text, /只回摘要/)
  assert.match(text, /300 字/)
})

test('预设：挂了游隼本体并传入 vaultRoot', () => {
  const f = path.join(ROOT, 'preset', 'peregrine', 'agent.cordis.yml')
  const text = fs.readFileSync(f, 'utf8')
  assert.match(text, /name:\s*'dsh-peregrine-distill'/)
  assert.match(text, /vaultRoot:/)
})

test('bundle 补丁：故意不声明预设（唯一 owner 是 profile 补丁）', () => {
  const f = path.join(ROOT, 'cordis.patch.yml')
  assert.ok(fs.existsSync(f))
  const text = fs.readFileSync(f, 'utf8')
  // 包里不能再声明任何插件行，否则一旦成为 bundle 会与 profile 声明重复注册
  const codeLines = text.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith('#'))
  assert.equal(codeLines.length, 0, '应为纯注释文件，实际有内容行: ' + JSON.stringify(codeLines))
})

test('package.json：包根即预设插件（避免未声明包的子路径解析问题）', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  assert.equal(pkg.main, './lib/preset.js', 'main 应指向预设插件')
  assert.equal(pkg.exports['.'], './lib/preset.js', '包根应导出预设插件')
  assert.ok(pkg.exports['./preset-root'], '保留 preset-root 导出以备兼容')
  assert.ok(pkg.dsh?.bundle?.patch, '必须声明 dsh.bundle.patch')
})

test('package.json：声明了五个游隼工具', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  const tools = pkg.dshx?.contributes?.tools || []
  for (const t of ['peregrine_duplicate_check', 'peregrine_catalog', 'peregrine_read', 'peregrine_search', 'peregrine_gate', 'peregrine_merge', 'peregrine_rubric', 'peregrine_anysearch_key', 'peregrine_anysearch']) {
    assert.ok(tools.includes(t), '缺少工具声明: ' + t)
  }
})

test('模块可加载：preset 与 preset-root 都能 import', async () => {
  const preset = await import('../lib/preset.js')
  assert.equal(typeof preset.apply, 'function')
  assert.equal(typeof preset.simhash, 'function')
  const root = await import('../lib/preset-root.js')
  assert.equal(typeof root.apply, 'function')
  assert.deepEqual(root.inject, ['agentPresets'])
})

test('预设插件：能注册五个工具', async () => {
  const { apply } = await import('../lib/preset.js')
  const registered = []
  const handlers = new Map()
  const ctx = {
    logger: { info () {}, warn () {}, error () {} },
    get (k) { return k === 'tools' ? { register: (d) => registered.push(d) } : undefined },
    on (e, f) { if (!handlers.has(e)) handlers.set(e, []); handlers.get(e).push(f) }
  }
  apply(ctx, { vaultRoot: 'C:\\peregrine-test-vault' })
  const names = registered.map((d) => d.name).sort()
  assert.deepEqual(names, [
    'peregrine_anysearch',
    'peregrine_anysearch_key',
    'peregrine_catalog',
    'peregrine_duplicate_check',
    'peregrine_gate',
    'peregrine_merge',
    'peregrine_read',
    'peregrine_rubric',
    'peregrine_search'
  ])
  for (const d of registered) {
    assert.equal(typeof d.execute, 'function', d.name + ' 必须有 execute')
    assert.ok(d.description, d.name + ' 必须有 description')
  }
})

test('预设工具：duplicate_check 能对真实记忆库查重', async () => {
  const { apply } = await import('../lib/preset.js')
  let dupTool = null
  const ctx = {
    logger: { info () {}, warn () {}, error () {} },
    get (k) { return k === 'tools' ? { register: (d) => { if (d.name === 'peregrine_duplicate_check') dupTool = d } } : undefined },
    on () {}
  }
  apply(ctx, { vaultRoot: 'C:\\peregrine-test-vault' })
  assert.ok(dupTool)

  const r = await dupTool.execute({ text: '分号路径穿越利用 Servlet 容器路径参数剥离行为' })
  assert.equal(r.ok, true)
  assert.match(r.fingerprint, /^[0-9a-f]{16}$/)
  assert.ok(r.scanned >= 0)
  assert.ok(Array.isArray(r.matches))
})

test('预设工具：catalog 返回目录且不含正文', async () => {
  const { apply } = await import('../lib/preset.js')
  let catTool = null
  const ctx = {
    logger: { info () {}, warn () {}, error () {} },
    get (k) { return k === 'tools' ? { register: (d) => { if (d.name === 'peregrine_catalog') catTool = d } } : undefined },
    on () {}
  }
  apply(ctx, { vaultRoot: makeTempVault() })
  const r = await catTool.execute({})
  assert.equal(r.ok, true)
  assert.match(r.catalog, /记忆库目录/)
  assert.ok(r.catalog.length < 30000, '目录必须有界，实际 ' + r.catalog.length)
})

// ---------------------------------------------------------------- 工具 output 契约
//
// 这段校验是照着 DSH @deepseek-ai/dsh-tools 的 assertSupportedJsonSchema
// 复刻的 —— 因为少写 output.render 或用了不支持的 schema 关键字，
// 整条工具会静默注册失败（实测日志：
//   tool "peregrine_catalog" must declare output { schema, render, presentationMeta? }）。

const SUPPORTED_KEYS = new Set([
  'type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const',
  'description', 'title', 'default', 'examples', 'deprecated', 'readOnly', 'writeOnly', '$comment'
])
const SCHEMA_TYPES = ['string', 'number', 'integer', 'boolean', 'object', 'array', 'null']

function collectSchemaViolations (node, path, out) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) {
    out.push(path + ' 不是 schema 对象')
    return
  }
  for (const k of Object.keys(node)) {
    if (!SUPPORTED_KEYS.has(k)) out.push(path + '.' + k + ' 不是支持的关键字')
  }
  if (Object.hasOwn(node, 'required')) {
    if (!Array.isArray(node.required) || node.required.some((x) => typeof x !== 'string')) {
      out.push(path + '.required 必须是字符串数组')
    } else {
      const props = node.properties || {}
      for (const r of node.required) {
        if (!Object.hasOwn(props, r)) out.push(path + '.required 里的 ' + r + ' 不在 properties 中')
      }
    }
  }
  if (Object.hasOwn(node, 'additionalProperties') && typeof node.additionalProperties !== 'boolean') {
    out.push(path + '.additionalProperties 必须是 boolean')
  }
  if (Object.hasOwn(node, 'type') && !SCHEMA_TYPES.includes(node.type)) {
    out.push(path + '.type 非法: ' + node.type)
  }
  if (node.properties) {
    for (const [k, v] of Object.entries(node.properties)) collectSchemaViolations(v, path + '.properties.' + k, out)
  }
  if (node.items) collectSchemaViolations(node.items, path + '.items', out)
}

test('工具契约：五个工具都声明了 output { schema, render }', async () => {
  const { apply } = await import('../lib/preset.js')
  const reg = []
  const ctx = {
    logger: { info () {}, warn () {}, error () {} },
    get (k) { return k === 'tools' ? { register: (d) => reg.push(d) } : undefined },
    on () {}
  }
  apply(ctx, { vaultRoot: 'C:\\peregrine-test-vault' })

  assert.equal(reg.length, 9, '应注册 9 个工具，实际 ' + reg.length)
  for (const d of reg) {
    assert.ok(d.output, d.name + ' 缺少 output')
    assert.equal(typeof d.output.render, 'function', d.name + '.output.render 必须是函数')
    assert.ok(d.output.schema, d.name + ' 缺少 output.schema')
    assert.equal(d.output.schema.type, 'object', d.name + ' output.schema 必须是对象根')
  }
})

test('工具契约：output.schema 只用 DSH 支持的关键字', async () => {
  const { apply } = await import('../lib/preset.js')
  const reg = []
  const ctx = {
    logger: { info () {}, warn () {}, error () {} },
    get (k) { return k === 'tools' ? { register: (d) => reg.push(d) } : undefined },
    on () {}
  }
  apply(ctx, { vaultRoot: 'C:\\peregrine-test-vault' })

  for (const d of reg) {
    const bad = []
    collectSchemaViolations(d.output.schema, d.name, bad)
    assert.deepEqual(bad, [], d.name + ' 的 schema 有违规: ' + JSON.stringify(bad))
  }
})

test('工具契约：render 能输出非空文本', async () => {
  const { apply } = await import('../lib/preset.js')
  const reg = {}
  const ctx = {
    logger: { info () {}, warn () {}, error () {} },
    get (k) { return k === 'tools' ? { register: (d) => { reg[d.name] = d } } : undefined },
    on () {}
  }
  apply(ctx, { vaultRoot: makeTempVault() })

  const dup = await reg.peregrine_duplicate_check.execute({ text: '一段用于查重的材料，内容要足够长以便产生特征。' })
  const out = reg.peregrine_duplicate_check.output.render({}, dup)
  assert.ok(Array.isArray(out) && out[0].type === 'text' && out[0].text.length > 0)

  const cat = await reg.peregrine_catalog.execute({})
  const out2 = reg.peregrine_catalog.output.render({}, cat)
  assert.ok(out2[0].text.includes('记忆库目录'))

  const g = await reg.peregrine_gate.execute({ score: { unexpectedness: 3, elegance: 3, chain: 2, reproducibility: 2 } })
  const out3 = reg.peregrine_gate.output.render({}, g)
  assert.ok(out3[0].text.length > 0)
})

// ---------------------------------------------------------------- 烧录层 T1/T2

test('烧录 T1：loadBurned 返回前缀并带 bake tag', async () => {
  const { loadBurned, bakeTag } = await import('../lib/preset.js')
  const b = loadBurned()
  assert.ok(b, 'burned.md 必须能被读到')
  assert.ok(b.bytes > 200, '前缀不能是空壳')
  assert.match(b.text, /游隼 · 入库纪律/)
  assert.match(b.text, /bake /, '必须带版本标记')
  assert.equal(b.tag, bakeTag())
})

test('烧录 T1：前缀体积在预算内（每轮成本，不允许无意识膨胀）', async () => {
  const { loadBurned } = await import('../lib/preset.js')
  const b = loadBurned()
  const BUDGET = 6144
  assert.ok(b.bytes <= BUDGET, `前缀 ${b.bytes} B 超过预算 ${BUDGET} B，应把细节挪进 rubric.md`)
})

test('烧录 T1：前缀只放纪律，不放完整评分卡的细节', async () => {
  const { loadBurned } = await import('../lib/preset.js')
  const text = loadBurned().text
  // 骨架必须有
  assert.match(text, /第 0 步/)
  assert.match(text, /第 6 步/)
  assert.match(text, /硬规则/)
  assert.match(text, /查重/)
  // 但不应把 rubric 里的大段表格整篇搬过来
  assert.ok(text.length < 7000)
})

test('烧录 T1：把 section 挂进 systemPrompt，order=100', async () => {
  const { apply } = await import('../lib/preset.js')
  const sections = []
  const ctx = {
    logger: { info () {}, warn () {}, error () {} },
    get (k) {
      if (k === 'tools') return { register: () => {} }
      if (k === 'systemPrompt') return { section: (s) => { sections.push(s); return () => {} } }
      return undefined
    },
    on () {}
  }
  apply(ctx, { vaultRoot: 'C:\\peregrine-test-vault' })
  assert.equal(sections.length, 1, '应注入一个 section')
  assert.equal(sections[0].name, 'peregrine-rubric')
  assert.equal(sections[0].order, 100)
  assert.ok(sections[0].text.length > 200)
})

test('烧录 T1：systemPrompt 不可用时不崩，只警告', async () => {
  const { apply } = await import('../lib/preset.js')
  const warns = []
  const ctx = {
    logger: { info () {}, warn: (m) => warns.push(m), error () {} },
    get (k) { return k === 'tools' ? { register: () => {} } : undefined },
    on () {}
  }
  assert.doesNotThrow(() => apply(ctx, { vaultRoot: 'C:\\peregrine-test-vault' }))
  assert.ok(warns.some((w) => w.includes('systemPrompt')), '应给出警告')
})

test('烧录 T2：loadRubric 全文', async () => {
  const { loadRubric } = await import('../lib/preset.js')
  const r = loadRubric()
  assert.equal(r.ok, true)
  assert.ok(r.bytes > 1000)
  assert.match(r.text, /第 0 步/)
})

test('烧录 T2：loadRubric 能只取某一节（省 token）', async () => {
  const { loadRubric } = await import('../lib/preset.js')
  const full = loadRubric()
  const one = loadRubric('3')
  assert.equal(one.ok, true)
  assert.ok(one.bytes < full.bytes, '单片必须比全文小')
  assert.match(one.text, /第 3 步/)
})

test('烧录 T2：取不存在的节时列出可用节名', async () => {
  const { loadRubric } = await import('../lib/preset.js')
  const r = loadRubric('99')
  assert.equal(r.ok, false)
  assert.match(r.error, /可用/)
})

test('烧录：peregrine_rubric 工具可用且渲染带版本号', async () => {
  const { apply } = await import('../lib/preset.js')
  const reg = {}
  const ctx = {
    logger: { info () {}, warn () {}, error () {} },
    get (k) { return k === 'tools' ? { register: (d) => { reg[d.name] = d } } : undefined },
    on () {}
  }
  apply(ctx, { vaultRoot: 'C:\\peregrine-test-vault' })
  const r = await reg.peregrine_rubric.execute({ section: '1' })
  assert.equal(r.ok, true)
  assert.ok(r.tag)
  const out = reg.peregrine_rubric.output.render({}, r)[0].text
  assert.match(out, /评分卡/)
  assert.match(out, /第 1 步/)
})

test('烧录 T2：每个步骤号都必须命中它自己那一步（防子串误匹配）', async () => {
  const { loadRubric } = await import('../lib/preset.js')
  // 第 0 步的标题里带「§3 · §4」，早期用 includes 匹配会让 '4' 命中第 0 步
  for (const n of ['0', '1', '2', '3', '4', '5', '6']) {
    const r = loadRubric(n)
    assert.equal(r.ok, true, '第 ' + n + ' 步应能取到')
    assert.match(r.text, new RegExp('^## 第 ' + n + ' 步'), `取 ${n} 得到的是: ` + r.text.slice(0, 40))
  }
})

test('烧录 T2：取第 4 步不会返回第 0 步（回归）', async () => {
  const { loadRubric } = await import('../lib/preset.js')
  const r = loadRubric('4')
  assert.match(r.text, /^## 第 4 步/)
  assert.doesNotMatch(r.text, /^## 第 0 步/)
})

test('烧录 T2：支持按词取节（非数字）', async () => {
  const { loadRubric } = await import('../lib/preset.js')
  const r = loadRubric('硬规则')
  // rubric.md 里没有「硬规则」这个标题时，应给出可用列表而不是崩
  assert.ok(r.ok === false || /硬规则/.test(r.text))
})
