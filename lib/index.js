/**
 * 游隼（Peregrine）· 记忆库入库闸门
 *
 * 定位：手册《蒸馏 AI Skill成为Ai小子》在本机的**唯一执法者**。
 * 它不教知识，只做一件事 —— 拦住不该入库的东西，把该入库的东西按规矩拆成四关。
 *
 * 与隼眼（falcon-eye）的分工：
 *   隼眼   盯着「执行过程」有没有跑偏，每 6 步审一次
 *   游隼   盯着「知识入库」有没有走流程，每次写 vault 审一次
 * 两者都是旁路，都不拥有循环，都不改 goal。
 *
 * 三条不变量：
 *   1. 零日志污染 —— 只走 agent.inject 与 tools/* 原生决策，绝不往会话日志写自造事件
 *   2. 成本有界   —— T0 纯代码零 token；只有真需要时才让模型看材料
 *   3. 只拦写库   —— 读 vault、聊天、查资料一概不打扰
 */

import fs from 'node:fs'
import path from 'node:path'
import { runGates, checkWriting, checkMemoryEntry, scoreMaterial, decideForm, decideDestination, parseFrontmatter } from './gates.mjs'
import { buildSearchPlan, normalizeHits, SOURCE_KINDS } from './material.mjs'

export const name = 'peregrine'

/** 手册方法源（§Method Authority） */
const HANDBOOK_REL = 'AiforSec-b站视频\\蒸馏 AI Skill成为Ai小子原版.md'

export const defaultConfig = {
  enabled: true,
  /** 记忆库根 */
  vaultRoot: '',
  /** 手册位置（相对 vaultRoot 的上一级，或绝对路径） */
  handbookPath: '',
  /** 只在这些预设里生效；空数组 = 不限制 */
  requirePreset: [],
  /** 每个问题只拦一次，第二次放行并附问题清单 */
  blockOnce: true,
  /** 写库动作的工具名（命中即触发闸门） */
  writeToolPatterns: ['write', 'edit', 'str_replace', 'apply_patch', 'create_file', 'notebook_edit'],
  /** 判定放行的会话白名单 */
  logLevel: 'info'
}

// ---------------------------------------------------------------- 工具

function norm (s) { return String(s == null ? '' : s) }

/** 判断某个工具调用是不是「往记忆库里写东西」 */
export function isVaultWrite (exec, vaultRoot) {
  if (!exec || !exec.name) return false
  const lower = norm(exec.name).toLowerCase()
  const isWriteTool = defaultConfig.writeToolPatterns.some((p) => lower.includes(p))
  if (!isWriteTool) return false

  const args = exec.args || exec.arguments || {}
  const target = norm(args.path || args.file_path || args.filePath || args.target)
  if (!target) return false

  // 归一化后看是否落在 vault 里
  const root = norm(vaultRoot).replace(/[\\/]+$/, '').toLowerCase()
  const t = target.replace(/\//g, '\\').toLowerCase()
  return t.startsWith(root) && t !== root
}

/** 判断是不是在**读** vault（不打扰，但用来判断上下文） */
export function isVaultRead (exec, vaultRoot) {
  if (!exec || !exec.name) return false
  const lower = norm(exec.name).toLowerCase()
  if (!/(read|get_file|view|open)/.test(lower)) return false
  const args = exec.args || exec.arguments || {}
  const target = norm(args.path || args.file_path || args.filePath || args.file || args.target)
  if (!target) return false
  const root = norm(vaultRoot).replace(/[\\/]+$/, '').toLowerCase()
  const t = target.replace(/\//g, '\\').toLowerCase()
  return t.startsWith(root)
}

/** 从一次写库里抽出「写的是什么」：SKILL.md 还是普通记忆条目 */
export function classifyWriteTarget (target) {
  const t = norm(target).replace(/\//g, '\\').toLowerCase()
  if (/skill\.md$/.test(t)) return 'skill-md'
  if (/\\references\\/.test(t)) return 'reference'
  if (/\\registry\\/.test(t)) return 'registry-generated'
  if (/\\memory\\/.test(t)) return 'memory'
  return 'other'
}

/** 生成的产物不许手改（对齐 vault 的 Writing Discipline） */
const GENERATED_PATTERNS = [
  /\\registry\\(layer-index\.json|route-map\.json|skill-index\.json)$/i,
  /\\memory\\(layer-1-instant|layer-3-short-term|coverage-audit)\.md$/i
]

export function isGeneratedFile (target) {
  const t = norm(target).replace(/\//g, '\\')
  return GENERATED_PATTERNS.some((re) => re.test(t))
}

// ---------------------------------------------------------------- 提醒格式

export function formatReminder (gate, opts) {
  const o = opts || {}
  const lines = []
  const head = o.severity === 'block' ? '⛔ 游隼（拦下入库）' : '⚠ 游隼（入库提醒）'
  lines.push(head + '：' + (o.title || '材料没过入库四关'))

  const blockers = (gate.blockers || []).slice(0, 3)
  const warnings = (gate.warnings || []).slice(0, 2)
  const shown = blockers.length ? blockers : warnings
  for (const f of shown) {
    lines.push(`  · ${f.code}：${f.message}`)
  }
  if ((gate.blockers || []).length + (gate.warnings || []).length > shown.length) {
    lines.push(`  · …另有 ${(gate.blockers || []).length + (gate.warnings || []).length - shown.length} 条`)
  }
  lines.push('依据：' + (o.ruleRef || HANDBOOK_REL))
  if (o.fix) lines.push('改法：' + o.fix)
  return lines.join('\n')
}

export function pluginMessage (text, id) {
  return {
    id: id || ('peregrine-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6)),
    role: 'user',
    source: { kind: 'plugin', plugin: 'peregrine' },
    content: [{ type: 'text', text }]
  }
}

// ---------------------------------------------------------------- 插件本体

export function apply (ctx, config) {
  const cfg = { ...defaultConfig, ...(config || {}) }
  if (cfg.enabled === false) return

  const log = (level, msg) => {
    if (cfg.logLevel === 'silent') return
    try {
      if (level === 'error') ctx.logger?.error?.(`[peregrine] ${msg}`)
      else if (level === 'warn') ctx.logger?.warn?.(`[peregrine] ${msg}`)
      else ctx.logger?.info?.(`[peregrine] ${msg}`)
    } catch {}
  }

  // ---------------------------------------------------------------- 状态落盘
  // 和隼眼一样，留一个 status.json 证明「装载了、在跑」。
  // 没有这个文件，出问题时无法区分「插件没加载」和「加载了但没触发」。
  const states = new Map()

  const stateDir = (() => {
    const home = process.env.DSH_HOME || ''
    if (!home) return null
    try {
      const dir = path.join(home, 'plugins', 'peregrine')
      fs.mkdirSync(dir, { recursive: true })
      return dir
    } catch { return null }
  })()

  const stats = {
    wired: 0,
    checked: 0,
    blocked: 0,
    warned: 0,
    passed: 0,
    byCode: {}
  }

  function writeStatus () {
    if (!stateDir) return
    try {
      const payload = {
        at: new Date().toISOString(),
        plugin: 'peregrine',
        version: '0.1.0',
        config: {
          vaultRoot: cfg.vaultRoot,
          blockOnce: cfg.blockOnce,
          requirePreset: cfg.requirePreset,
          logLevel: cfg.logLevel
        },
        handbook: cfg.handbookPath || HANDBOOK_REL,
        vaultExists: (() => { try { return fs.existsSync(cfg.vaultRoot) } catch { return false } })(),
        stats,
        sessions: [...states.values()].map((s) => ({
          id: s.id,
          checked: s.checked,
          blocked: s.blocked,
          warned: s.warned
        }))
      }
      fs.writeFileSync(path.join(stateDir, 'status.json'), JSON.stringify(payload, null, 2), 'utf8')
    } catch (e) {
      log('warn', '写 status.json 失败: ' + (e && e.message))
    }
  }

  // 启动即写一次 —— 只要这个文件出现，就说明插件被装载了
  writeStatus()

  function getState (agent) {
    const key = (agent && (agent.id || agent.sessionId)) || 'default'
    if (!states.has(key)) {
      states.set(key, { id: key, blocked: new Map(), checked: 0, blockedN: 0, warned: 0, reviewed: 0, lastGate: null })
    }
    return states.get(key)
  }

  /** 只盯指挥官，工人子 agent 零打扰 */
  function isCommander (agent) {
    const h = (agent && (agent.header || agent.meta || agent)) || {}
    return (h.delegationDepth == null ? 0 : h.delegationDepth) === 0
  }

  // 预设校验（若配置了）
  function presetOk (agent) {
    if (!cfg.requirePreset || cfg.requirePreset.length === 0) return true
    const p = (agent && (agent.preset || agent.presetName)) ||
      (agent && agent.header && agent.header.preset) || ''
    return cfg.requirePreset.includes(p)
  }

  /**
   * 一次写库调用的判定。
   * 注意：这里**不做 LLM 调用** —— T0 纯代码，零 token。
   * 需要模型判断的部分（材料好不好）由调用方在写之前用 gates 自己跑。
   */
  function judgeWrite (exec, state) {
    const args = exec.args || exec.arguments || {}
    const target = norm(args.path || args.file_path || args.filePath)
    const kind = classifyWriteTarget(target)
    const findings = []

    // 生成的产物不许手改（vault 的 Writing Discipline）
    if (isGeneratedFile(target)) {
      findings.push({
        level: 'block',
        code: 'generated-file-write',
        message: `${target} 是生成物，不可手改`,
        fix: '改生成器（portswigger/build_registry.ps1 等）后重跑，不要直接编辑产物'
      })
    }

    // 只有 SKILL.md 走完整的「写」检查 —— 别的条目用另一套（checkMemoryEntry），
    // 不能把 SKILL.md 的四段式规则套到 memory 条目上。
    const content = norm(args.content || args.new_string || args.newString || args.text || args.body)
    if (kind === 'skill-md') {
      if (!content) {
        findings.push({
          level: 'warn',
          code: 'skill-md-no-content',
          message: '这次写 SKILL.md 没带正文内容，无法校验「写」这一关',
          fix: '若只是新建空文件，请在同一次调用里写入完整内容'
        })
      } else {
        const w = checkWriting({
          text: content,
          name: '',
          hasScripts: /scripts\//.test(content),
          gitignoreCoversEvidence: true // 由调用方确认
        })
        findings.push(...w)
      }
    } else if (kind === 'memory' || kind === 'reference') {
      if (content) {
        const m = checkMemoryEntry({ text: content, kind })
        findings.push(...m)
      }
    }

    return { kind, target, findings }
  }

  // 挂到 agent 上
  function wire (agent) {
    const state = getState(agent)
    const bus = agent.ctx || ctx

    // 拦截写库
    if (bus && typeof bus.on === 'function') {
      bus.on('tools/pre-execute', async (payload, next) => {
        try {
          if (!isCommander(agent) || !presetOk(agent)) return next ? next() : undefined
          const exec = payload && (payload.call || payload.exec || payload)

          if (!isVaultWrite(exec, cfg.vaultRoot)) return next ? next() : undefined

          const { kind, target, findings } = judgeWrite(exec, state)
          const blockers = findings.filter((f) => f.level === 'block')
          const warnings = findings.filter((f) => f.level === 'warn')

          // 统计（写进 status.json，方便回看拦了多少）
          stats.checked++
          state.checked++
          for (const f of findings) {
            stats.byCode[f.code] = (stats.byCode[f.code] || 0) + 1
          }

          if (blockers.length === 0 && warnings.length === 0) {
            stats.passed++
            writeStatus()
            return next ? next() : undefined
          }

          if (blockers.length) { stats.blocked++; state.blockedN++ } else { stats.warned++; state.warned++ }

          const fp = `${kind}|${blockers.map((b) => b.code).join(',') || warnings.map((w) => w.code).join(',')}`
          const seen = state.blocked.get(fp) || 0
          state.blocked.set(fp, seen + 1)

          const text = formatReminder(
            { blockers, warnings },
            {
              severity: blockers.length ? 'block' : 'warn',
              title: `${target} 没过入库闸门`,
              ruleRef: HANDBOOK_REL,
              fix: (blockers[0] && blockers[0].fix) || (warnings[0] && warnings[0].fix)
            }
          )

          // 提醒（两种级别都提醒）
          try {
            if (agent.inject) agent.inject(pluginMessage(text))
            else if (bus.inject) bus.inject(pluginMessage(text))
          } catch (e) { log('warn', 'inject 失败: ' + e.message) }

          // 拦截：blockOnce 时只拦第一次
          if (blockers.length && (cfg.blockOnce ? seen === 0 : true)) {
            log('info', `拦下一次写库：${target}`)
            writeStatus()
            return { kind: 'deny', reason: text }
          }

          writeStatus()
          return next ? next() : undefined
        } catch (e) {
          log('error', 'pre-execute 出错: ' + (e && e.message))
          return next ? next() : undefined
        }
      })
    }

    stats.wired++
    writeStatus()

    return () => { states.delete((agent && (agent.id || agent.sessionId)) || 'default') }
  }

  // 注册到所有新会话
  if (ctx && typeof ctx.on === 'function') {
    ctx.on('agent/created', (agent) => {
      try { wire(agent) } catch (e) { log('error', 'wire 失败: ' + e.message) }
    })
    ctx.on('agent/session-start', (agent) => {
      try { wire(agent) } catch (e) { log('error', 'wire 失败: ' + e.message) }
    })
  }

  log('info', `已挂载（vault=${cfg.vaultRoot}）`)
}

/** 对外暴露四关，供工具/测试直接调用 */
export {
  runGates,
  checkWriting,
  scoreMaterial,
  decideForm,
  decideDestination,
  parseFrontmatter,
  buildSearchPlan,
  normalizeHits,
  SOURCE_KINDS
}
