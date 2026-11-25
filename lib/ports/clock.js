                        
               
 

export class SystemClock                  {
  now()         {
    return new Date().toISOString()
  }
}

export class FakeClock                  {
          t        
  constructor(start = '2026-01-01T00:00:00.000Z') {
    this.t = Date.parse(start)
  }
  now()         {
    const iso = new Date(this.t).toISOString()
    this.t += 1000
    return iso
  }
}


//# sourceURL=/Users/zfyang/Documents/文件/AI Agent/GraphFS/src/ports/clock.ts