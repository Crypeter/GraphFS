/**
 * 脏集：哪些节点被写过、哪些只是被监听看见（可疑），以及自激抑制的期望值。
 * 只认节点 id，不认路径——路径到节点的映射在门面里（一个文件可能贡献多个区域节点）。
 */
export class Detector {
                   dirty = new Set        ()
                   suspects = new Set        ()
                   expected = new Map                ()

  /** 门面写入后调用：确定脏。 */
  onWritten(nodeId        )       {
    this.dirty.add(nodeId)
    this.suspects.delete(nodeId)
  }

  /** 宿主事件（fs/observed）或监听：不确定是内容变化还是 touch，先记可疑。 */
  onObserved(nodeId        )       {
    if (this.dirty.has(nodeId)) return
    this.suspects.add(nodeId)
  }

  /** 写之前登记：写完之后如果监听报同一个 hash，就丢弃这条通知。 */
  expect(nodeId        , hash        )       {
    this.expected.set(this.key(nodeId, hash), nodeId)
  }

  /** 命中则消费掉并返回 true（只吞一次）。 */
  consumeExpected(nodeId        , hash        )          {
    const key = this.key(nodeId, hash)
    if (!this.expected.has(key)) return false
    this.expected.delete(key)
    this.dirty.delete(nodeId)
    this.suspects.delete(nodeId)
    return true
  }

  drainDirty()           {
    const out = [...this.dirty].sort()
    this.dirty.clear()
    return out
  }

  drainSuspects()           {
    const out = [...this.suspects].sort()
    this.suspects.clear()
    return out
  }

  get dirtyCount()         {
    return this.dirty.size
  }

          key(nodeId        , hash        )         {
    return `${nodeId}\u0000${hash}`
  }
}


//# sourceURL=/Users/zfyang/Documents/文件/AI Agent/GraphFS/src/engine/detector.ts