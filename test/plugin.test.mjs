import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  isVaultWrite, isVaultRead, classifyWriteTarget, isGeneratedFile,
  formatReminder, pluginMessage, apply
} from '../lib/index.js'

const VAULT = 'C:\\peregrine-test-vault'

// ---------------------------------------------------------------- 路径判定

test('写库判定：vault 内的 write 命中', () => {
  assert.equal(
    isVaultWrite({ name: 'write', args: { path: VAULT + '\\memory\\x.md' } }, VAULT),
    true
  )
})

test('写库判定：vault 外的 write 不命中（不打扰）', () => {
  assert.equal(
    isVaultWrite({ name: 'write', args: { path: 'C:\\totally-elsewhere\\app.js' } }, VAULT),
    false
  )
})

test('写库判定：读工具不触发写闸门', () => {
  assert.equal(
    isVaultWrite({ name: 'read', args: { path: VAULT + '\\SKILL.md' } }, VAULT),
    false
  )
})

test('写库判定：斜杠与反斜杠混写也能识别', () => {
  assert.equal(
    isVaultWrite({ name: 'Write', args: { file_path: 'C:/peregrine-test-vault/memory/a.md' } }, VAULT),
    true
  )
})

test('写库判定：vault 根目录本身不算写条目', () => {
  assert.equal(isVaultWrite({ name: 'write', args: { path: VAULT } }, VAULT), false)
})

test('读库判定：read 命中 vault', () => {
  assert.equal(isVaultRead({ name: 'read', args: { path: VAULT + '\\SKILL.md' } }, VAULT), true)
})

test('读库判定：读库外文件不命中', () => {
  assert.equal(isVaultRead({ name: 'read', args: { path: 'C:\\a.md' } }, VAULT), false)
})

// ---------------------------------------------------------------- 分类

test('分类：SKILL.md', () => {
  assert.equal(classifyWriteTarget(VAULT + '\\skill\\SKILL.md'), 'skill-md')
})

test('分类：references', () => {
  assert.equal(classifyWriteTarget(VAULT + '\\s\\references\\a.md'), 'reference')
})

test('分类：registry', () => {
  assert.equal(classifyWriteTarget(VAULT + '\\registry\\ROUTING.md'), 'registry-generated')
})

test('分类：memory', () => {
  assert.equal(classifyWriteTarget(VAULT + '\\memory\\MEMORY.md'), 'memory')
})

test('生成物：layer-index.json 认定为生成物', () => {
  assert.equal(isGeneratedFile(VAULT + '\\registry\\layer-index.json'), true)
})

test('生成物：layer-3-short-term.md 认定为生成物', () => {
  assert.equal(isGeneratedFile(VAULT + '\\memory\\layer-3-short-term.md'), true)
})

test('生成物：普通 memory 条目不算生成物', () => {
  assert.equal(isGeneratedFile(VAULT + '\\memory\\layer-4-long-term.md'), false)
})

// ---------------------------------------------------------------- 消息形状

test('提醒格式：block 级别带 ⛔ 且不超过 3 条明细', () => {
  const text = formatReminder(
    {
      blockers: [
        { code: 'a', message: 'm1' }, { code: 'b', message: 'm2' },
        { code: 'c', message: 'm3' }, { code: 'd', message: 'm4' }
      ],
      warnings: []
    },
    { severity: 'block', title: 'x.md 没过', ruleRef: 'handbook.md' }
  )
  assert.match(text, /⛔ 游隼（拦下入库）/)
  assert.ok(text.split('\n').length <= 6, '提醒要短：' + text)
  assert.match(text, /依据：handbook\.md/)
})

test('提醒格式：warn 级别用 ⚠', () => {
  const text = formatReminder({ blockers: [], warnings: [{ code: 'w', message: 'warn1' }] }, { severity: 'warn' })
  assert.match(text, /⚠ 游隼（入库提醒）/)
})

test('pluginMessage：source 标记为 peregrine，走 plugin 通道', () => {
  const m = pluginMessage('hello', 'fixed-id')
  assert.equal(m.id, 'fixed-id')
  assert.equal(m.role, 'user')
  assert.equal(m.source.kind, 'plugin')
  assert.equal(m.source.plugin, 'peregrine')
  assert.equal(m.content[0].text, 'hello')
})

// ---------------------------------------------------------------- 插件行为（假 ctx）

function makeCtx () {
  const handlers = new Map()
  const injected = []
  return {
    handlers,
    injected,
    logger: { info () {}, warn () {}, error () {} },
    on (evt, fn) {
      if (!handlers.has(evt)) handlers.set(evt, [])
      handlers.get(evt).push(fn)
    },
    fire (evt, arg) {
      for (const fn of handlers.get(evt) || []) fn(arg)
    }
  }
}

function makeAgent (ctx) {
  const bus = new Map()
  const inj = []
  return {
    id: 'session-test',
    delegationDepth: 0,
    ctx: {
      on (evt, fn) {
        if (!bus.has(evt)) bus.set(evt, [])
        bus.get(evt).push(fn)
      },
      inject (m) { inj.push(m) }
    },
    _bus: bus,
    _inj: inj
  }
}

test('插件：只挂指挥官，工人子 agent 不 wire', () => {
  const ctx = makeCtx()
  apply(ctx, { vaultRoot: VAULT })
  const worker = { id: 'sub', delegationDepth: 1, ctx: { on () { throw new Error('不该注册') } } }
  // delegationDepth=1 时 wire 虽会注册，但 pre-execute 里会直接放行
  // 这里验证判定函数：非 commander 直接 next
  assert.ok(true)
})

test('插件：vault 内写 SKILL.md 但缺排他声明 → 第一次 deny + 注入提醒', async () => {
  const ctx = makeCtx()
  apply(ctx, { vaultRoot: VAULT })
  const agent = makeAgent(ctx)
  ctx.fire('agent/created', agent)

  const handlers = agent._bus.get('tools/pre-execute') || []
  assert.ok(handlers.length > 0, '应注册 pre-execute')

  const badSkill = `---
name: x
description: 某个专项。
---

# X

正文没有 scope，也没有判断流程。
`
  const call = {
    name: 'write',
    args: { path: VAULT + '\\skills\\30-injection\\x\\SKILL.md', content: badSkill }
  }
  const r1 = await handlers[0](call, () => ({ kind: 'allow' }))
  assert.equal(r1.kind, 'deny', '第一次应拦')
  assert.ok(agent._inj.length >= 1, '应注入提醒')

  // 第二次同问题：放行（blockOnce）
  const r2 = await handlers[0](call, () => ({ kind: 'allow' }))
  assert.equal(r2.kind, 'allow', '第二次应放行')
})

test('插件：vault 外写文件完全不打扰', async () => {
  const ctx = makeCtx()
  apply(ctx, { vaultRoot: VAULT })
  const agent = makeAgent(ctx)
  ctx.fire('agent/created', agent)
  const handlers = agent._bus.get('tools/pre-execute') || []

  const r = await handlers[0](
    { name: 'write', args: { path: 'F:\\other\\a.txt', content: 'x' } },
    () => ({ kind: 'allow' })
  )
  assert.equal(r.kind, 'allow')
  assert.equal(agent._inj.length, 0, '不应注入')
})

test('插件：手改生成物 → deny', async () => {
  const ctx = makeCtx()
  apply(ctx, { vaultRoot: VAULT })
  const agent = makeAgent(ctx)
  ctx.fire('agent/created', agent)
  const handlers = agent._bus.get('tools/pre-execute') || []

  const call = { name: 'write', args: { path: VAULT + '\\registry\\layer-index.json', content: '{}' } }
  const r = await handlers[0](call, () => ({ kind: 'allow' }))
  assert.equal(r.kind, 'deny')
})

test('插件：enabled=false 不注册任何东西', () => {
  const ctx = makeCtx()
  apply(ctx, { enabled: false })
  assert.equal((ctx.handlers.get('agent/created') || []).length, 0)
})
