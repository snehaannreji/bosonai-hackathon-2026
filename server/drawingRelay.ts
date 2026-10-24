import { randomUUID } from "node:crypto";
import type { DrawingResult } from "../src/whiteboard/drawingTools";

/** Application transport only: Boson still uses standard function_call_output.
 * No response is continued until the visible browser acknowledges the command. */
export class DrawingRelay {
  private pending = new Map<string, { resolve: (value: DrawingResult) => void; timer: ReturnType<typeof setTimeout> }>();
  constructor(private publish: (request: { kind: string; requestId: string; name: string; args: Record<string, unknown> }) => void, private timeoutMs = 5000) {}
  execute = (name: string, args: Record<string, unknown>): Promise<DrawingResult> => new Promise(resolve => {
    const requestId = randomUUID();
    const timer = setTimeout(() => this.finish(requestId, { error: "board_timeout", summary: "Whiteboard did not acknowledge. Inspect the board before retrying." }), this.timeoutMs);
    this.pending.set(requestId, { resolve, timer });
    this.publish({ kind: "drawing_request", requestId, name, args });
  });
  finish(requestId: string, result: DrawingResult): boolean {
    const pending = this.pending.get(requestId); if (!pending) return false;
    clearTimeout(pending.timer); this.pending.delete(requestId); pending.resolve(result); return true;
  }
  cancel() {
    for (const id of this.pending.keys()) this.finish(id, { error: "interrupted", summary: "Drawing interrupted. Inspect current board before continuing." });
  }
}
