/**
 * 游隼 · 团队汇总 CLI
 *
 * 用法：
 *   node tools/merge.mjs --vaults "D:\alice\vault,D:\bob\vault" [--out report.md] [--json]
 *   node tools/merge.mjs --vaults a,b --containment 0.6
 *
 * 特性：
 *   - **只读**：不修改任何 vault 文件；写不出报告就只打到 stdout
 *   - 报告是给人看的决策依据，不是自动合并
 *
 * 退出码：
 *   0  没有需要裁决的冲突
 *   3  有需要人裁决的冲突（CI 里可以用它拦住自动合并）
 *   2  参数或运行错误
 */

import fs from 'node:fs'
import path from 'node:path'
import { analyzeVaults, renderMergeReport, MERGE_DEFAULTS } from '../lib/merge.mjs'

function parseArgs (argv) {
  const out = { vaults: [], json: false, out: null, opts: {} }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--vaults') {
      out.vaults.push(...String(argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean))
    } else if (a === '--out') {
      out.out = argv[++i]
    } else if (a === '--json') {
      out.json = true
    } else if (a === '--containment') {
      out.opts.containmentThreshold = Number(argv[++i])
    } else if (a === '--jaccard') {
      out.opts.jaccardThreshold = Number(argv[++i])
    } else if (a === '--hamming') {
      out.opts.hammingThreshold = Number(argv[++i])
    } else if (a === '--max-per-vault') {
      out.opts.maxEntriesPerVault = Number(argv[++i])
    } else if (a === '--help' || a === '-h') {
      out.help = true
    } else if (!a.startsWith('--')) {
      out.vaults.push(a)
    }
  }
  return out
}

const HELP = `游隼 · 团队汇总（只读）

用法：
  node tools/merge.mjs --vaults <dir1,dir2,...> [选项]

选项：
  --vaults <list>       各人的 vault 根目录，逗号分隔
  --out <file>          把 markdown 报告写到文件（默认只打 stdout）
  --json                输出 JSON（机器可读）
  --containment <n>     包含度阈值，默认 ${MERGE_DEFAULTS.containmentThreshold}
  --jaccard <n>         Jaccard 阈值，默认 ${MERGE_DEFAULTS.jaccardThreshold}
  --hamming <n>         SimHash 距离阈值，默认 ${MERGE_DEFAULTS.hammingThreshold}
  --max-per-vault <n>   单库最多扫描多少条，默认 ${MERGE_DEFAULTS.maxEntriesPerVault}

退出码：0 无可裁决冲突 / 3 有冲突 / 2 出错

注意：本工具**不修改任何 vault 文件**，只产出报告。
`

const args = parseArgs(process.argv.slice(2))

if (args.help || args.vaults.length === 0) {
  console.log(HELP)
  process.exit(args.help ? 0 : 2)
}

try {
  const result = analyzeVaults(args.vaults, args.opts)

  if (args.json) {
    const payload = {
      stats: result.stats,
      options: result.options,
      missingVaults: result.missingVaults,
      clusters: result.clusters,
      conflicts: result.conflicts
    }
    const text = JSON.stringify(payload, null, 2)
    if (args.out) {
      fs.writeFileSync(args.out, text, 'utf8')
      console.log(`已写出 JSON: ${args.out}`)
    } else {
      console.log(text)
    }
  } else {
    const report = renderMergeReport(result)
    if (args.out) {
      fs.writeFileSync(args.out, report, 'utf8')
      console.log(`已写出报告: ${args.out}`)
      console.log(`  库 ${result.stats.vaults} · 条目 ${result.stats.totalEntries} · 簇 ${result.stats.clusters} · 待裁决 ${result.conflicts.length}`)
    } else {
      console.log(report)
    }
  }

  process.exit(result.conflicts.length ? 3 : 0)
} catch (e) {
  console.error('汇总失败:', e.message)
  process.exit(2)
}
