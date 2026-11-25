import { randomUUID } from 'node:crypto'
                                                                

/**
 * `Host` 的 DSH 实现。三个接缝：
 *   fs/observed          (target, observation, actor)  → actor.agent
 *   agent/turn-stopping  ({ turn, signal })            → turn.agent / agents.get(sessionId)
 *   ctx.fs.watch         未接线（M2 可选）
 *
 * ⚠️ 只在 DSH 运行时可用；本地由 test/integration 的假 Host 覆盖同一契约。
 */

                         
                      
               
 

/**
 * DSH inbox 里的一条**完整**用户消息。
 *
 * `Agent.inject/steer` 不会替调用方补 `id` 和 `role`：它把这对象原样写进
 * `agent/inbox/spliced`，回合开始时再原样写成 `user/message`。缺 `id`/`role`
 * 的载荷会以损坏事件的形式落盘（重开会话时报
 * "session event at seq N lacks an identified message"），同时也会被原样送进
 * provider 请求（422 `missing field role`）。所以这里必须自己发一个完整消息。
 */
                        
            
              
                                                
                          
 

                       
             
                   
                                  
                                   
 

/** 构造一条带稳定身份、role 与来源标记的 graphfs 用户消息。 */
function graphfsMessage(text        )               {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'graphfs' },
  }
}

                  
            
                    
                 
 

                         
                
                   
                        
                      
                
                      
                     
                                                              
      
                                    
 

                      
                                                     
                                                      
                             
                                                                 
                                                
 

export class DshHost                 {
                   ctx            
                   rootOfPath                                
  /** 最近一次 ask 为什么没弹（排查用，`graphfs_status` 会带出来）。 */
  lastAskError         

  constructor(ctx            , rootOfPath                                 = (abs) => abs) {
    this.ctx = ctx
    this.rootOfPath = rootOfPath
  }

  onObserved(handler                                            )             {
    return this.ctx.on('fs/observed', (target               , _observation         , actor     ) => {
      // 读文件也会发 fs/observed；只有写/编辑才该参与一致性判定。
      if (isReadOnlyObservation(actor)) return
      const agent = actor?.agent
      // 没有 agent 的观察（外部进程/其它插件）不归本插件管：否则会落到
      // fallbackRoot（profile 目录）上，凭空造出第二张图。
      if (!agent) return
      const abs = this.ctx.fs.processPath?.(target) ?? target.displayPath ?? target.path
      if (!abs) return
      handler(abs, agent)
    })
  }

  /**
   * `agent/turn-stopping` 的载荷是 `{ agent, turn, signal }`：
   *   - `agent` 由事件派发层注入（与 `dsh-workspace-changes` 同一约定）；
   *   - **`turn` 是数字**（`turn/start` 的自增序号），不是带 sessionId 的对象。
   *
   * 早期版本把 `turn` 当对象去读 `.agent` / `.sessionId`，于是 agent 恒为 undefined、
   * 整个回合收口逻辑静默短路——这就是"装了插件却从不提醒"的直接原因。
   */
  onTurnStopping(handler                                                )             {
    return this.ctx.on(
      'agent/turn-stopping',
      async (payload                                                              ) => {
        const agent = payload?.agent
        if (!agent) return
        const turnId = `${agent.id ?? 'agent'}:${String(payload?.turn ?? '?')}`

        await handler({
          turnId,
          agent,
          signal: payload?.signal,
          steer: (text) => agent.steer(graphfsMessage(text)),
          inject: (text) => agent.inject(graphfsMessage(text)),
        })
      },
    )
  }

  /**
   * 插件主动弹出选择框：走宿主自己的 `userQuestions` 服务（与 `ask_user_question`
   * 工具同一个 answerer）。没有服务、没有 agent、或调用方不是 live root 时返回 null，
   * 生命周期会退回"让模型自己问"。
   */
  async ask(request   
                   
                        
                   
                    
                     
   )                         {
    let service                           
    try {
      service = (this.ctx.get?.('userQuestions') ??
        (this.ctx                               ).userQuestions)                             
    } catch {
      service = undefined
    }
    if (!service) {
      this.lastAskError = 'userQuestions 服务不可用（ctx.get 返回空）'
      return null
    }
    if (!request.agent) {
      this.lastAskError = '没有可用的 agent（事件未带 agent）'
      return null
    }
    if (request.signal?.aborted) {
      this.lastAskError = '回合已取消'
      return null
    }

    try {
      const result = await service.ask({
        agent: request.agent,
        signal: request.signal,
        questions: [
          {
            id: 'graphfs',
            header: request.header,
            question: request.question,
            options: request.options.map((label) => ({ label })),
          },
        ],
      })
      const answer = result?.answers?.find((item) => item.id === 'graphfs') ?? result?.answers?.[0]
      if (!answer) {
        this.lastAskError = '用户没有返回答案'
        return null
      }
      this.lastAskError = undefined
      if (answer.custom && answer.custom.trim() !== '') return answer.custom.trim()
      return answer.selected[0] ?? null
    } catch (error) {
      this.lastAskError = error instanceof Error ? error.message : String(error)
      return null
    }
  }

  /** 供 status/诊断使用：当前上下文能不能拿到提问服务。 */
  hasUserQuestions()          {
    try {
      return Boolean(this.ctx.get?.('userQuestions') ?? (this.ctx                               ).userQuestions)
    } catch {
      return false
    }
  }

  log(level                 , message        )       {
    this.ctx.log?.(level, message)
  }
}

/**
 * 判断一次观察是否只是"读"。`exec` 的形状是 `{ callId, name, arguments, agent, signal }`，
 * 未知工具按"可能是写"处理（宁可多检查一次，也不要漏掉变更）。
 */
function isReadOnlyObservation(actor         )          {
  if (!actor || typeof actor !== 'object') return false
  const name = (actor                      ).name
  if (typeof name !== 'string') return false
  if (name === 'read' || name === 'view' || name === 'grep' || name === 'glob' || name === 'list') return true
  if (name === 'str_replace_editor') {
    const args = (actor                           ).arguments
    const command =
      args && typeof args === 'object' ? (args                         ).command : undefined
    return command === 'view'
  }
  return false
}


//# sourceURL=/Users/zfyang/Documents/文件/AI Agent/GraphFS/src/adapters/dsh-host.ts