/**
 * GraphFS 领域类型（唯一真相）。
 *
 * 约束：本文件不含 I/O、不 import 任何 DSH 包；除 GraphFSError 外没有运行时逻辑。
 * 说明见 GraphFS_Spec.md §2 与 GraphFS_Intent.md §3。
 */

/* ------------------------------------------------------------------ 枚举 */

                                                        

                                                                                                     

/** 权威端内容永远不被对方覆盖；none 表示不设权威（仅对称关系）。 */
                                              

/** 哪一侧变更会发起修复。 */
                                                     

/** 非触发侧自己变了怎么办。 */
                                                         

/** 义务强度：required 才允许钉住回合。 */
                                                                

/** 满足判据：机器判 / 结构判 / 人判。 */
                                                                

/** 边级策略：auto 可跑 producer；enforce 是 v2 的拒写。 */
                                                      

/* ------------------------------------------------------------------ 节点 */

/** 一致性单元：默认整文件；heading 按文档中第 n 个标题定位（1 起），lines 备用。 */
                  
                          
                                      
                                               

                       
            
              
            
 

/* ------------------------------------------------------------------ 边 */

                               
                                
                 
                   
 

                       
            
                              
              
                
            
                    
                      
                  
                          
                             
                       
                    
                                 
                  
                      
                
                         
                     
 

/* ---------------------------------------------------------- 判定与义务 */

                     
                     
                                 
                                                                              
                                               
                                                
                                    
                                                              
                                                

                        
                                                        
                                                          
                                                                      

                                                                                                   

                                                                              

                             
            
                
                  
                
                              
               
                   
                      
                                     
                        
                          
               
                   
                    
                 
 

/* ---------------------------------------------------------------- 图 */

/** 有效弧：trigger 允许 且 终点不是权威端。 */
                      
            
                
 

                             
              
                 
                 
                 
 

                                
                          
                          
                               
                             
                                       
                                  
                      
                        
                                            
                        
     
                                
                                   
     
                                       
 

                             
               
                  
                                             
 

/* -------------------------------------------------------- 运行时状态 */

                               
            
                 
                           
                                                                         
                                  
                                       
                      
 

                                 
                
              
                              
 

                       
                           
                            
                                         
                   
                                  
                                       
                         
                    
 

/* ------------------------------------------------------------ 错误码 */

export const GF_CODES = [
  'GF_GRAPH_INVALID',
  'GF_EDGE_CYCLE',
  'GF_DANGLING_EDGE',
  'GF_UNIT_MISMATCH',
  'GF_UNHASHABLE',
  'GF_BUDGET_EXHAUSTED',
  'GF_OSCILLATION',
  'GF_NO_PROGRESS',
  'GF_PRODUCER_FAILED',
  'GF_APPROVAL_DENIED',
  'GF_STATE_INVALID',
  'GF_MODEL_FAILED',
  'GF_WORKSPACE_MISMATCH',
  /** 审计/导入：账本与正文复算不一致（不阻断导入，单独列出）。 */
  'GF_I18N_UNVERIFIED',
  /** 另一个进程正在写这个工作区。 */
  'GF_LOCK_TIMEOUT',
]         

                                              

export class GraphFSError extends Error {
           code        
           remedy         

  constructor(message        , code        , remedy         ) {
    super(message)
    this.name = 'GraphFSError'
    this.code = code
    this.remedy = remedy
  }
}

/** 便捷构造：让所有抛错点都带上稳定 code。 */
export function gfError(code        , message        , remedy         )               {
  return new GraphFSError(message, code, remedy)
}


//# sourceURL=/Users/zfyang/Documents/文件/AI Agent/GraphFS/src/types.ts