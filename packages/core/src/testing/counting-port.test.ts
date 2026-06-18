import { describe, it, expect } from "vitest";
import { CallCounter } from "./counting-port.js";

describe("CallCounter", () => {
  it("counts method calls on a wrapped object", () => {
    const counter = new CallCounter();
    const fake = {
      read: (x: number) => x * 2,
      write: () => undefined,
    };
    const wrapped = counter.wrap(fake);

    expect(counter.count("read")).toBe(0);
    wrapped.read(1);
    wrapped.read(2);
    wrapped.write();
    expect(counter.count("read")).toBe(2);
    expect(counter.count("write")).toBe(1);
  });

  it("counts async method calls only after the promise settles", async () => {
    const counter = new CallCounter();
    let resolve!: () => void;
    const asyncFake = {
      fetchData: (): Promise<string> =>
        new Promise<string>((res) => {
          resolve = () => {
            res("done");
          };
        }),
    };
    const wrapped = counter.wrap(asyncFake);

    const p = wrapped.fetchData();
    // Not yet settled — count should still be 0.
    expect(counter.count("fetchData")).toBe(0);
    resolve();
    await p;
    // Settled — count should be 1.
    expect(counter.count("fetchData")).toBe(1);
  });

  it("non-function properties pass through untouched", () => {
    const counter = new CallCounter();
    const obj = { label: "hello", value: 42 };
    const wrapped = counter.wrap(obj);
    expect(wrapped.label).toBe("hello");
    expect(wrapped.value).toBe(42);
  });

  it("return value is forwarded unchanged (sync)", () => {
    const counter = new CallCounter();
    const obj = { compute: (n: number) => n + 10 };
    const wrapped = counter.wrap(obj);
    expect(wrapped.compute(5)).toBe(15);
  });

  it("return value is forwarded unchanged (async)", async () => {
    const counter = new CallCounter();
    const obj = { fetch: (s: string) => Promise.resolve(`got:${s}`) };
    const wrapped = counter.wrap(obj);
    const result = await wrapped.fetch("x");
    expect(result).toBe("got:x");
    expect(counter.count("fetch")).toBe(1);
  });

  it("reset() clears all counts", () => {
    const counter = new CallCounter();
    const obj = { doThing: () => undefined };
    const wrapped = counter.wrap(obj);
    wrapped.doThing();
    wrapped.doThing();
    expect(counter.count("doThing")).toBe(2);
    counter.reset();
    expect(counter.count("doThing")).toBe(0);
  });

  it("snapshot() returns a plain object of all counts", () => {
    const counter = new CallCounter();
    const obj = { a: () => undefined, b: () => undefined };
    const wrapped = counter.wrap(obj);
    wrapped.a();
    wrapped.a();
    wrapped.b();
    const snap = counter.snapshot();
    expect(snap.a).toBe(2);
    expect(snap.b).toBe(1);
  });

  it("count() returns 0 for a method that was never called", () => {
    const counter = new CallCounter();
    expect(counter.count("neverCalled")).toBe(0);
  });
});
