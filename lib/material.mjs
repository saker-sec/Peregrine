/**
 * 游隼 · 材料检索（anysearch MCP）
 *
 * 手册 §6.1：材料从四类来源来 —— CTF 非预期解、顶会演讲、高质量漏洞报告、深度技术博客。
 * 这个模块负责「把外面的材料抓回来喂给筛关」，本身不做判断，只负责取。
 *
 * 为什么要单独一层：
 *   - 检索词构造有纪律（§6.2 纪律 2 反过来用：搜索词要具体，不要写 security）
 *   - 抓回来的东西必须带出处，否则没法回填 references
 *   - 抓取量有上限，不然一次拉回几十篇，筛不过来
 *
 * 真正的搜索调用由宿主注入（anysearch MCP 是 tools 层的），
 * 所以这里只产出「该搜什么」和「抓回来怎么整理」，保持纯函数，可测。
 */

/** 手册 §6.1 四类来源 */
export const SOURCE_KINDS = {
  ctf: { label: 'CTF 非预期解', hint: '重点看精妙的绕过技巧' },
  conference: { label: '顶会演讲', hint: 'BlackHat / DefCon / USENIX，看防御机制绕过与跨组件攻击链' },
  advisory: { label: '高质量漏洞报告', hint: 'Project Zero / PortSwigger，挑最优雅通用的那条路' },
  blog: { label: '深度技术博客', hint: '有没有给出具体步骤和明确的边界条件' }
}

/**
 * 构造检索计划。
 *
 * 手册 §6.2 纪律 2 的反面：描述不写空泛词。
 * 所以拼搜索词时也用具体词：技术点 + 具体组件/协议名，而不是 "security research"。
 *
 * @param {{ topic: string, components?: string[], technique?: string, kinds?: string[] }} spec
 * @returns {{ queries: {q: string, kind: string}[], notes: string[] }}
 */
export function buildSearchPlan (spec) {
  const s = spec || {}
  const topic = String(s.topic || '').trim()
  const notes = []
  const queries = []

  if (!topic) {
    return { queries: [], notes: ['缺少 topic，无法构造检索词'] }
  }

  const kinds = Array.isArray(s.kinds) && s.kinds.length ? s.kinds : Object.keys(SOURCE_KINDS)
  const comps = Array.isArray(s.components) ? s.components.filter(Boolean) : []
  const technique = String(s.technique || '').trim()

  // 具体性检查：太泛的 topic 提醒用户补细节
  const generic = ['安全', '漏洞', '渗透', 'security', 'vulnerability', 'hacking']
  if (topic.length < 4 || generic.includes(topic.toLowerCase())) {
    notes.push('topic 过于宽泛，建议补上具体技术点（例如「分号路径穿越」「HTTP/2 请求走私」）')
  }

  for (const kind of kinds) {
    if (!SOURCE_KINDS[kind]) continue
    let q = ''
    switch (kind) {
      case 'ctf':
        q = `${topic} CTF writeup unexpected bypass`
        break
      case 'conference':
        q = `${topic} BlackHat DefCon USENIX presentation`
        break
      case 'advisory':
        q = `${topic} Project Zero PortSwigger research advisory`
        break
      case 'blog':
        q = `${topic} technical deep dive repro steps`
        break
    }
    if (technique) q += ` ${technique}`
    if (comps.length) q += ` ${comps.join(' ')}`
    queries.push({ q: q.replace(/\s+/g, ' ').trim(), kind })
  }

  if (comps.length === 0) {
    notes.push('没给 components：补上具体组件/协议名（如 nginx、Tomcat、Spring Security）能让检索更准')
  }

  return { queries, notes }
}

/**
 * 把检索结果整理成「候选材料」。
 * 只保留有出处、有实质内容的条目 —— §6.1：没给步骤和边界的，价值低。
 *
 * @param {Array} hits 形如 [{ title, url, snippet, kind }]
 * @returns {{ items: Array, dropped: number }}
 */
export function normalizeHits (hits) {
  const list = Array.isArray(hits) ? hits : []
  const seen = new Set()
  const items = []
  let dropped = 0

  for (const h of list) {
    const url = String((h && h.url) || '').trim()
    const title = String((h && (h.title || h.name)) || '').trim()
    const snippet = String((h && (h.snippet || h.description || h.content)) || '').trim()

    // 没出处 → 丢掉（无法回填 references）
    if (!url) { dropped++; continue }
    // 去重
    if (seen.has(url)) { dropped++; continue }
    seen.add(url)

    // §6.1：没给步骤和边界的，价值低 —— 只有标题没正文的标记出来
    const substance = snippet.length >= 40
    items.push({
      title: title || url,
      url,
      snippet: snippet.slice(0, 600),
      kind: (h && h.kind) || 'unknown',
      substance,
      note: substance ? '' : '内容过少，需打开原文确认有没有步骤和边界条件'
    })
  }

  return { items, dropped }
}

/**
 * 材料入库前的形状校验（喂给 gates.scoreMaterial 之前）。
 * 缺哪个维度就明确说缺哪个，别让它 0 分混过去。
 */
export function toScoreInput (item) {
  const it = item || {}
  return {
    unexpectedness: Number(it.unexpectedness) || 0,
    elegance: Number(it.elegance) || 0,
    chain: Number(it.chain) || 0,
    reproducibility: Number(it.reproducibility) || 0
  }
}
