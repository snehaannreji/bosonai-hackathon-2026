/** Scheduling fixtures only; these are NOT claimed as real vision outputs. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WhiteboardVisionPipeline } from "../src/whiteboard/visionPipeline";
import type { VisualContext, VisualObservation } from "../src/whiteboard/observations";
import type { BoardSnapshot } from "../src/whiteboard/snapshot";

const observation = (revision: number): VisualObservation => ({ revision, description: `fixture revision ${revision}`, changes: [], visible_text: [], uncertainties: [] });
const frame = (revision: number, changedAt: number): BoardSnapshot => ({ revision, changedAt, captureMs: 4, fingerprint: String(revision), image: "fixture-bytes" });
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);
function fixture(overrides = {}) {
  const capture = vi.fn(async (r: number, t: number) => frame(r, t));
  const analyze = vi.fn(async (f: BoardSnapshot, _p: string, _s: AbortSignal) => ({ observation: observation(f.revision), analysisMs: 50 }));
  const contexts: VisualContext[] = [];
  const deliver = vi.fn(async (context: VisualContext) => { contexts.push(context); return { revision: context.revision, accepted: true, ackMs: 5 }; });
  const pipeline = new WhiteboardVisionPipeline({ capture, analyze, deliver, onState: vi.fn(), now: () => Date.now(), ...overrides });
  return { pipeline, capture, analyze, deliver, contexts };
}
describe("event-driven latest-frame-wins whiteboard", () => {
  it("captures after 120 ms from stroke end without waiting for a polling interval", async () => {
    const f = fixture(); f.pipeline.change("complete");
    await tick(119); expect(f.capture).not.toHaveBeenCalled();
    await tick(1); expect(f.capture).toHaveBeenCalledOnce();
    expect(f.pipeline.snapshot()).toMatchObject({ status: "current", deliveredRevision: 1 });
    f.pipeline.stop();
  });
  it("captures intermediate states of a long stroke at 350 ms and coalesces point edits", async () => {
    const f = fixture(); f.pipeline.change("intermediate");
    for (let i = 0; i < 6; i++) { await tick(50); f.pipeline.change("intermediate"); }
    expect(f.capture).not.toHaveBeenCalled();
    await tick(50); expect(f.capture).toHaveBeenCalledOnce();
    expect(f.capture.mock.calls[0][0]).toBe(7);
    f.pipeline.stop();
  });
  it("holds only the newest pending revision and discards outdated completed analyses", async () => {
    let finish!: (value: { observation: VisualObservation; analysisMs: number }) => void;
    const analyze = vi.fn((_f: BoardSnapshot) => new Promise<{ observation: VisualObservation; analysisMs: number }>(r => { finish = r; }));
    const f = fixture({ analyze }); f.pipeline.change(); await tick(120);
    for (let i = 0; i < 20; i++) f.pipeline.change();
    expect(f.capture).toHaveBeenCalledOnce(); expect(analyze).toHaveBeenCalledOnce();
    finish({ observation: observation(1), analysisMs: 500 }); await tick(120);
    expect(f.capture.mock.calls.map(c => c[0])).toEqual([1, 21]);
    expect(f.contexts.filter(c => c.status === "observed")).toHaveLength(0);
    finish({ observation: observation(21), analysisMs: 500 }); await tick(0);
    expect(f.pipeline.snapshot()).toMatchObject({ deliveredRevision: 21, discarded: 1 });
    f.pipeline.stop();
  });
  it("clear invalidates immediately and blocks late, uncancellable results", async () => {
    let finish!: (value: { observation: VisualObservation; analysisMs: number }) => void;
    const f = fixture({ analyze: () => new Promise(r => { finish = r; }) });
    f.pipeline.change(); await tick(120); f.pipeline.change("clear");
    expect(f.contexts.at(-1)).toMatchObject({ revision: 2, status: "cleared" });
    finish({ observation: observation(1), analysisMs: 500 }); await tick(0);
    expect(f.pipeline.snapshot()).toMatchObject({ status: "cleared", description: "Board cleared." });
    expect(f.contexts.some(c => c.status === "observed")).toBe(false);
    f.pipeline.change(); expect(f.contexts.at(-1)).toMatchObject({ revision: 3, status: "pending" });
    f.pipeline.stop();
  });
  it("invalidates an observed context even when a new edit occurs during delivery ACK", async () => {
    let acknowledge!: () => void;
    const contexts: VisualContext[] = [];
    const f = fixture({ deliver: async (c: VisualContext) => {
      contexts.push(c);
      if (c.status === "observed") await new Promise<void>(r => { acknowledge = r; });
      return { revision: c.revision, accepted: true, ackMs: 5 };
    } });
    f.pipeline.change(); await tick(120);
    expect(contexts.at(-1)?.status).toBe("observed");
    f.pipeline.change(); expect(contexts.at(-1)).toMatchObject({ revision: 2, status: "pending" });
    acknowledge(); await tick(0);
    expect(f.pipeline.snapshot().deliveredRevision).toBeNull(); f.pipeline.stop();
  });
  it("deduplicates identical pixels while advancing the current observation revision", async () => {
    const f = fixture({ capture: async (r: number, t: number) => ({ ...frame(r, t), fingerprint: "same-pixels" }) });
    f.pipeline.change(); await tick(120); f.pipeline.change(); await tick(120);
    expect(f.analyze).toHaveBeenCalledOnce();
    expect(f.pipeline.snapshot()).toMatchObject({ deliveredRevision: 2, requestMs: 0, analysisMs: 0 });
    f.pipeline.stop();
  });
  it("does not overwrite a newer clear with an old failure and keeps revisions across restarts", async () => {
    const f = fixture({ initialRevision: 80, analyze: async () => { throw new Error("provider failed"); } });
    f.pipeline.change(); await tick(120); expect(f.pipeline.snapshot()).toMatchObject({ revision: 81, status: "error" });
    f.pipeline.stop(); expect(f.contexts.at(-1)).toMatchObject({ revision: 82, status: "off" });
    await tick(5000); expect(f.capture).toHaveBeenCalledOnce();
  });
});
