import type { ClockPort } from "../ports.js";

export class FakeClock implements ClockPort {
  constructor(private t = 0) {}
  now(): number {
    return this.t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
}
