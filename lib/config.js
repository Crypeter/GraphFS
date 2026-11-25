                                      
                                                       

/** 没有图时怎么办：问用户 / 直接建 / 什么都不做。 */
                                                 

/** 工作区级配置。CLI 与插件共用同一份形状。 */
                                
                              
              
                                                                    
                   
            
                         
                      
                        
                  
                   
                                              
                  
                                    
                    
                                       
                      
 

export const DEFAULT_IGNORES = [
  '.git',
  '.graphfs',
  'node_modules',
  '.idea',
  '.DS_Store',
  'dist',
  'build',
  '__pycache__',
]

export const DEFAULTS = {
  mode: 'advise'        ,
  normalize: 'text'                ,
  maxFileBytes: 2 * 1024 * 1024,
  maxObligations: 5,
  maxDepth: 3,
  maxRounds: 2,
  ignore: DEFAULT_IGNORES,
  autoInit: 'ask'            ,
  askOnChange: true,
}

                                                                                 

export function resolveConfig(input             )                {
  const root = input.root
  if (!root.startsWith('/')) throw new Error(`root must be absolute: ${root}`)

  const maxFileBytes = input.maxFileBytes ?? DEFAULTS.maxFileBytes
  const maxObligations = input.maxObligations ?? DEFAULTS.maxObligations
  const maxDepth = input.maxDepth ?? DEFAULTS.maxDepth
  const maxRounds = input.maxRounds ?? DEFAULTS.maxRounds

  for (const [name, value] of Object.entries({ maxFileBytes, maxObligations, maxDepth, maxRounds })) {
    if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`)
  }

  const graphPath = input.graphPath ?? `${root.replace(/\/+$/, '')}/.graphfs/graph.yaml`

  return {
    root,
    graphPath,
    mode: input.mode ?? DEFAULTS.mode,
    normalize: input.normalize ?? DEFAULTS.normalize,
    maxFileBytes,
    maxObligations,
    maxDepth,
    maxRounds,
    ignore: input.ignore ?? DEFAULTS.ignore,
    autoInit: input.autoInit ?? DEFAULTS.autoInit,
    askOnChange: input.askOnChange ?? DEFAULTS.askOnChange,
  }
}


//# sourceURL=/Users/zfyang/Documents/文件/AI Agent/GraphFS/src/config.ts