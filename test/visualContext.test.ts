import { afterEach, describe, expect, it, vi } from "vitest";
import { VisualContextChannel } from "../src/whiteboard/contextChannel";
import { parseVisualContext } from "../src/whiteboard/observations";
import type { ClientEvent } from "../src/realtime/events";
afterEach(() => vi.useRealTimers());
describe("silent visual-context delivery", () => {
  it("changes instructions only, preserves the persona, and resolves only on the matching Boson ACK", async () => {
    const send = vi.fn(); const channel = new VisualContextChannel("You are Kai. Keep learning.", send);
    const receipt = channel.update({ revision: 1, status: "pending" });
    expect(send).toHaveBeenCalledOnce();
    const event = send.mock.calls[0][0]; expect(event.type).toBe("session.update");
    expect(Object.keys(event.session)).toEqual(["instructions"]);
    expect(event.session.instructions).toContain("You are Kai. Keep learning.");
    expect(event.session.instructions).toContain("conversational memory is historical");
    channel.handle({ type: "session.updated", session: { instructions: "unrelated" } });
    channel.handle({ type: "session.updated", session: event.session });
    expect(await receipt).toMatchObject({ accepted: true, revision: 1 }); channel.close();
  });
  it("coalesces queued updates, rejects lower revisions and never sends response.create", async () => {
    const events: ClientEvent[] = []; const channel = new VisualContextChannel("persona", e => { events.push(e); });
    const one = channel.update({ revision: 1, status: "pending" });
    const two = channel.update({ revision: 2, status: "pending" });
    const three = channel.update({ revision: 3, status: "cleared" });
    expect((await two).accepted).toBe(false); expect(events).toHaveLength(1);
    channel.handle({ type: "session.updated", session: events[0].session });
    expect((await one).accepted).toBe(false); expect(events).toHaveLength(2);
    channel.handle({ type: "session.updated", session: events[1].session });
    expect((await three).accepted).toBe(true);
    expect((await channel.update({ revision: 2, status: "pending" })).accepted).toBe(false);
    expect(events.every(e => e.type === "session.update")).toBe(true); channel.close();
  });
  it("does not claim delivery if the ACK never arrives", async () => {
    vi.useFakeTimers(); const channel = new VisualContextChannel("persona", vi.fn(), 100);
    const result = channel.update({ revision: 1, status: "pending" });
    const rejected = expect(result).rejects.toThrow("did not acknowledge");
    await vi.advanceTimersByTimeAsync(100); await rejected; channel.close();
  });
  it("bounds and validates observations instead of trusting model/client revision fields", () => {
    expect(() => parseVisualContext({ revision: -1, status: "observed" })).toThrow();
    expect(() => parseVisualContext({ revision: 1, status: "observed", observation: { description: "x" } })).toThrow();
    const value = parseVisualContext({ revision: 9, status: "observed", observation: { revision: 500, description: "fixture", changes: [], visible_text: [], uncertainties: [] } });
    expect(value.observation?.revision).toBe(9);
  });
});
