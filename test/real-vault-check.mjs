// 用真实记忆库里的 SKILL.md 验证闸门不误报
import fs from 'node:fs'
import path from 'node:path'
import { checkWriting, scoreMaterial, decideForm, runGates } from '../lib/gates.mjs'

const VAULT = process.env.SAKER_VAULT_ROOT || ''

function walk (dir, out = [], depth = 0) {
  if (depth > 3) return out
  let ents = []
  try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const e of ents) {
    if (e.name === '.git' || e.name === 'node_modules') continue
    const full = path.join(dir, e.name)
    if (e.isDirectory()) walk(full, out, depth + 1)
    else if (e.name === 'SKILL.md') out.push(full)
  }
  return out
}

const files = walk(VAULT)
console.log(`找到 ${files.length} 个 SKILL.md\n`)

let pass = 0
let blocked = 0
const blockerCounts = new Map()

for (const f of files) {
  const text = fs.readFileSync(f, 'utf8')
  const findings = checkWriting({
    text,
    hasScripts: true,            // 记忆库里有 scripts 目录的居多，放宽
    gitignoreCoversEvidence: true // 记忆库自身已管理
  })
  const blockers = findings.filter((x) => x.level === 'block')
  if (blockers.length === 0) {
    pass++
  } else {
    blocked++
    for (const b of blockers) {
      blockerCounts.set(b.code, (blockerCounts.get(b.code) || 0) + 1)
    }
    if (blocked <= 5) {
      console.log(`拦下: ${path.basename(path.dirname(f))}`)
      for (const b of blockers) console.log(`   · ${b.code}: ${b.message}`)
    }
  }
}

console.log(`\n=== 汇总 ===`)
console.log(`  通过: ${pass}`)
console.log(`  拦下: ${blocked}`)
console.log(`  通过率: ${((pass / files.length) * 100).toFixed(1)}%`)
if (blockerCounts.size) {
  console.log('\n拦截原因分布:')
  for (const [code, n] of [...blockerCounts].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${code}: ${n}`)
  }
}

// 用主 SKILL.md 跑一次完整四关
const main = path.join(VAULT, 'SKILL.md')
if (fs.existsSync(main)) {
  console.log('\n=== 主导 SKILL.md 的四关判定 ===')
  const gates = runGates({
    score: { unexpectedness: 3, elegance: 2, chain: 1, reproducibility: 2 },
    decide: { aiLikelyKnown: true, frequency: 'high', needsOrdering: true, layerDir: '00-routing', name: 'test-vault' },
    write: { text: fs.readFileSync(main, 'utf8'), hasScripts: true, gitignoreCoversEvidence: true },
    test: {
      validation: {
        cases: [{ prompt: 'p', withSkill: 'a', withoutSkill: 'b', hasCorrectAnswer: true, avoid: ['x'] }]
      }
    }
  })
  console.log('  通过:', gates.passed)
  console.log('  形态:', gates.decide?.form, '→', gates.decide?.dest)
  if (gates.blockers.length) {
    for (const b of gates.blockers) console.log('  blocker:', b.code, '-', b.message)
  }
  if (gates.warnings.length) {
    for (const w of gates.warnings.slice(0, 4)) console.log('  warn:', w.code, '-', w.message)
  }
}
