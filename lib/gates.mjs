/**
 * 游隼 · 入库四关（确定性检查，零 token）
 *
 * 唯一权威：<handbook>（由 SAKER_HANDBOOK 指定）
 * 本文件只做「把手册的规则变成可执行的判定」，不发明新规则。
 *
 * 四关对应手册第六章的五个步骤（筛→定→写→测，第五步「留」由人工决定）：
 *   筛 gate-screen   价值分够不够（§6.1，7 分线）
 *   定 gate-decide   该不该落盘、落成什么形态（§2 §4 §5）
 *   写 gate-write    写的内容是不是判断流程（§6.2 七条纪律）
 *   测 gate-test     有没有带/不带对照（§6.3）
 *
 * 每条检查都返回 { level, code, message, fix }：
 *   level = 'block'  → 必须改，否则不许入库
 *   level = 'warn'   → 提醒，可继续（写进 incident 供复盘）
 */

// ---------------------------------------------------------------- 常量

/** 手册 §6.1 第一轮打分四维，满分 10 */
export const SCORE_DIMENSIONS = {
  unexpectedness: 3, // 非预期性：原来还能这样
  elegance: 3,       // 绕过优雅度与通用性
  chain: 2,          // 攻击链完整性
  reproducibility: 2 // 可复现性
}

/** 手册 §6.1：总分 7 分以上保留 */
export const SCORE_THRESHOLD = 7

/** 手册 §5：编号分类目录，编号暗含加载优先级 */
export const LAYER_DIRS = {
  '00-routing': '路由层，最先看',
  '10-recon-js': '信息收集 / JS',
  '20-api-auth-logic': 'API、认证、业务逻辑',
  '30-injection': '注入类',
  '40-file-cloud-sensitive': '文件、云、敏感信息',
  '50-reverse-mobile-forensics': '逆向、移动端、取证',
  '60-internal-c2': '内网、后渗透',
  '70-reporting-content': '报告、内容产出',
  '90-optional-legacy': '历史遗留，最后才考虑'
}

/** 手册 §6.2 纪律 2：描述不写空泛词 */
export const VAGUE_WORDS = [
  'security', 'hacking', 'vulnerability testing', '安全测试', '漏洞检测',
  '渗透测试', '安全研究', '各类漏洞', '各种问题', '相关检查', '综合评估'
]

/** 手册 §5：排他声明只能写在 description 里 */
export const EXCLUSION_PATTERNS = [
  /不作为.{0,30}入口/,                 // 不作为……的入口 / 默认入口 / 主入口
  /不作为.{0,30}(默认|主路由|总控)/,
  /不因.{0,30}(就|而).{0,12}(抢占|触发)/,
  /普通.{0,14}不应.{0,12}(抢占|触发)/,
  /不应.{0,16}(抢占|触发).{0,10}入口/,
  /仅在.{0,60}(后|之后|才).{0,8}使用/,
  /不要用于/,
  /不用于/,
  /do not use (this|for)/i,
  /not for /i
]

/** 手册 §6.2 纪律 7：证据目录加进 .gitignore */
export const EVIDENCE_MARKERS = [
  'evidence/', 'evidence\\', '原始请求', '原始响应', '截图', 'screenshots/'
]

// ---------------------------------------------------------------- 工具

function norm (s) {
  return String(s == null ? '' : s)
}

/**
 * 解析 SKILL.md 的 frontmatter（只认头部 --- 块，不引入 yaml 依赖）
 */
export function parseFrontmatter (text) {
  const src = norm(text)
  const m = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(src)
  if (!m) return { ok: false, data: {}, body: src, raw: '' }
  const raw = m[1]
  const data = {}
  const lines = raw.split(/\r?\n/)
  let key = null
  let buf = []
  const flush = () => {
    if (key) data[key] = buf.join('\n').trim()
    buf = []
  }
  for (const line of lines) {
    const km = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line)
    if (km) {
      flush()
      key = km[1]
      let v = km[2]
      if (v === '>-' || v === '>' || v === '|' || v === '|-') v = ''
      buf.push(v)
    } else if (key && /^\s+/.test(line)) {
      buf.push(line.trim())
    } else if (line.trim() === '') {
      buf.push('')
    }
  }
  flush()
  return { ok: true, data, body: src.slice(m[0].length), raw }
}

// ---------------------------------------------------------------- 第一关：筛

/**
 * §6.1 第一轮打分。四个维度各自有上限，超限按上限算。
 * 返回 { total, breakdown, pass, reason }
 */
export function scoreMaterial (input) {
  const breakdown = {}
  let total = 0
  const problems = []

  for (const [key, max] of Object.entries(SCORE_DIMENSIONS)) {
    let v = Number(input && input[key])
    if (!Number.isFinite(v)) {
      problems.push(`缺少 ${key} 分值`)
      v = 0
    }
    if (v < 0) v = 0
    if (v > max) v = max
    breakdown[key] = v
    total += v
  }

  const pass = total >= SCORE_THRESHOLD
  return {
    total,
    breakdown,
    pass,
    missing: problems,
    reason: pass
      ? `价值分 ${total}/10，达到 ${SCORE_THRESHOLD} 分线（§6.1）`
      : `价值分 ${total}/10，低于 ${SCORE_THRESHOLD} 分线（§6.1），不值得写成 Skill`
  }
}

// ---------------------------------------------------------------- 第二关：定

/**
 * §4 什么时候写：AI 已经会的一律不写；不知道但低频→五段框架；不知道且高频→完整 Skill；
 * AI 知道但不会排序→写 Skill，重点在顺序。
 * 返回 { form: 'skill'|'five-part'|'none', reason }
 */
export function decideForm (input) {
  const knows = input && input.aiLikelyKnown
  const frequent = input && input.frequency
  const needsOrder = input && input.needsOrdering

  if (knows === true && needsOrder !== true) {
    return {
      form: 'none',
      reason: '§4：AI 已经会，且不需要排序纪律 → 不写。直接提问即可。'
    }
  }
  if (knows === true && needsOrder === true) {
    return {
      form: 'skill',
      reason: '§4 第三种情况：AI 知道，但不知道先做什么后做什么 → 写 Skill，重点写顺序和决策树。'
    }
  }
  if (knows === false && frequent === 'low') {
    return {
      form: 'five-part',
      reason: '§2/§4：AI 不知道，但一年碰不上几次 → 写五段框架，别占上下文，默认不落盘。'
    }
  }
  if (knows === false && (frequent === 'high' || frequent === 'medium')) {
    return {
      form: 'skill',
      reason: '§2/§4：AI 不知道，且经常用得上 → 写成完整 Skill。'
    }
  }
  return {
    form: 'none',
    reason: '§4：信息不足或 AI 已知 → 默认不写（手册的原则：AI 已经会的，一律不写）。'
  }
}

/** §5 蒸馏产物放哪 */
export function decideDestination (form, context) {
  const c = context || {}
  if (form === 'none') return { dest: 'nowhere', reason: '不落盘，下次直接在对话里用' }
  if (form === 'five-part') {
    if (c.belongsToExistingSkill) {
      return {
        dest: 'references',
        path: `${c.belongsToExistingSkill}/references/`,
        reason: '§5：属于某个已有 Skill 的领域 → 放它的 references，正文必须留一行指针'
      }
    }
    return { dest: 'inline', reason: '§5：不落盘，作为对话内的一段五段框架使用' }
  }
  if (c.everySession) {
    return { dest: 'agents-md', reason: '§5：要求每次会话都生效 → AGENTS.md，唯一无条件加载的位置' }
  }
  return {
    dest: 'skill-dir',
    path: `skill-bank/skills/${c.layerDir || '<编号分类>'}/${c.name || '<skill-name>'}/`,
    reason: '§5：正式 Skill，落到内容层编号分类目录'
  }
}

// ---------------------------------------------------------------- 第三关：写

/**
 * §6.2 七条纪律 + §6.4 description 四段式。
 * 传入一个 SKILL.md 的全文与元信息，返回 findings 数组。
 */
export function checkWriting (input) {
  const findings = []
  const text = norm(input && input.text)
  const fm = parseFrontmatter(text)
  const name = norm(input && input.name) || fm.data.name || ''
  const description = fm.data.description || ''

  const push = (level, code, message, fix) => findings.push({ level, code, message, fix })

  // 纪律 1：一个 Skill 只解决一个问题
  if (!fm.ok) {
    push('block', 'no-frontmatter', 'SKILL.md 缺少 frontmatter（需要 name 与 description）', '在文件头补 --- 块，description 按四段式写')
  }

  // description 四段式（§6.4）
  if (!description) {
    push('block', 'no-description', '缺少 description —— AI 决定用不用一个 skill 只看 description（§3）', '补 description：①身份 ②触发条件 ③排他声明 ④交接关系')
  } else {
    // ① 身份
    if (description.length < 12) {
      push('block', 'desc-too-short', 'description 太短，无法表达身份（§6.4 ①）', '用一句话说清这个 skill 是什么')
    }
    // ② 触发条件
    if (!/(仅在|当|如果|一旦|when |if )/.test(description)) {
      push('block', 'desc-no-trigger', 'description 没写触发条件（§6.4 ②）', '写明「仅在……时使用」，让 AI 知道什么时候该用它')
    }
    // ③ 排他声明 —— 手册明确：写进 agents 或 references 等于没写
    const hasExclusion = EXCLUSION_PATTERNS.some((re) => re.test(description))
    if (!hasExclusion) {
      push(
        'block',
        'desc-no-exclusion',
        'description 缺排他声明（§6.4 ③）—— 手册：没有第③段的 skill 大概率会被误触发',
        '补一句「不作为……的默认入口」或「普通……不应抢占入口」'
      )
    }
    // ④ 交接关系
    if (!/(hand|交接|交出|owner|负责)/i.test(description)) {
      push('warn', 'desc-no-handoff', 'description 没写跟谁交接（§6.4 ④）', '补一句谁是 owner、我交出什么')
    }
    // 纪律 2：空泛词
    const vague = VAGUE_WORDS.filter((w) => description.toLowerCase().includes(w.toLowerCase()))
    if (vague.length) {
      push('warn', 'desc-vague', `description 含空泛词：${vague.join('、')}（§6.2 纪律 2）`, '换成具体表述：测什么、怎么测')
    }
  }

  // 纪律 3：第一屏就出现授权或范围提示
  const firstScreen = text.split(/\r?\n/).slice(0, 40).join('\n')
  if (!/(授权|scope|authoriz|in-scope|范围)/i.test(firstScreen)) {
    push('block', 'no-scope-first-screen', '第一屏没有授权/范围提示（§6.2 纪律 3）', '在正文最前面加 Scope 段，防止 AI 上来就对未授权目标动手')
  }

  // 纪律 1：一个 Skill 只解决一个问题 —— 用 Layer 目录判断不了，改为提示自查
  const body = fm.ok ? fm.body : text
  // 纪律 4：关键动作必须走脚本
  const hasScripts = (input && input.hasScripts) === true
  const mentionsRawRequest = /(curl|Invoke-WebRequest|requests\.|fetch\(|nmap|ffuf|sqlmap)/i.test(body)
  if (mentionsRawRequest && !hasScripts) {
    push(
      'warn',
      'no-scripts',
      '正文里出现直接发请求的命令，但没有 scripts/（§6.2 纪律 4）',
      '关键动作放进 scripts/，AI 每次发请求的写法都可能不一样'
    )
  }

  // 纪律 5：必须保存原始请求和响应
  if (!/(原始请求|原始响应|raw request|raw response|保存.{0,6}证据)/i.test(body)) {
    push('warn', 'no-evidence-save', '没写「必须保存原始请求和响应」（§6.2 纪律 5）', '加一条：没有原始证据的结论都是猜')
  }

  // 纪律 6：排除掉的发现也要记录
  if (!/(排除|ruled-out|killed|否证|不成立)/i.test(body)) {
    push('warn', 'no-negatives', '没写「排除掉的也要记录」（§6.2 纪律 6）', '加一条：否则下次还会重复测同一个没用的方向')
  }

  // 纪律 7：证据目录加进 .gitignore
  if (EVIDENCE_MARKERS.some((m) => body.includes(m)) && !(input && input.gitignoreCoversEvidence) === true) {
    if (!(input && input.gitignoreCoversEvidence)) {
      push('warn', 'evidence-not-ignored', '提到证据目录但没确认它进了 .gitignore（§6.2 纪律 7）', '证据里常有敏感数据，别误提交')
    }
  }

  // 手册第六节最值钱的一段：不要抄原理
  // 判据：必须能看到「判断流程」的某种形态，而不是整篇原理复述。
  //
  // 手册说的判断流程有三种合法形态，不能只认 Step N：
  //   ① 顺序决策树   Step 1 / 按顺序执行 / IF..THEN
  //   ② 触发映射表   Launch Contract 那种「用户说什么 → 加载什么」
  //   ③ 分诊判据表   条件 → 结论 的对照表（§6.1 打分表、闸门表）
  // 路由型 skill（如记忆库入口）天然属于 ②，不该被当成"没有判断流程"。
  const hasStepFlow = /(判断流程|决策树|按顺序执行|Step\s*[1一]|^\s*IF\s+.+\s*(THEN|→))/im.test(body)
  const hasMappingTable = /(Launch Contract|触发.{0,6}表|trigger.{0,10}table|\|\s*[^|\n]{0,30}(用户说|The user says|触发条件|Trigger)[^|\n]{0,20}\s*\|)/i.test(body)
  const hasTriageTable = /(\|\s*[^|\n]{0,24}(判据|条件|Condition|Trigger)[^|\n]{0,20}\s*\|[\s\S]{0,200}\|\s*[^|\n]{0,24}(结论|动作|Read|加载)[^|\n]{0,20}\s*\|)/i.test(body)
  const hasDecisionFlow = hasStepFlow || hasMappingTable || hasTriageTable

  if (!hasDecisionFlow) {
    push('block', 'no-decision-flow', '没有判断流程（§6.2：最常见错误是把决策树写成原理复述）', '写清先做什么、几个请求、什么结果对应什么结论、什么时候停；路由型 skill 用「触发 → 加载什么」的映射表')
  }
  if (/(原理：|什么是|概念：|定义：)/.test(body) && !hasDecisionFlow) {
    push('warn', 'principle-not-flow', '正文看起来是原理复述（§6.2 自查：这句 AI 已经知道了吗）', '知道的就删掉，只留 AI 不知道的判断条件和停止条件')
  }

  // 大表格该进 references（§6.3 瘦身第一招）
  const tableRows = (body.match(/^\s*\|.*\|\s*$/gm) || []).length
  if (tableRows > 30) {
    push('warn', 'big-table-inline', `正文里内联了 ${tableRows} 行表格（§6.3）`, '把大表格移进 references/，从每轮都读变成按需读，实测 +7.8%~+13%')
  }

  // 长度提示（§1：手册越短，留给干活的空间越多）
  const lines = body.split(/\r?\n/).length
  if (lines > 400) {
    push('warn', 'too-long', `正文 ${lines} 行，偏长（§1：手册越短，留给干活的空间越多）`, '把重料挪进 references')
  }

  return findings
}

// ---------------------------------------------------------------- 第三关-补充：普通记忆条目

/**
 * 普通记忆条目（memory/*.md、references/*.md）不走 SKILL.md 那套四段式，
 * 但手册 §5 对它们有另一组要求：**正文必须留一行指针**（若放在别的 skill 的 references 里），
 * 以及「AI 已经会的，一律不写」这条总原则。
 *
 * 这里只做低成本的形态检查，避免把 SKILL.md 的规则套错对象。
 */
export function checkMemoryEntry (input) {
  const findings = []
  const push = (level, code, message, fix) => findings.push({ level, code, message, fix })
  const text = norm(input && input.text)
  const kind = norm(input && input.kind) || 'memory'

  if (!text.trim()) {
    push('block', 'empty-entry', '空条目', '没内容就不要写')
    return findings
  }

  // 一条记忆条目该有明确的归属或触发条件，否则以后没人知道什么时候该读它
  const hasAnchor = /(触发|何时读|适用|scope|trigger|when to read|来源|source)/i.test(text)
  if (!hasAnchor) {
    push('warn', 'entry-no-anchor', '条目没写「什么时候该读它」（手册 §3：不知道何时读的知识等于没写）', '补一行触发条件或适用场景')
  }

  // 放 references 里的必须有指针回到正文（§5 蒸馏产物放哪）
  if (kind === 'reference' && input && input.pointerInBody !== true) {
    push('block', 'reference-no-pointer', 'references 里的文件没在正文留指针（§5）', '在 SKILL.md 正文加一行指向该文件的说明，否则没人会读到它')
  }

  // ── §5「元数据层：怎么选」──────────────────────────────────────────────
  //
  // 手册第五章的三层里，元数据层管的是「以后靠什么被选中」。
  // 在本库这份记忆里，承担这个角色的是 registry/ROUTING.md 的 Trigger Table。
  //
  // 为什么这条要单独查：条目本身写得再好，没进路由表就永远不会被命中 ——
  // 正是手册第三章那句「不知道何时读的知识等于没写」。
  // 三种传法区别对待：
  //   routingRegistered === true  → 已登记，不报
  //   routingRegistered === false → 调用方明确说没登记 → block（自己都知道漏了）
  //   未传                         → 未知 → warn，要求当场确认
  if (input && input.routingRegistered === true) {
    // 已登记，放行
  } else if (input && input.routingRegistered === false) {
    push('block', 'entry-not-routed',
      '条目没登记进路由表（§5 元数据层：怎么选）—— 写进去也检索不到',
      '在 registry/ROUTING.md 的 Trigger Table 加一行：触发条件 → 读哪个文件 → 它给你什么')
  } else {
    push('warn', 'entry-routing-unconfirmed',
      '没确认这个条目是否已登记进 registry/ROUTING.md（§5 元数据层）',
      '确认路由表里有一行能命中它；没有就补一行，否则以后按触发词检索时找不到')
  }

  // ── §6.4 触发词表（Launch contract）格式 ──────────────────────────────
  //
  // 手册说「用户不会说"请调用 X"，用户会说"看看能不能盗号"」，
  // 所以路由靠的是触发词表。这里只校验**如果给了触发词行，它的形状对不对**。
  const row = norm(input && input.routingRow)
  if (row) {
    const cells = row.split('|').filter((c) => c.trim() !== '')
    if (!row.trim().startsWith('|')) {
      push('block', 'routing-row-not-table',
        '触发词行不是表格行（§6.4 触发词表）', '写成 | **"用户会说的口语"** | `要读的文件` | 它给你什么 |')
    } else if (cells.length < 3) {
      push('block', 'routing-row-shape',
        `触发词行只有 ${cells.length} 列，Trigger Table 需要 3 列（触发条件 / 读什么 / 给你什么）（§6.4）`,
        '补成三列；中间列写「用户原话→读哪个文件」，右列写一句话摘要')
    }
    // 触发词必须是用户会说的口语，不是内部文件名
    if (!/["“「]/.test(row)) {
      push('warn', 'routing-row-no-utterance',
        '触发条件里没有引号包起来的用户原话（§6.4：用户不会说「请调用 X」）',
        '把用户真实会说的话用引号写出来，比如 "这个目标怎么什么都能 200"')
    }
  }

  // 原样搬运大段外部原文 = 没蒸馏（手册第二节：蒸馏不等于总结，更不等于搬运）
  if (input && input.isRawCopy === true) {
    push('block', 'raw-copy', '看起来是原样搬运外部材料，没有蒸馏（§2：蒸馏是把具体的变通用的）', '抽象成判断条件，剥掉跟具体目标绑死的细节')
  }

  return findings
}

// ---------------------------------------------------------------- 编排：全部由谁负责

/**
 * §6.4 单一 owner：一个问题只能有一个负责人。
 *
 * 为什么需要跨文件检查：单个 skill 的描述里写「把全流程交给 X」是看不出来的，
 * 真正的问题是**两个 skill 都声称自己是总控** —— 各自维护一份状态、互相覆盖，
 * AI 不知道听谁的。这件事只有把候选放在一起比才看得见。
 *
 * @param {{self?:{name:string,owner?:string,scope?:string},
 *          others?:Array<{name:string,owner?:string,scope?:string}>}} input
 */
export function checkOwners (input) {
  const findings = []
  const push = (level, code, message, fix) => findings.push({ level, code, message, fix })
  const i = input || {}
  const self = i.self || {}
  const others = Array.isArray(i.others) ? i.others : []
  const name = norm(self.name) || '(未命名)'
  const owner = norm(self.owner).trim()

  if (!owner) {
    push('warn', 'no-owner',
      `${name} 没声明谁是 owner（§6.4 单一 owner）`,
      '在 description 第④段写明「把全流程编排交给 <owner>」，以及我交出什么')
    return findings
  }

  // 同一个 owner 被多个 skill 声称 = 谁都想当总控
  const clashes = others
    .filter((o) => o && norm(o.name) !== name && norm(o.owner).trim() === owner)
    .map((o) => norm(o.name))

  if (clashes.length) {
    push('block', 'owner-conflict',
      `${name} 与 ${clashes.join('、')} 都声称自己是「${owner}」—— 两个总控会各自维护状态、互相覆盖（§6.4）`,
      '只保留一个 owner；其余改成「我交出什么」并指向那个唯一 owner')
  }

  // overlay 型不该当主入口（横切规则）
  if (i.overlay === true && i.claimsPrimary === true) {
    push('block', 'overlay-claims-primary',
      `${name} 既是横切规则（overlay）又声称自己是主入口 —— 会抢占本该给专项的位置（§6.4）`,
      '把 overlay 从 primary 挪到回归用例的 expected_overlay 字段')
  }

  return findings
}

// ---------------------------------------------------------------- 第四关：测

/**
 * §6.3 测：带和不带的对照。
 * 只测正向是不够的（§6.4 回归测试：avoid 才是重点）。
 * 返回 findings
 */
export function checkValidation (input) {
  const findings = []
  const push = (level, code, message, fix) => findings.push({ level, code, message, fix })
  const v = (input && input.validation) || null

  if (!v) {
    push('block', 'no-validation', '没有带/不带对照记录（§6.3）', '同一个测试题跑两遍：带 Skill 结果 A、不带 Skill 结果 B，比较 A 是否更好')
    return findings
  }

  if (!Array.isArray(v.cases) || v.cases.length === 0) {
    push('block', 'no-cases', '对照用例为空（§6.3）', '题目要设计成有明确正确答案的，否则没法比')
  } else {
    for (const [i, c] of v.cases.entries()) {
      const tag = `用例 ${i + 1}`
      if (!c || typeof c !== 'object') {
        push('block', 'bad-case', `${tag} 格式不对`, '每个用例需要 { prompt, withSkill, withoutSkill, hasCorrectAnswer }')
        continue
      }
      // §6.3：题目必须有明确正确答案
      if (c.hasCorrectAnswer !== true) {
        push('block', 'case-no-answer', `${tag} 没有明确正确答案（§6.3）`, '换成有唯一正解的题目，否则没法比较')
      }
      if (!c.withSkill || !c.withoutSkill) {
        push('block', 'case-missing-arm', `${tag} 缺带/不带 Skill 的任一结果（§6.3）`, '两组都要记录输出，不要只记结论')
      }
      // §6.4：回归用例必须带 avoid
      if (!Array.isArray(c.avoid) || c.avoid.length === 0) {
        push(
          'block',
          'case-no-avoid',
          `${tag} 缺 avoid 负向断言（§6.4 「avoid 才是重点」）`,
          '补这个用例**不该**触发哪些 skill，否则描述会越写越宽，最后全触发'
        )
      }
    }
  }

  // §6.3：带手册更差就直接删，别去修
  if (v.withSkillWorse === true) {
    push('block', 'worse-than-baseline', '带 Skill 反而更差（§6.3）', '直接删除，不要尝试修复；修一个不好用的手册不如重新写一个')
  }

  return findings
}

// ---------------------------------------------------------------- 聚合

/**
 * 跑完四关。input 形状：
 * {
 *   score:   { unexpectedness, elegance, chain, reproducibility },
 *   decide:  { aiLikelyKnown, frequency, needsOrdering, belongsToExistingSkill, everySession, layerDir, name },
 *   write:   { text, name, hasScripts, gitignoreCoversEvidence },
 *   test:    { validation: { cases: [...], withSkillWorse } }
 * }
 */
export function runGates (input) {
  const i = input || {}
  const out = { screen: null, decide: null, write: [], test: [], owners: [], blockers: [], warnings: [] }

  // 第一关
  if (i.score) {
    out.screen = scoreMaterial(i.score)
    if (!out.screen.pass) {
      out.blockers.push({ level: 'block', code: 'score-below-threshold', message: out.screen.reason, fix: '继续找更好的材料，或改用五段框架不落盘' })
    }
  }

  // 第二关
  if (i.decide) {
    const form = decideForm(i.decide)
    const dest = decideDestination(form.form, i.decide)
    out.decide = { ...form, ...dest }
    if (form.form === 'none') {
      out.warnings.push({ level: 'warn', code: 'decided-not-to-write', message: form.reason, fix: '这是正确结果，不要硬写' })
    }
  }

  // 第三关（只有决定要写完整 Skill 时才查）
  if (i.write && (!out.decide || out.decide.form === 'skill')) {
    out.write = checkWriting(i.write)
  }

  // 第四关
  if (i.test) {
    out.test = checkValidation(i.test)
  }

  // 编排：跨 skill 的 owner 冲突（§6.4）。要传别人的信息才查得出来。
  if (i.owners) {
    out.owners = checkOwners(i.owners)
  }

  const all = [...(out.write || []), ...(out.test || []), ...(out.owners || [])]
  out.blockers = out.blockers.concat(all.filter((f) => f.level === 'block'))
  out.warnings = out.warnings.concat(all.filter((f) => f.level === 'warn'))

  out.passed = out.blockers.length === 0
  return out
}
