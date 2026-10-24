import type { BoardSnapshot } from "./snapshot";
import type { ContextReceipt, VisualContext, VisualObservation } from "./observations";

export interface VisionDebug {
  revision: number; analyzedRevision: number | null; deliveredRevision: number | null;
  status: "idle" | "capturing" | "analyzing" | "delivering" | "current" | "cleared" | "error" | "off";
  description: string; error: string | null; discarded: number; queued: boolean;
  captureMs: number | null; requestMs: number | null; analysisMs: number | null; contextMs: number | null; totalMs: number | null;
  lastSuccessAt: number | null;
}
interface Options {
  capture: (revision: number, changedAt: number) => Promise<BoardSnapshot>;
  analyze: (frame: BoardSnapshot, previous: string, signal: AbortSignal) => Promise<{ observation: VisualObservation; analysisMs: number }>;
  deliver?: (context: VisualContext) => Promise<ContextReceipt>;
  onState: (state: VisionDebug) => void;
  now?: () => number;
  initialRevision?: number;
}
/** Event-driven: zero polling. One active capture/analysis/delivery, one pending
 * revision (not an image queue). Stroke-end debounce 120 ms, active strokes at
 * most every 350 ms. A result must still match the board before it is applied. */
export class WhiteboardVisionPipeline {
  private state: VisionDebug = { revision: 0, analyzedRevision: null, deliveredRevision: null, status: "idle", description: "", error: null, discarded: 0, queued: false, captureMs: null, requestMs: null, analysisMs: null, contextMs: null, totalMs: null, lastSuccessAt: null };
  private active = false; private dirty = false; private stopped = false; private invalidated = false;
  private timer: ReturnType<typeof setTimeout> | null = null; private dueAt = 0; private changedAt = 0; private lastStart = -Infinity;
  private strokeStart: number | null = null;
  private abort: AbortController | null = null;
  private cached: { fingerprint: string; observation: VisualObservation } | null = null;
  private now: () => number;
  constructor(private options: Options) { this.now = options.now ?? (() => performance.now()); this.state.revision = options.initialRevision ?? 0; }
  private publish(patch: Partial<VisionDebug>) { if (this.stopped) return; this.state = { ...this.state, ...patch }; this.options.onState({ ...this.state }); }
  snapshot() { return { ...this.state }; }
  change(kind: "intermediate" | "complete" | "clear" = "complete") {
    if (this.stopped) return;
    const revision = this.state.revision + 1;
    this.changedAt = this.now(); this.dirty = kind !== "clear";
    this.publish({ revision, description: "", error: null, queued: this.active && this.dirty });
    if (!this.invalidated || kind === "clear") {
      this.invalidated = kind !== "clear";
      const invalidatedAt = this.now();
      void this.options.deliver?.({ revision, status: kind === "clear" ? "cleared" : "pending" }).then(receipt => {
        if (kind === "clear" && receipt.accepted && this.state.revision === revision) this.publish({ deliveredRevision: revision, contextMs: this.now() - invalidatedAt,
          captureMs: 0, analysisMs: 0, requestMs: 0, totalMs: this.now() - this.changedAt, lastSuccessAt: Date.now() });
      }).catch(error => { if (this.state.revision === revision) this.publish({ error: error instanceof Error ? error.message : "Context invalidation failed." }); });
    }
    if (kind === "clear") {
      this.strokeStart = null;
      this.abort?.abort(); this.cached = null;
      if (this.timer) clearTimeout(this.timer); this.timer = null;
      this.publish({ status: "cleared", queued: false, description: "Board cleared." });
      return;
    }
    if (kind === "complete") { this.strokeStart = null; this.dueAt = this.now() + 120; }
    else {
      this.strokeStart ??= this.now();
      this.dueAt = Math.max(this.strokeStart + 350, this.lastStart + 350);
    }
    this.schedule();
  }
  private schedule() {
    if (this.active || this.stopped || !this.dirty) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = null; void this.run(); }, Math.max(0, this.dueAt - this.now()));
  }
  private async run() {
    if (this.active || this.stopped || !this.dirty) return;
    this.active = true; this.dirty = false; this.lastStart = this.now();
    const revision = this.state.revision, changedAt = this.changedAt;
    const abort = new AbortController(); this.abort = abort;
    try {
      this.publish({ status: "capturing", queued: false });
      const frame = await this.options.capture(revision, changedAt);
      if (this.stopped || revision !== this.state.revision) return;
      this.publish({ captureMs: frame.captureMs });
      let observation: VisualObservation;
      if (this.cached?.fingerprint === frame.fingerprint) { observation = { ...this.cached.observation, revision, changes: [] }; this.publish({ requestMs: 0, analysisMs: 0 }); }
      else {
        this.publish({ status: "analyzing" });
        const sentAt = this.now();
        const result = await this.options.analyze(frame, this.cached?.observation.description ?? "", abort.signal);
        if (this.stopped || abort.signal.aborted) return;
        this.cached = { fingerprint: frame.fingerprint, observation: result.observation };
        this.publish({ analyzedRevision: revision, requestMs: this.now() - sentAt, analysisMs: result.analysisMs });
        observation = { ...result.observation, revision };
      }
      if (revision !== this.state.revision) { this.publish({ discarded: this.state.discarded + 1 }); return; }
      this.publish({ status: "delivering" });
      const deliveredAt = this.now();
      // The observed update is now on its way. Any edit during its ACK window
      // must enqueue a NEW invalidation, even though the previous state was pending.
      this.invalidated = false;
      const receipt = await this.options.deliver?.({ revision, status: "observed", observation });
      if (this.stopped || revision !== this.state.revision || (receipt && !receipt.accepted)) return;
      this.invalidated = false;
      this.publish({ status: "current", description: observation.description, deliveredRevision: receipt ? revision : null,
        analyzedRevision: revision, contextMs: receipt ? this.now() - deliveredAt : null,
        totalMs: this.now() - changedAt, lastSuccessAt: Date.now(), error: null });
    } catch (error) {
      if (!this.stopped && !abort.signal.aborted && revision === this.state.revision) this.publish({ status: "error", error: error instanceof Error ? error.message : "Whiteboard analysis failed." });
    } finally {
      this.active = false; if (this.abort === abort) this.abort = null;
      if (!this.stopped && this.dirty) this.schedule();
    }
  }
  stop() {
    if (this.stopped) return;
    const revision = this.state.revision + 1;
    this.publish({ status: "off", revision, description: "", queued: false }); this.stopped = true;
    if (this.timer) clearTimeout(this.timer); this.abort?.abort();
    void this.options.deliver?.({ revision, status: "off" }).catch(() => {});
  }
}
