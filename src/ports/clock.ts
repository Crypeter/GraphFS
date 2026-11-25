export interface Clock {
  now(): string
}

export class SystemClock implements Clock {
  now(): string {
    return new Date().toISOString()
  }
}

export class FakeClock implements Clock {
  private t: number
  constructor(start = '2026-01-01T00:00:00.000Z') {
    this.t = Date.parse(start)
  }
  now(): string {
    const iso = new Date(this.t).toISOString()
    this.t += 1000
    return iso
  }
}
