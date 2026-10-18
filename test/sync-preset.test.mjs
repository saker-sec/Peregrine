import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.dirname(HERE)
const SCRIPT = path.join(ROOT, 'tools', 'sync-preset.mjs')

/**
 * 造一个最小可用的补丁夹具。
 *
 * 形状必须是真实的：注释块紧挨着 `- id: preset-peregrine`，
 * 后面跟一条顶层行当结束标记。工具就是靠这两个锚点定位的。
 */
function makeFixture (eol = '\r\n') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'peregrine-sync-'))
  const patch = path.join(dir, 'cordis.patch.yml')
  const lines = [
    '- insert:',
    '    - id: mcp-playwright',
    "      name: '@deepseek-ai/dsh-mcp-client'",
    '    # -------------------------------------------------------------------------',
    '    # 游隼模式（Peregrine）—— 预设声明',
    '    # 旧内容',
    '    - id: preset-peregrine',
    "      name: '@deepseek-ai/dsh-agent-preset'",
    '      config:',
    '        id: peregrine',
    '        plugins:',
    '          - id: stale-row',
    '',
    '- id: ui-settings-general',
    '  name: "@deepseek-ai/dsh-client-ui-settings-general"',
    ''
  ]
  fs.writeFileSync(patch, lines.join(eol), 'utf8')
  return { dir, patch, eol }
}

function run (patch, args = []) {
  try {
    const out = execFileSync(process.execPath, [SCRIPT, ...args], {
      env: { ...process.env, PEREGRINE_PATCH: patch },
      encoding: 'utf8'
    })
    return { code: 0, out }
  } catch (e) {
    return { code: e.status, out: (e.stdout || '') + (e.stderr || '') }
  }
}

test('同步：第一次会把补丁里的旧块换成真源内容', () => {
  const { patch, eol } = makeFixture()
  const before = fs.readFileSync(patch, 'utf8')
  assert.match(before, /stale-row/)

  const r = run(patch)
  assert.equal(r.code, 0, r.out)

  const after = fs.readFileSync(patch, 'utf8')
  assert.ok(!after.includes('stale-row'), '旧行应被替换掉')
  assert.ok(after.includes('dsh-peregrine-distill'), '应写入真源里的插件行')
  assert.ok(after.includes('游隼模式'), '应保留标题')
  assert.ok(after.includes('- id: ui-settings-general'), '块后面的内容必须保留')
})

test('同步：第二次是幂等的（核心回归 —— 之前每次都会长一行）', () => {
  const { patch } = makeFixture()
  run(patch)
  const first = fs.readFileSync(patch, 'utf8')

  const r2 = run(patch)
  assert.equal(r2.code, 0, r2.out)
  assert.match(r2.out, /PASS/, '第二次应报 PASS')

  const second = fs.readFileSync(patch, 'utf8')
  assert.equal(first, second, '两次同步结果必须逐字节一致')

  // 再跑一次，防止偶发
  run(patch)
  const third = fs.readFileSync(patch, 'utf8')
  assert.equal(second, third)
})

test('同步：--check 在未同步时返回非 0，同步后返回 0', () => {
  const { patch } = makeFixture()

  const bad = run(patch, ['--check'])
  assert.notEqual(bad.code, 0, '未同步时应报错')
  assert.match(bad.out, /NEEDS SYNC/)

  run(patch)
  const good = run(patch, ['--check'])
  assert.equal(good.code, 0, good.out)
  assert.match(good.out, /PASS/)
})

test('同步：遵守文件既有换行符（CRLF 文件不会被写成混合换行）', () => {
  const { patch } = makeFixture('\r\n')
  run(patch)
  const buf = fs.readFileSync(patch)
  let crlf = 0
  let lf = 0
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0a) {
      if (i > 0 && buf[i - 1] === 0x0d) crlf++
      else lf++
    }
  }
  assert.equal(lf, 0, '不应出现裸 LF，实际 ' + lf + ' 个')
  assert.ok(crlf > 0)
})

test('同步：LF 文件保持 LF', () => {
  const { patch } = makeFixture('\n')
  run(patch)
  const text = fs.readFileSync(patch, 'utf8')
  assert.ok(!text.includes('\r'), '不应出现 CR')
})

test('同步：找不到锚点时明确报错而不是静默破坏文件', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'peregrine-sync-bad-'))
  const patch = path.join(dir, 'cordis.patch.yml')
  fs.writeFileSync(patch, '- insert:\n    - id: something\n', 'utf8')
  const r = run(patch)
  assert.notEqual(r.code, 0)
  assert.match(r.out, /找不到锚点行/)
  // 文件内容不能被改动
  assert.equal(fs.readFileSync(patch, 'utf8'), '- insert:\n    - id: something\n')
})

test('同步：写入前会留备份', () => {
  const { dir, patch } = makeFixture()
  run(patch)
  const baks = fs.readdirSync(dir).filter((f) => f.includes('.bak-before-sync-'))
  assert.ok(baks.length >= 1, '应生成备份文件')
})
