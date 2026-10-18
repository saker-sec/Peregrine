/**
 * 游隼 · anysearch 直连（自带 key 管理）
 *
 * 为什么插件自己管 key，而不是改宿主 MCP 的配置：
 *   1. 宿主 MCP 行的 key 写死在 cordis.patch.yml 里，改一次要重启 DSH
 *   2. 团队里每人该用自己的 key，不能把某个人的 key 同步给别人
 *   3. 游隼模式需要「只在这个模式下用这个 key」，而 MCP 是宿主层、全局共享
 *
 * 做法：
 *   - key 存在 <DSH_HOME>\plugins\peregrine\anysearch.json
 *   - 每次调用时才读，**改完立即生效，不用重启**
 *   - 直接跟 anysearch 的 MCP 端点说 JSON-RPC（实测无需 session id）
 *
 * 安全约定：
 *   - key 只落本地文件，不进 git
 *   - 任何输出/日志里只出现掩码形式（as_sk_1234****abcd）
 */

import fs from 'node:fs'
import path from 'node:path'

export const DEFAULT_URL = 'https://api.anysearch.com/mcp'
export const DEFAULT_TIMEOUT_MS = 120000

/** 状态目录：与 status.json 同一个地方 */
function stateDir () {
  const home = process.env.DSH_HOME || ''
  if (!home) return null
  return path.join(home, 'plugins', 'peregrine')
}

export function configPath () {
  const dir = stateDir()
  return dir ? path.join(dir, 'anysearch.json') : null
}

/**
 * 读配置。读不到就返回空对象（不抛错 —— 让调用方自己决定怎么提示）。
 */
export function readConfig () {
  const p = configPath()
  if (!p) return { apiKey: '', url: DEFAULT_URL, source: 'no-dsh-home' }
  try {
    const raw = fs.readFileSync(p, 'utf8')
    const j = JSON.parse(raw)
    return {
      apiKey: typeof j.apiKey === 'string' ? j.apiKey : '',
      url: typeof j.url === 'string' && j.url ? j.url : DEFAULT_URL,
      updatedAt: j.updatedAt || null,
      source: 'file'
    }
  } catch {
    return { apiKey: '', url: DEFAULT_URL, source: 'missing' }
  }
}

/**
 * 写配置（原子写：先写临时文件再 rename，避免半截文件）。
 */
export function writeConfig ({ apiKey, url }) {
  const dir = stateDir()
  if (!dir) throw new Error('DSH_HOME 未设置，无法定位配置目录')
  fs.mkdirSync(dir, { recursive: true })
  const p = path.join(dir, 'anysearch.json')
  const payload = {
    apiKey: String(apiKey || '').trim(),
    url: String(url || DEFAULT_URL).trim() || DEFAULT_URL,
    updatedAt: new Date().toISOString()
  }
  const tmp = p + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8')
  fs.renameSync(tmp, p)
  return payload
}

/** 掩码：只露出前 10 位和后 4 位，中间打码 */
export function maskKey (key) {
  const k = String(key || '')
  if (!k) return '(未设置)'
  if (k.length <= 14) return k.slice(0, 4) + '****'
  return k.slice(0, 10) + '****' + k.slice(-4)
}

/**
 * 调 anysearch 的 MCP 端点。
 *
 * 实测事实（2026-10-17）：
 *   - POST JSON-RPC 到 https://api.anysearch.com/mcp
 *   - 需要 Accept: application/json, text/event-stream
 *   - 返回单条 JSON（不是 SSE），**不需要 mcp-session-id**
 *   - 不需要代理，直连可用
 */
export async function anysearchCall (method, params, opts) {
  const o = opts || {}
  const cfg = o.apiKey ? { apiKey: o.apiKey, url: o.url || DEFAULT_URL } : readConfig()

  if (!cfg.apiKey) {
    throw new Error(
      'anysearch 的 API key 还没设置。' +
      '用 peregrine_anysearch_key 工具设置（action=set），或直接写 ' +
      (configPath() || '<DSH_HOME>\\plugins\\peregrine\\anysearch.json')
    )
  }

  const timeoutMs = o.timeoutMs || DEFAULT_TIMEOUT_MS
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const res = await fetch(cfg.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: 'Bearer ' + cfg.apiKey,
        'X-Anysearch-Client': 'peregrine/0.1.0'
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: ac.signal
    })

    const text = await res.text()

    if (!res.ok) {
      // 401/403 通常是 key 无效
      const hint = res.status === 401 || res.status === 403
        ? '（key 无效或已过期，用 peregrine_anysearch_key 重新设置）'
        : ''
      throw new Error(`anysearch HTTP ${res.status}${hint}: ${text.slice(0, 300)}`)
    }

    let msg
    try { msg = JSON.parse(text) } catch {
      throw new Error('anysearch 返回的不是 JSON: ' + text.slice(0, 300))
    }
    if (msg.error) throw new Error('anysearch 报错: ' + JSON.stringify(msg.error).slice(0, 400))
    return msg.result
  } finally {
    clearTimeout(timer)
  }
}

/** 从 MCP 的 content 数组里抽纯文本 */
export function contentText (result) {
  const parts = (result && result.content) || []
  return parts.filter((p) => p && p.type === 'text').map((p) => p.text).join('\n\n')
}

/** 单条搜索 */
export async function search (query, opts) {
  const o = opts || {}
  const args = { query: String(query || '') }
  if (o.maxResults) args.max_results = o.maxResults
  if (o.domain) args.domain = o.domain
  if (o.subDomain) args.sub_domain = o.subDomain
  if (o.subDomainParams) args.sub_domain_params = o.subDomainParams
  const r = await anysearchCall('tools/call', { name: 'search', arguments: args }, o)
  return { text: contentText(r), raw: r }
}

/** 批量搜索（最多 5 条） */
export async function batchSearch (queries, opts) {
  const list = (Array.isArray(queries) ? queries : [queries])
    .map((q) => (typeof q === 'string' ? { query: q } : q))
    .filter((q) => q && q.query)
    .slice(0, 5)
  const r = await anysearchCall('tools/call', { name: 'batch_search', arguments: { queries: list } }, opts)
  return { text: contentText(r), raw: r }
}

/** 抓取指定 URL 的正文 */
export async function extract (url, opts) {
  const r = await anysearchCall('tools/call', { name: 'extract', arguments: { url: String(url || '') } }, opts)
  return { text: contentText(r), raw: r }
}

/** 列可用工具（自检用：确认 key 有效 + 服务可达） */
export async function listTools (opts) {
  const r = await anysearchCall('tools/list', {}, opts)
  return (r && r.tools) || []
}

/**
 * 自检：返回是否可用 + 不可用的原因。
 * 给 peregrine_anysearch_key 的 status 动作用。
 */
export async function health (opts) {
  const cfg = readConfig()
  if (!cfg.apiKey) {
    return { ok: false, reason: 'no-key', message: '未设置 API key', configPath: configPath() }
  }
  try {
    const tools = await listTools({ ...opts, apiKey: cfg.apiKey, url: cfg.url })
    return {
      ok: true,
      toolCount: tools.length,
      tools: tools.map((t) => t.name),
      maskedKey: maskKey(cfg.apiKey),
      url: cfg.url
    }
  } catch (e) {
    return { ok: false, reason: 'call-failed', message: e.message, maskedKey: maskKey(cfg.apiKey), url: cfg.url }
  }
}
