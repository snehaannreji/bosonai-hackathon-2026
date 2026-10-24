import type { ClientEvent, ServerEvent } from "../realtime/events";
import { parseVisualContext, visualInstructions, type ContextReceipt, type VisualContext } from "./observations";

interface Pending { context: VisualContext; instructions: string; resolve: (receipt: ContextReceipt) => void; reject: (error: Error) => void; started: number; timer?: ReturnType<typeof setTimeout> }
/** One acknowledged session.update plus one replaceable pending update.
 * Never appends teacher messages, creates responses, or touches audio settings. */
export class VisualContextChannel {
  private active: Pending | null = null;
  private queued: Pending | null = null;
  private newest = -1;
  private closed = false;
  constructor(private base: string, private send: (event: ClientEvent) => void | Promise<void>, private timeoutMs = 5000) {}
  update(input: VisualContext): Promise<ContextReceipt> {
    const context = parseVisualContext(input);
    if (this.closed) return Promise.reject(new Error("The conversation has ended."));
    if (context.revision < this.newest) return Promise.resolve({ revision: context.revision, accepted: false, ackMs: 0 });
    this.newest = context.revision;
    return new Promise((resolve, reject) => {
      const next = { context, instructions: visualInstructions(this.base, context), resolve, reject, started: performance.now() };
      if (this.active) {
        this.queued?.resolve({ revision: this.queued.context.revision, accepted: false, ackMs: 0 });
        this.queued = next;
      } else this.transmit(next);
    });
  }
  private transmit(next: Pending) {
    if (this.closed) return;
    this.active = next;
    next.timer = setTimeout(() => this.fail(next, new Error("Boson did not acknowledge the visual context update.")), this.timeoutMs);
    try {
      Promise.resolve(this.send({ type: "session.update", session: { instructions: next.instructions } }))
        .catch(() => this.fail(next, new Error("Could not deliver visual context.")));
    } catch { this.fail(next, new Error("Could not deliver visual context.")); }
  }
  handle(event: ServerEvent) {
    const active = this.active;
    const session = event.session as { instructions?: string } | undefined;
    if (active && event.type === "session.updated" && session?.instructions === active.instructions) {
      clearTimeout(active.timer); this.active = null;
      active.resolve({ revision: active.context.revision, accepted: active.context.revision === this.newest, ackMs: performance.now() - active.started });
      this.drain();
    }
  }
  private fail(next: Pending, error: Error) {
    if (this.active !== next) return;
    clearTimeout(next.timer); this.active = null; next.reject(error); this.drain();
  }
  private drain() { const next = this.queued; this.queued = null; if (next) this.transmit(next); }
  close() {
    this.closed = true;
    if (this.active) { clearTimeout(this.active.timer); this.active.reject(new Error("The conversation has ended.")); }
    this.queued?.reject(new Error("The conversation has ended."));
    this.active = null; this.queued = null;
  }
}
