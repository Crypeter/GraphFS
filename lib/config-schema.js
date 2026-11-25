                                                
import { DEFAULT_IGNORES } from './config.js'

/**
 * cordis 只要求 `Config["~standard"].validate(value)`（Standard Schema v1），
 * 不要求 schemastery。所以这里手写一个 30 行的校验器，插件因此**零运行时依赖**——
 * 安装时不会去 registry 拉任何包，也就不会出现「两份 cordis / 两份 dsh-tools」的身份问题。
 */

                                   
                                             
                   
                        
                  
                      
                                             
                  
                                      
                      
 

const DEFAULTS                   = {
  mode: 'advise',
  maxRounds: 2,
  maxObligations: 5,
  maxDepth: 3,
  maxFileBytes: 2 * 1024 * 1024,
  normalize: 'text',
  ignore: DEFAULT_IGNORES,
  autoInit: 'ask',
  askOnChange: true,
}

const MODES = ['off', 'observe', 'advise', 'auto']         
const NORMALIZERS = ['text', 'bytes', 'dsh-i18n-v1']         
const AUTO_INIT = ['ask', 'always', 'never']         

export function normalizeConfig(input         )                   {
  const raw = (input ?? {})                             
  const issues = validate(raw)
  if (issues.length > 0) throw new TypeError(`graphfs config: ${issues.map((i) => i.message).join('; ')}`)

  return {
    mode: raw.mode ?? DEFAULTS.mode,
    maxRounds: raw.maxRounds ?? DEFAULTS.maxRounds,
    maxObligations: raw.maxObligations ?? DEFAULTS.maxObligations,
    maxDepth: raw.maxDepth ?? DEFAULTS.maxDepth,
    maxFileBytes: raw.maxFileBytes ?? DEFAULTS.maxFileBytes,
    normalize: raw.normalize ?? DEFAULTS.normalize,
    ignore: raw.ignore ?? DEFAULTS.ignore,
    autoInit: raw.autoInit ?? DEFAULTS.autoInit,
    askOnChange: raw.askOnChange ?? DEFAULTS.askOnChange,
  }
}

function validate(raw                           )                                              {
  const issues                                              = []

  if (raw.mode !== undefined && !MODES.includes(raw.mode)) {
    issues.push({ message: `mode must be one of ${MODES.join('|')}`, path: ['mode'] })
  }
  if (raw.normalize !== undefined && !NORMALIZERS.includes(raw.normalize)) {
    issues.push({ message: `normalize must be one of ${NORMALIZERS.join('|')}`, path: ['normalize'] })
  }
  for (const key of ['maxRounds', 'maxObligations', 'maxDepth', 'maxFileBytes']         ) {
    const value = raw[key]
    if (value !== undefined && (!Number.isInteger(value) || value < 1)) {
      issues.push({ message: `${key} must be a positive integer`, path: [key] })
    }
  }
  if (raw.ignore !== undefined && (!Array.isArray(raw.ignore) || raw.ignore.some((x) => typeof x !== 'string'))) {
    issues.push({ message: 'ignore must be an array of strings', path: ['ignore'] })
  }
  if (raw.autoInit !== undefined && !AUTO_INIT.includes(raw.autoInit)) {
    issues.push({ message: `autoInit must be one of ${AUTO_INIT.join('|')}`, path: ['autoInit'] })
  }
  if (raw.askOnChange !== undefined && typeof raw.askOnChange !== 'boolean') {
    issues.push({ message: 'askOnChange must be a boolean', path: ['askOnChange'] })
  }

  return issues
}

export const Config = {
  '~standard': {
    version: 1         ,
    vendor: 'graphfs',
    validate(value         ) {
      const raw = (value ?? {})                             
      const issues = validate(raw)
      if (issues.length > 0) return { issues }
      return { value: normalizeConfig(raw) }
    },
  },
}


//# sourceURL=/Users/zfyang/Documents/文件/AI Agent/GraphFS/src/config-schema.ts