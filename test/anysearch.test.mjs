import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 每个测试用独立的 DSH_HOME，避免污染真实状态
function withHome (fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'peregrine-home-'))
  const prev = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    return fn(home)
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prev
  }
}

const mod = await import('../lib/anysearch.mjs')

// ---------------------------------------------------------------- key 管理

test('key：没设置时 readConfig 返回空，不抛错', () => {
  withHome(() => {
    const cfg = mod.readConfig()
    assert.equal(cfg.apiKey, '')
    assert.equal(cfg.url, mod.DEFAULT_URL)
    assert.equal(cfg.source, 'missing')
  })
})

test('key：writeConfig 后能读回来', () => {
  withHome(() => {
    mod.writeConfig({ apiKey: 'as_sk_abcdefgh12345', url: mod.DEFAULT_URL })
    const cfg = mod.readConfig()
    assert.equal(cfg.apiKey, 'as_sk_abcdefgh12345')
    assert.equal(cfg.source, 'file')
    assert.ok(cfg.updatedAt)
  })
})

test('key：配置文件落在 <DSH_HOME>/plugins/peregrine/anysearch.json', () => {
  withHome((home) => {
    mod.writeConfig({ apiKey: 'as_sk_abcdefgh12345' })
    const p = path.join(home, 'plugins', 'peregrine', 'anysearch.json')
    assert.ok(fs.existsSync(p), '应写到 ' + p)
    assert.equal(mod.configPath(), p)
  })
})

test('key：写入是原子的，不留 .tmp 残留', () => {
  withHome(() => {
    mod.writeConfig({ apiKey: 'as_sk_abcdefgh12345' })
    const dir = path.dirname(mod.configPath())
    const leftovers = fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'))
    assert.deepEqual(leftovers, [])
  })
})

test('key：掩码只露前 10 后 4', () => {
  // 合成的假 key，形状与真实一致；测试里不要出现真实凭据
  assert.equal(mod.maskKey('as_sk_0123456789abcdef0123456789abcdef'), 'as_sk_0123****cdef')
  assert.equal(mod.maskKey(''), '(未设置)')
  assert.equal(mod.maskKey('short'), 'shor****')
})

test('key：掩码不泄漏完整 key', () => {
  const real = 'as_sk_0123456789abcdef0123456789abcdef'
  const m = mod.maskKey(real)
  assert.ok(!m.includes(real))
  assert.ok(m.length < real.length)
})

// ---------------------------------------------------------------- 调用行为

test('调用：没有 key 时给出可执行的报错（指向工具与文件路径）', async () => {
  await withHome(async () => {
    await assert.rejects(
      () => mod.anysearchCall('tools/list', {}),
      (e) => {
        assert.match(e.message, /API key 还没设置/)
        assert.match(e.message, /peregrine_anysearch_key/)
        return true
      }
    )
  })
})

test('调用：发的是 JSON-RPC，带 Bearer 与 Accept', async () => {
  await withHome(async () => {
    mod.writeConfig({ apiKey: 'as_sk_abcdefgh12345' })
    let seen = null
    const origFetch = globalThis.fetch
    globalThis.fetch = async (url, init) => {
      seen = { url, init }
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'search' }] } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
    }
    try {
      const r = await mod.anysearchCall('tools/list', {})
      assert.equal(seen.url, mod.DEFAULT_URL)
      assert.equal(seen.init.method, 'POST')
      assert.equal(seen.init.headers.Authorization, 'Bearer as_sk_abcdefgh12345')
      assert.match(seen.init.headers.Accept, /application\/json/)
      const body = JSON.parse(seen.init.body)
      assert.equal(body.jsonrpc, '2.0')
      assert.equal(body.method, 'tools/list')
      assert.deepEqual(r, { tools: [{ name: 'search' }] })
    } finally {
      globalThis.fetch = origFetch
    }
  })
})

test('调用：401 时提示 key 无效', async () => {
  await withHome(async () => {
    mod.writeConfig({ apiKey: 'as_sk_badkey123456' })
    const origFetch = globalThis.fetch
    globalThis.fetch = async () => new Response('unauthorized', { status: 401 })
    try {
      await assert.rejects(() => mod.anysearchCall('tools/list', {}), /key 无效或已过期/)
    } finally {
      globalThis.fetch = origFetch
    }
  })
})

test('调用：JSON-RPC error 会被抛出', async () => {
  await withHome(async () => {
    mod.writeConfig({ apiKey: 'as_sk_abcdefgh12345' })
    const origFetch = globalThis.fetch
    globalThis.fetch = async () => new Response(
      JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'bad request' } }),
      { status: 200 }
    )
    try {
      await assert.rejects(() => mod.anysearchCall('tools/call', {}), /anysearch 报错/)
    } finally {
      globalThis.fetch = origFetch
    }
  })
})

test('调用：非 JSON 响应给出明确错误', async () => {
  await withHome(async () => {
    mod.writeConfig({ apiKey: 'as_sk_abcdefgh12345' })
    const origFetch = globalThis.fetch
    globalThis.fetch = async () => new Response('<html>502</html>', { status: 200 })
    try {
      await assert.rejects(() => mod.anysearchCall('tools/list', {}), /不是 JSON/)
    } finally {
      globalThis.fetch = origFetch
    }
  })
})

// ---------------------------------------------------------------- 三个动作

function mockOk (text) {
  return async () => new Response(
    JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text }] } }),
    { status: 200 }
  )
}

test('search：构造 tools/call 并取回文本', async () => {
  await withHome(async () => {
    mod.writeConfig({ apiKey: 'as_sk_abcdefgh12345' })
    const origFetch = globalThis.fetch
    let body = null
    globalThis.fetch = async (_u, init) => {
      body = JSON.parse(init.body)
      return new Response(JSON.stringify({
        jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: '结果正文' }] }
      }), { status: 200 })
    }
    try {
      const r = await mod.search('分号路径穿越', { maxResults: 3 })
      assert.equal(r.text, '结果正文')
      assert.equal(body.params.name, 'search')
      assert.equal(body.params.arguments.query, '分号路径穿越')
      assert.equal(body.params.arguments.max_results, 3)
    } finally {
      globalThis.fetch = origFetch
    }
  })
})

test('batchSearch：最多 5 条，字符串数组自动包成对象', async () => {
  await withHome(async () => {
    mod.writeConfig({ apiKey: 'as_sk_abcdefgh12345' })
    const origFetch = globalThis.fetch
    let body = null
    globalThis.fetch = async (_u, init) => {
      body = JSON.parse(init.body)
      return new Response(JSON.stringify({
        jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'ok' }] }
      }), { status: 200 })
    }
    try {
      await mod.batchSearch(['a', 'b', 'c', 'd', 'e', 'f', 'g'])
      assert.equal(body.params.name, 'batch_search')
      assert.equal(body.params.arguments.queries.length, 5, '应截到 5 条')
      assert.deepEqual(body.params.arguments.queries[0], { query: 'a' })
    } finally {
      globalThis.fetch = origFetch
    }
  })
})

test('extract：传 url', async () => {
  await withHome(async () => {
    mod.writeConfig({ apiKey: 'as_sk_abcdefgh12345' })
    const origFetch = globalThis.fetch
    let body = null
    globalThis.fetch = async (_u, init) => {
      body = JSON.parse(init.body)
      return new Response(JSON.stringify({
        jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: '正文' }] }
      }), { status: 200 })
    }
    try {
      const r = await mod.extract('https://example.com/x')
      assert.equal(r.text, '正文')
      assert.equal(body.params.arguments.url, 'https://example.com/x')
    } finally {
      globalThis.fetch = origFetch
    }
  })
})

test('health：没 key 时返回 no-key 而不是抛错', async () => {
  await withHome(async () => {
    const h = await mod.health({})
    assert.equal(h.ok, false)
    assert.equal(h.reason, 'no-key')
    assert.ok(h.configPath)
  })
})

test('health：key 可用时返回工具数', async () => {
  await withHome(async () => {
    mod.writeConfig({ apiKey: 'as_sk_abcdefgh12345' })
    const origFetch = globalThis.fetch
    globalThis.fetch = mockOk('')
    globalThis.fetch = async () => new Response(JSON.stringify({
      jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'search' }, { name: 'extract' }] }
    }), { status: 200 })
    try {
      const h = await mod.health({})
      assert.equal(h.ok, true)
      assert.equal(h.toolCount, 2)
      assert.deepEqual(h.tools, ['search', 'extract'])
      assert.ok(!h.maskedKey.includes('abcdefgh'))
    } finally {
      globalThis.fetch = origFetch
    }
  })
})

test('contentText：只取 text 类型，多个用空行连接', () => {
  const r = { content: [{ type: 'text', text: 'A' }, { type: 'image' }, { type: 'text', text: 'B' }] }
  assert.equal(mod.contentText(r), 'A\n\nB')
  assert.equal(mod.contentText(null), '')
})
