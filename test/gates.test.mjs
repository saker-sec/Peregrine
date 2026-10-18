import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  scoreMaterial, decideForm, decideDestination, checkWriting, checkValidation,
  checkMemoryEntry, checkOwners, runGates, parseFrontmatter, SCORE_THRESHOLD
} from '../lib/gates.mjs'

// ---------------------------------------------------------------- 第一关：筛

test('筛：满分 10 分材料通过', () => {
  const r = scoreMaterial({ unexpectedness: 3, elegance: 3, chain: 2, reproducibility: 2 })
  assert.equal(r.total, 10)
  assert.equal(r.pass, true)
})

test('筛：6 分未达 7 分线，不通过（§6.1）', () => {
  const r = scoreMaterial({ unexpectedness: 2, elegance: 2, chain: 1, reproducibility: 1 })
  assert.equal(r.total, 6)
  assert.equal(r.pass, false)
  assert.match(r.reason, /低于 7 分线/)
})

test('筛：刚好 7 分通过（边界）', () => {
  const r = scoreMaterial({ unexpectedness: 3, elegance: 2, chain: 1, reproducibility: 1 })
  assert.equal(r.total, 7)
  assert.equal(r.pass, true)
  assert.equal(SCORE_THRESHOLD, 7)
})

test('筛：超出维度上限按上限截断，不能靠填大数过关', () => {
  const r = scoreMaterial({ unexpectedness: 99, elegance: 0, chain: 0, reproducibility: 0 })
  assert.equal(r.breakdown.unexpectedness, 3)
  assert.equal(r.total, 3)
  assert.equal(r.pass, false)
})

test('筛：缺维度记 0 并报告缺哪个', () => {
  const r = scoreMaterial({ unexpectedness: 3, elegance: 3 })
  assert.equal(r.total, 6)
  assert.ok(r.missing.some((m) => m.includes('chain')))
})

// ---------------------------------------------------------------- 第二关：定

test('定：AI 已知且不需要排序 → 不写（§4 第一条）', () => {
  const r = decideForm({ aiLikelyKnown: true, frequency: 'high', needsOrdering: false })
  assert.equal(r.form, 'none')
})

test('定：AI 已知但不会排序 → 写 Skill（§4 第三种情况，收益最大）', () => {
  const r = decideForm({ aiLikelyKnown: true, frequency: 'high', needsOrdering: true })
  assert.equal(r.form, 'skill')
  assert.match(r.reason, /顺序和决策树/)
})

test('定：AI 不知道且低频 → 五段框架（§2）', () => {
  const r = decideForm({ aiLikelyKnown: false, frequency: 'low' })
  assert.equal(r.form, 'five-part')
})

test('定：AI 不知道且高频 → 完整 Skill', () => {
  const r = decideForm({ aiLikelyKnown: false, frequency: 'high' })
  assert.equal(r.form, 'skill')
})

test('定：五段框架默认不落盘（§5 默认去处是不落盘）', () => {
  const d = decideDestination('five-part', {})
  assert.equal(d.dest, 'inline')
})

test('定：属于已有 Skill → 放 references', () => {
  const d = decideDestination('five-part', { belongsToExistingSkill: 'my-skill' })
  assert.equal(d.dest, 'references')
  assert.match(d.path, /my-skill\/references/)
})

test('定：要求每次会话生效 → AGENTS.md', () => {
  const d = decideDestination('skill', { everySession: true })
  assert.equal(d.dest, 'agents-md')
})

test('定：正式 Skill 落到编号分类目录（§5）', () => {
  const d = decideDestination('skill', { layerDir: '30-injection', name: 'foo' })
  assert.equal(d.dest, 'skill-dir')
  assert.match(d.path, /30-injection\/foo/)
})

// ---------------------------------------------------------------- 第三关：写

const GOOD_SKILL = `---
name: semicolon-path-traversal-zh
description: >-
  分号路径穿越专项。仅在目标链路已确认存在反向代理且后端为 Java Servlet 容器后使用；
  覆盖 ; 剥离与归一化顺序的判断，不作为所有路径类测试的默认入口；
  把全流程编排交给 auto-pentest-router。
---

# 分号路径穿越

## Scope

仅在授权范围内对已确认归属的目标测试。

## 判断流程（按顺序执行，任一步为 NO 就停）

### Step 1：确认链路结构
Q: 目标前面有没有反向代理 / WAF？
  NO  → 停止，这个思路不适用
  YES → 继续

### Step 2：确认剥离行为（1 个请求）
发送：GET /public/..;/admin/users
对比基线：GET /admin/users
  变体返回与基线一致 → 剥离发生了，继续
  变体返回 400        → 容器已拒绝，停止

### Step 3：记录与停止
- 最多试 3 个变体
- 无决定性信号 → 标记 ruled-out 并写进记录
- 必须保存原始请求和响应
`

test('写：合格 SKILL.md 无 blocker', () => {
  const f = checkWriting({ text: GOOD_SKILL, hasScripts: false, gitignoreCoversEvidence: true })
  const blockers = f.filter((x) => x.level === 'block')
  assert.deepEqual(blockers, [], '期望无 blocker，实际: ' + JSON.stringify(blockers, null, 2))
})

test('写：缺排他声明必须拦（§6.4 ③，手册明说会误触发）', () => {
  // 构造一个只有身份+触发、完全没有排他/交接描述的最小 frontmatter
  const bad = `---
name: some-specialist-zh
description: >-
  某个分号路径穿越的专项 skill，用来判断容器剥离行为。
---

# 分号路径穿越

## Scope

仅在授权范围内对已确认归属的目标测试。

## 判断流程

### Step 1：确认剥离行为
发送：GET /public/..;/admin/users
  变体返回与基线一致 → 剥离发生了，继续
  变体返回 400 → 停止
必须保存原始请求和响应。
`
  const f = checkWriting({ text: bad, hasScripts: false, gitignoreCoversEvidence: true })
  assert.ok(f.some((x) => x.code === 'desc-no-exclusion' && x.level === 'block'), JSON.stringify(f, null, 2))
})

test('写：缺判断流程必须拦（§6.2 最常见错误）', () => {
  const bad = GOOD_SKILL
    .replace('## 判断流程（按顺序执行，任一步为 NO 就停）', '## 原理')
    .replace(/### Step \d[^\n]*\n/g, '')
    .replace(/ {2}(NO|YES|变体)[^\n]*\n/g, '')
  const f = checkWriting({ text: bad, hasScripts: false, gitignoreCoversEvidence: true })
  assert.ok(f.some((x) => x.code === 'no-decision-flow' && x.level === 'block'))
})

test('写：第一屏没有授权提示必须拦（§6.2 纪律 3）', () => {
  // 把正文里的 Scope 段整个拿掉，也不留 authorization 字样
  const bad = GOOD_SKILL
    .replace('## Scope\n\n仅在授权范围内对已确认归属的目标测试。\n', '')
  const f = checkWriting({ text: bad, hasScripts: false, gitignoreCoversEvidence: true })
  assert.ok(f.some((x) => x.code === 'no-scope-first-screen' && x.level === 'block'), JSON.stringify(f, null, 2))
})

test('写：空泛词只警告不拦（§6.2 纪律 2）', () => {
  const bad = GOOD_SKILL.replace('分号路径穿越专项。', '安全测试专项。')
  const f = checkWriting({ text: bad, hasScripts: false, gitignoreCoversEvidence: true })
  const vague = f.find((x) => x.code === 'desc-vague')
  assert.ok(vague, '应命中空泛词')
  assert.equal(vague.level, 'warn')
})

test('写：没有 frontmatter 必须拦', () => {
  const f = checkWriting({ text: '# 只有正文\n内容', hasScripts: false })
  assert.ok(f.some((x) => x.code === 'no-frontmatter' && x.level === 'block'))
})

test('写：description 没写触发条件必须拦（§6.4 ②）', () => {
  const bad = GOOD_SKILL.replace('仅在目标链路已确认存在反向代理且后端为 Java Servlet 容器后使用；', '')
  const f = checkWriting({ text: bad, hasScripts: false, gitignoreCoversEvidence: true })
  assert.ok(f.some((x) => x.code === 'desc-no-trigger' && x.level === 'block'))
})

test('写：大表格内联只警告（§6.3 瘦身）', () => {
  const table = Array.from({ length: 35 }, (_, i) => `| r${i} | v |`).join('\n')
  const text = GOOD_SKILL + '\n' + table + '\n'
  const f = checkWriting({ text, hasScripts: false, gitignoreCoversEvidence: true })
  assert.ok(f.some((x) => x.code === 'big-table-inline' && x.level === 'warn'))
})

// ---------------------------------------------------------------- 第三关-补充：普通记忆条目

test('记忆条目：references 没在正文留指针必须拦（§5）', () => {
  const f = checkMemoryEntry({ text: '触发：当看到 XX 时读这里。\n内容……', kind: 'reference', pointerInBody: false })
  assert.ok(f.some((x) => x.code === 'reference-no-pointer' && x.level === 'block'))
})

test('记忆条目：references 有指针则通过', () => {
  const f = checkMemoryEntry({ text: '触发：当看到 XX 时读这里。', kind: 'reference', pointerInBody: true })
  assert.equal(f.filter((x) => x.level === 'block').length, 0)
})

test('记忆条目：原样搬运外部材料必须拦（§2 蒸馏不等于总结）', () => {
  const f = checkMemoryEntry({ text: '触发：某天读。原文如下……', kind: 'memory', isRawCopy: true })
  assert.ok(f.some((x) => x.code === 'raw-copy' && x.level === 'block'))
})

test('记忆条目：没写何时读只警告（§3 不知道何时读等于没写）', () => {
  const f = checkMemoryEntry({ text: '一些零散结论，散着放的。', kind: 'memory' })
  const w = f.find((x) => x.code === 'entry-no-anchor')
  assert.ok(w, JSON.stringify(f, null, 2))
  assert.equal(w.level, 'warn')
})

test('记忆条目：空条目必须拦', () => {
  const f = checkMemoryEntry({ text: '   ', kind: 'memory' })
  assert.ok(f.some((x) => x.code === 'empty-entry' && x.level === 'block'))
})

test('记忆条目：合格条目无 blocker', () => {
  const f = checkMemoryEntry({ text: '触发：遇到 XX 形态的接口时读。结论：……', kind: 'memory' })
  assert.equal(f.filter((x) => x.level === 'block').length, 0)
})

// ---------------------------------------------------------------- 第四关：测

test('测：没有对照记录必须拦（§6.3）', () => {
  const f = checkValidation({})
  assert.ok(f.some((x) => x.code === 'no-validation' && x.level === 'block'))
})

test('测：用例缺明确正确答案必须拦', () => {
  const f = checkValidation({
    validation: { cases: [{ prompt: 'p', withSkill: 'a', withoutSkill: 'b', hasCorrectAnswer: false, avoid: ['x'] }] }
  })
  assert.ok(f.some((x) => x.code === 'case-no-answer' && x.level === 'block'))
})

test('测：用例缺 avoid 必须拦（§6.4 avoid 才是重点）', () => {
  const f = checkValidation({
    validation: { cases: [{ prompt: 'p', withSkill: 'a', withoutSkill: 'b', hasCorrectAnswer: true, avoid: [] }] }
  })
  assert.ok(f.some((x) => x.code === 'case-no-avoid' && x.level === 'block'))
})

test('测：带 Skill 更差必须拦，且提示直接删（§6.3）', () => {
  const f = checkValidation({
    validation: {
      withSkillWorse: true,
      cases: [{ prompt: 'p', withSkill: 'a', withoutSkill: 'b', hasCorrectAnswer: true, avoid: ['x'] }]
    }
  })
  const w = f.find((x) => x.code === 'worse-than-baseline')
  assert.ok(w)
  assert.equal(w.level, 'block')
  assert.match(w.fix, /直接删除/)
})

test('测：完整合格的对照记录不产生 blocker', () => {
  const f = checkValidation({
    validation: {
      cases: [
        { prompt: 'p1', withSkill: 'a', withoutSkill: 'b', hasCorrectAnswer: true, avoid: ['payment-skill'] },
        { prompt: 'p2', withSkill: 'c', withoutSkill: 'd', hasCorrectAnswer: true, avoid: ['xss-skill'] }
      ]
    }
  })
  assert.equal(f.filter((x) => x.level === 'block').length, 0)
})

// ---------------------------------------------------------------- 聚合

test('聚合：低分材料在筛关就被挡下', () => {
  const g = runGates({ score: { unexpectedness: 1, elegance: 1, chain: 0, reproducibility: 0 } })
  assert.equal(g.passed, false)
  assert.ok(g.blockers.some((b) => b.code === 'score-below-threshold'))
})

test('聚合：决定不写时只给 warn，不产生 blocker', () => {
  const g = runGates({
    score: { unexpectedness: 3, elegance: 3, chain: 2, reproducibility: 2 },
    decide: { aiLikelyKnown: true, frequency: 'high', needsOrdering: false }
  })
  assert.equal(g.passed, true)
  assert.ok(g.warnings.some((w) => w.code === 'decided-not-to-write'))
})

test('聚合：完整合格链路四关全过', () => {
  const g = runGates({
    score: { unexpectedness: 3, elegance: 3, chain: 2, reproducibility: 2 },
    decide: { aiLikelyKnown: true, needingOrdering: true, needsOrdering: true, layerDir: '30-injection', name: 'x' },
    write: { text: GOOD_SKILL, hasScripts: false, gitignoreCoversEvidence: true },
    test: {
      validation: {
        cases: [{ prompt: 'p', withSkill: 'a', withoutSkill: 'b', hasCorrectAnswer: true, avoid: ['y'] }]
      }
    }
  })
  assert.equal(g.passed, true, JSON.stringify(g.blockers, null, 2))
})

// ---------------------------------------------------------------- frontmatter

test('frontmatter：能解析折叠式 description', () => {
  const fm = parseFrontmatter(GOOD_SKILL)
  assert.equal(fm.ok, true)
  assert.equal(fm.data.name, 'semicolon-path-traversal-zh')
  assert.match(fm.data.description, /分号路径穿越专项/)
})


// ---------------------------------------------------------------- §5 元数据层：路由登记

test('路由：未确认是否登记进 ROUTING.md → warn', () => {
  const f = checkMemoryEntry({ text: '触发：遇到 XX 形态时读。结论：……', kind: 'memory' })
  const hit = f.find((x) => x.code === 'entry-routing-unconfirmed')
  assert.ok(hit, '应提示确认路由表: ' + JSON.stringify(f.map((x) => x.code)))
  assert.equal(hit.level, 'warn')
})

test('路由：已登记 → 不报', () => {
  const f = checkMemoryEntry({ text: '触发：遇到 XX 时读。', kind: 'memory', routingRegistered: true })
  assert.ok(!f.some((x) => x.code === 'entry-routing-unconfirmed'))
  assert.ok(!f.some((x) => x.code === 'entry-not-routed'))
})

test('路由：明确说没登记 → block（写了也检索不到）', () => {
  const f = checkMemoryEntry({ text: '触发：遇到 XX 时读。', kind: 'memory', routingRegistered: false })
  const hit = f.find((x) => x.code === 'entry-not-routed')
  assert.ok(hit, JSON.stringify(f.map((x) => x.code)))
  assert.equal(hit.level, 'block')
  assert.match(hit.fix, /ROUTING.md/)
})

// ---------------------------------------------------------------- §6.4 触发词表

test('触发词表：三列且带引号原话 → 通过', () => {
  const f = checkMemoryEntry({
    text: '触发：遇到 XX 时读。',
    kind: 'memory',
    routingRegistered: true,
    routingRow: '| **"这个目标怎么什么都能 200"** | `memory/a.md` | 软 404 的判据 |'
  })
  assert.deepEqual(f.filter((x) => x.code.startsWith('routing-row')), [])
})

test('触发词表：不是表格行 → block', () => {
  const f = checkMemoryEntry({ text: 'x 触发：y', kind: 'memory', routingRegistered: true, routingRow: 'memory/a.md 读这个' })
  assert.ok(f.some((x) => x.code === 'routing-row-not-table'))
})

test('触发词表：列数不足 3 → block', () => {
  const f = checkMemoryEntry({ text: 'x 触发：y', kind: 'memory', routingRegistered: true, routingRow: '| "原话" | `a.md` |' })
  assert.ok(f.some((x) => x.code === 'routing-row-shape'))
})

test('触发词表：没有用户原话 → warn（用户不会说"请调用 X"）', () => {
  const f = checkMemoryEntry({ text: 'x 触发：y', kind: 'memory', routingRegistered: true, routingRow: '| 软 404 | `a.md` | 判据 |' })
  assert.ok(f.some((x) => x.code === 'routing-row-no-utterance'))
})

// ---------------------------------------------------------------- §6.4 单一 owner

test('owner：没声明 owner → warn', () => {
  const f = checkOwners({ self: { name: 'a' }, others: [] })
  assert.ok(f.some((x) => x.code === 'no-owner'))
})

test('owner：两个 skill 都声称自己是总控 → block', () => {
  const f = checkOwners({
    self: { name: 'dex-skill-router', owner: 'full-process-orchestration' },
    others: [{ name: 'auto-pentest-router', owner: 'full-process-orchestration' }]
  })
  const hit = f.find((x) => x.code === 'owner-conflict')
  assert.ok(hit, JSON.stringify(f.map((x) => x.code)))
  assert.match(hit.message, /auto-pentest-router/)
})

test('owner：owner 不冲突 → 不报', () => {
  const f = checkOwners({
    self: { name: 'sqli-zh', owner: 'sqli-only' },
    others: [{ name: 'auto-pentest-router', owner: 'full-process-orchestration' }]
  })
  assert.deepEqual(f, [])
})

test('owner：overlay 又声称主入口 → block', () => {
  const f = checkOwners({ self: { name: 'triage', owner: 'x' }, others: [], overlay: true, claimsPrimary: true })
  assert.ok(f.some((x) => x.code === 'overlay-claims-primary'))
})

test('owner：runGates 里传 owners 才会查', () => {
  const withOwners = runGates({
    owners: {
      self: { name: 'a', owner: 'same' },
      others: [{ name: 'b', owner: 'same' }]
    }
  })
  assert.ok(withOwners.blockers.some((b) => b.code === 'owner-conflict'))

  const without = runGates({ score: { unexpectedness: 3, elegance: 3, chain: 2, reproducibility: 2 } })
  assert.deepEqual(without.owners, [])
})
