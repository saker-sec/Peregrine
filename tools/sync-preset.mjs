/**
 * 游隼 · 把 preset/peregrine/agent.cordis.yml 同步进 profile 补丁
 *
 * 为什么要这个工具：
 *   预设的行必须**内联**写在 profiles/web/cordis.patch.yml 里
 *   （外链 cordis:include + 自定义 preset-root 实测不生效，日志报
 *    "not installed" 与 "ERR_PACKAGE_PATH_NOT_EXPORTED"）。
 *   但内联之后就有了两份，改一份不改另一份必然漂移。
 *
 *   所以：agent.cordis.yml 是**唯一真源**，补丁里的块由本工具生成。
 *
 * 用法：
 *   node tools/sync-preset.mjs          写入（会先备份）
 *   node tools/sync-preset.mjs --check  只检查是否已同步，不同步则退出码 1
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.dirname(HERE)

const SRC = path.join(ROOT, 'preset', 'peregrine', 'agent.cordis.yml')
const PATCH = process.env.PEREGRINE_PATCH
  || path.join(os.homedir(), 'AppData', 'Roaming', 'dsh-desktop', 'harness', 'profiles', 'web', 'cordis.patch.yml')

const ROW_MARK = '    - id: preset-peregrine'
const END_MARK = '- id: ui-settings-general'

const HEADER = `    # -------------------------------------------------------------------------
    # 游隼模式（Peregrine）—— 预设声明
    #
    # 用官方 @deepseek-ai/dsh-agent-preset 声明，与内置 standard/ptc/minimal/cordis
    # 四个预设完全同构。plugins 内联，不依赖 cordis:include。
    #
    # ⚠ 本块由 tools/sync-preset.mjs 从 preset/peregrine/agent.cordis.yml 生成，
    #   不要手改；改真源后跑 node tools/sync-preset.mjs 重新生成。
    #
    #   定位     : 手册《蒸馏 AI Skill成为Ai小子》的执法者，只管入库，不管执行
    #   与猎隼   : 同构 —— 指挥官只决策派单，执行全部委派给子 agent
    #   两把锁   : SimHash + shingle 包含度（防重复提炼）
    #              渐进披露 L0/L1/L2（整库 1.4 万 k tokens → 目录 4 千 tokens）
    #   anysearch: 自带 key 管理（peregrine_anysearch_key），改完即时生效
    #   停用方式 : 把 id 改成 preset-peregrine-off
    # -------------------------------------------------------------------------
    - id: preset-peregrine
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: peregrine
        name: 游隼模式
        description: >-
          面向知识入库的游隼工作流：指挥 agent 只做「该不该写、写成什么形态」的决策与派单，
          读网页与比对全部委派给子 agent；入库前用 SimHash 与 shingle 包含度双重查重，
          防重复提炼；记忆库按渐进披露分层加载，避免整库撑爆上下文。
        order: 5
        plugins:
`

/** 原文件每行统一前移 10 格，完整保留块标量的相对缩进 */
function renderBody (yamlText, eol) {
  return yamlText
    .split(/\r?\n/)
    .map((line) => (line.trim() === '' ? '' : '          ' + line))
    .join(eol)
}

/**
 * 探测文件已有的换行符。
 *
 * 这一步不能省：早先的写入留下了「主体 CRLF + 我生成的块 LF」的混合文件，
 * 于是生成出来的块和文件里的块永远对不上，--check 永远报未同步。
 * 跟随既有换行符之后，同步才是幂等的。
 */
function detectEol (text) {
  let crlf = 0
  let lf = 0
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') {
      if (i > 0 && text[i - 1] === '\r') crlf++
      else lf++
    }
  }
  return crlf >= lf ? '\r\n' : '\n'
}

function buildBlock (eol) {
  const src = fs.readFileSync(SRC, 'utf8')
  return HEADER.split('\n').join(eol) + renderBody(src, eol) + eol
}

/** 从一段 yaml 里抠出 vaultRoot 的值（去引号）；没有则返回 null */
function vaultRootOf (text) {
  const m = /^\s*vaultRoot:\s*(.*)$/m.exec(text || '')
  if (!m) return null
  return m[1].trim().replace(/^['"]|['"]$/g, '')
}

/**
 * 防误伤：发布版预设把 vaultRoot 留空了（每台机器自己填），
 * 而本机补丁里存的是真实路径。一旦同步，真实路径会被空值覆盖 ——
 * 表现就是「游隼突然说未配置 vaultRoot」，很难往同步上想。
 * 所以这里拦一道：源为空、补丁里有值 → 除非显式 --force，否则拒绝。
 */
function guardVaultRoot (patchText) {
  const fromSrc = vaultRootOf(fs.readFileSync(SRC, 'utf8'))
  const fromPatch = vaultRootOf(patchText)
  if (fromSrc === '' && fromPatch) {
    throw new Error(
      '预设源里的 vaultRoot 是空的，而本机补丁里是「' + fromPatch + '」。\n' +
      '  同步会让它变成空值，游隼会报「未配置 vaultRoot」。\n' +
      '  如果确实要同步（比如你就是要清空），加 --force；\n' +
      '  否则先把 preset/peregrine/agent.cordis.yml 里的 vaultRoot 填成你的路径再同步。'
    )
  }
}

function sync ({ dryRun, force }) {
  if (!fs.existsSync(PATCH)) throw new Error('补丁文件不存在: ' + PATCH)
  const original = fs.readFileSync(PATCH, 'utf8')
  if (!force) guardVaultRoot(original)
  const eol = detectEol(original)
  const lines = original.split(/\r?\n/)

  // 锚点用行本身（唯一），再从它往回吃连续的注释行。
  // 不能直接拿「# 游隼模式…」这行当起点 —— 它是注释块的第二行，
  // 会让上面那条 # ----- 分隔线留下来，每同步一次块就长一行。
  const rowIdx = lines.findIndex((l) => l.trimEnd() === ROW_MARK)
  if (rowIdx < 0) throw new Error('补丁里找不到锚点行:\n  ' + ROW_MARK)
  let start = rowIdx
  while (start > 0 && lines[start - 1].trimEnd().startsWith('    #')) start--

  const end = lines.findIndex((l, i) => i > rowIdx && l.startsWith(END_MARK))
  if (end < 0) throw new Error('补丁里找不到结束标记: ' + END_MARK)

  const block = buildBlock(eol)
  // 末尾补一条空行：它原本位于 [start, end) 区间内，会被一起替换掉；
  // 显式补回来既保证可读，也保证下次同步得到同一结果（幂等）。
  const next = [...lines.slice(0, start), block.replace(/\r?\n$/, ''), '', ...lines.slice(end)].join(eol)

  const changed = next !== original
  if (!changed) return { changed: false, start: start + 1, end, lines: block.split(/\r?\n/).length, eol }

  if (!dryRun) {
    const bak = PATCH + '.bak-before-sync-' + new Date().toISOString().replace(/[:.]/g, '-')
    fs.copyFileSync(PATCH, bak)
    fs.writeFileSync(PATCH, next, 'utf8')
  }
  return { changed: true, start: start + 1, end, lines: block.split(/\r?\n/).length, eol, bak: dryRun ? null : PATCH }
}

const check = process.argv.includes('--check')
const force = process.argv.includes('--force')
try {
  // --check 只比对，不写盘，没必要拦；真正会覆盖时才拦
  const r = sync({ dryRun: check, force: check || force })
  if (!r.changed) {
    console.log(`PASS — 补丁与真源一致（块位于第 ${r.start} 行起，${r.lines} 行）`)
    process.exit(0)
  }
  if (check) {
    console.log(`NEEDS SYNC — 补丁与真源不一致（真源 ${SRC}）`)
    console.log(`  跑 node tools/sync-preset.mjs 重新生成`)
    // 提示风险但不在这里拦：真正执行时会拦
    try {
      guardVaultRoot(fs.readFileSync(PATCH, 'utf8'))
    } catch (e) {
      console.log('')
      console.log('⚠ 注意：现在直接同步会把本机的 vaultRoot 清空 ——')
      console.log('  ' + e.message.split('\n').join('\n  '))
    }
    process.exit(1)
  }
  console.log(`已同步：第 ${r.start} 行起写入 ${r.lines} 行`)
  console.log(`  真源：${SRC}`)
  console.log(`  补丁：${PATCH}`)
} catch (e) {
  console.error('同步失败:', e.message)
  process.exit(2)
}
