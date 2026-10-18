/**
 * 游隼 · 预设注册器（`dsh-peregrine-distill/preset-root`）
 *
 * 作用：把「游隼模式」注册进 agentPresets，让它出现在模式选择页。
 *
 * 照搬 dsh-saker 的做法（它已验证可行）：
 *   - 新 API：presets.register({ id, name, description, plugins })
 *   - 旧 API：把 preset 目录塞进 presets.resolvedRoots
 * 两条路都实现，因为不同 DSH 版本暴露的接口不同。
 */

import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const inject = ['agentPresets']

/** 显示元数据。放这里就不用引 YAML 解析器。 */
const PRESET_ID = 'peregrine'
const PRESET_NAME = '游隼模式'
const PRESET_DESCRIPTION =
  '面向知识入库的游隼工作流：指挥 agent 只做「该不该写、写成什么形态」的决策与派单，' +
  '读网页与比对全部委派给子 agent；入库前用 SimHash 查重防重复提炼，' +
  '记忆库按渐进披露分层加载，避免整库撑爆上下文。'

export async function* apply (ctx) {
  const presets = ctx.get('agentPresets')
  const root = new URL('../preset/', import.meta.url)
  const plugins = [
    {
      id: 'peregrine-composition',
      name: 'cordis:include',
      config: { path: new URL('peregrine/agent.cordis.yml', root).href }
    }
  ]

  // 新版 DSH
  if (typeof presets?.register === 'function') {
    yield await presets.register({
      id: PRESET_ID,
      name: PRESET_NAME,
      description: PRESET_DESCRIPTION,
      plugins
    })
    return
  }

  // 旧版 DSH：通过 roots 发现
  if (!Array.isArray(presets?.resolvedRoots)) {
    throw new Error('dsh-peregrine-distill: unsupported agentPresets API (expected register or resolvedRoots)')
  }
  const roots = presets.resolvedRoots
  const path = fileURLToPath(root)
  if (roots.some((entry) => typeof entry.path === 'string' && resolve(entry.path) === resolve(path))) return
  const entry = { path, trust: 'system' }
  roots.unshift(entry)
  yield () => {
    const index = roots.indexOf(entry)
    if (index !== -1) roots.splice(index, 1)
  }
}
