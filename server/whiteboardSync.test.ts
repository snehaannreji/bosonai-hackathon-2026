import { afterEach, describe, expect, it } from "vitest";
import express from "express";
import { createServer, type Server } from "node:http";
import { WebSocket } from "ws";
import { createWhiteboardSync } from "./whiteboardSync";

let server: Server | null = null; let sync: ReturnType<typeof createWhiteboardSync> | null = null;
afterEach(async () => { sync?.close(); sync = null; if (server) await new Promise<void>(resolve => server!.close(() => resolve())); server = null; });

async function fixture(ttl = 60_000) {
  const app = express(); app.use(express.json()); sync = createWhiteboardSync({ pairingTtlMs: ttl }); app.use("/api/whiteboard", sync.router);
  server = createServer(app); sync.attach(server); await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("No test port");
  return `http://127.0.0.1:${address.port}`;
}
async function pair(base: string, lessonId: string) {
  const ownerToken = sync!.authorizeLesson(lessonId);
  const response = await fetch(`${base}/api/whiteboard/pair`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ lessonId, ownerToken }) });
  expect(response.status).toBe(200); return response.json() as Promise<{ token: string; expiresAt: number; url: string }>;
}
function socketUrl(base: string, lessonId: string, token: string, client: string) { return `${base.replace("http", "ws")}/api/whiteboard/ws?session=${lessonId}&token=${token}&client=${client}`; }
function connect(url: string) {
  return new Promise<{ ws: WebSocket; first: Record<string, unknown> }>((resolve, reject) => { const ws = new WebSocket(url); ws.once("message", raw => resolve({ ws, first: JSON.parse(raw.toString()) })); ws.once("error", reject); });
}
function message(ws: WebSocket, type: string) { return new Promise<Record<string, unknown>>(resolve => { const receive = (raw: WebSocket.RawData) => { const value = JSON.parse(raw.toString()) as Record<string, unknown>; if (value.type === type) resolve(value); else ws.once("message", receive); }; ws.once("message", receive); }); }

describe("tablet whiteboard synchronization", () => {
  it("uses unpredictable per-lesson tokens and isolates restored board state", async () => {
    const base = await fixture(); const a = await pair(base, "lesson_alpha"); const b = await pair(base, "lesson_beta");
    expect(a.token).not.toBe(b.token); expect(a.token.length).toBeGreaterThan(25); expect(new URL(a.url).hash).toContain("token=");
    const one = await connect(socketUrl(base, "lesson_alpha", a.token, "computerA1")); const two = await connect(socketUrl(base, "lesson_alpha", a.token, "tabletA22"));
    const mark = { tool: "pen", color: "#dc2626", width: 4, points: [{ x: 10, y: 12 }, { x: 30, y: 40 }] };
    const received = message(two.ws, "replace"); one.ws.send(JSON.stringify({ type: "replace", operationId: "draw-1", marks: [mark] }));
    expect(await received).toMatchObject({ type: "replace", marks: [mark], source: "computerA1" });
    const isolated = await connect(socketUrl(base, "lesson_beta", b.token, "tabletB22")); expect(isolated.first).toMatchObject({ type: "snapshot", marks: [] }); isolated.ws.close();
    const restored = await connect(socketUrl(base, "lesson_alpha", a.token, "reconnectA")); expect(restored.first).toMatchObject({ type: "snapshot", marks: [mark] });
    one.ws.close(); two.ws.close(); restored.ws.close();
  });

  it("rejects expired links and revokes connected devices when a lesson ends", async () => {
    const base = await fixture(25); const ownerToken = sync!.authorizeLesson("lesson_secure");
    expect((await fetch(`${base}/api/whiteboard/pair`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ lessonId: "lesson_secure", ownerToken: "guessed-owner" }) })).status).toBe(403);
    const pairingResponse = await fetch(`${base}/api/whiteboard/pair`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ lessonId: "lesson_secure", ownerToken }) }); const paired = await pairingResponse.json() as { token: string };
    const joined = await connect(socketUrl(base, "lesson_secure", paired.token, "tabletSecure"));
    const closed = new Promise<number>(resolve => joined.ws.once("close", code => resolve(code)));
    expect((await fetch(`${base}/api/whiteboard/lesson_secure`, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ownerToken: "wrong" }) })).status).toBe(403);
    expect((await fetch(`${base}/api/whiteboard/lesson_secure`, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ownerToken }) })).status).toBe(204); expect(await closed).toBe(4001);
    await expect(connect(socketUrl(base, "lesson_secure", paired.token, "retrySecure"))).rejects.toThrow();
    const expiring = await pair(base, "lesson_expire"); await new Promise(resolve => setTimeout(resolve, 35));
    await expect(connect(socketUrl(base, "lesson_expire", expiring.token, "lateTablet"))).rejects.toThrow();
  });
});

it("seeds tablet pairing with the existing AI drawing and preserves IDs through edits", async () => {
  const base = await fixture(); const lessonId = "lesson_drawing"; const ownerToken = sync!.authorizeLesson(lessonId);
  const mark = { id: "ai-arrow", owner: "ai", tool: "arrow", color: "#2563eb", width: 3, points: [{ x: 10, y: 20 }, { x: 100, y: 200 }] };
  const response = await fetch(`${base}/api/whiteboard/pair`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ lessonId, ownerToken, initialMarks: [mark] }) });
  const paired = await response.json() as { token: string };
  const one = await connect(socketUrl(base, lessonId, paired.token, "computer11"));
  const two = await connect(socketUrl(base, lessonId, paired.token, "tablet2222"));
  expect(two.first.marks).toEqual([mark]);
  const receive = message(one.ws, "replace");
  const moved = { ...mark, points: [{ x: 20, y: 20 }, { x: 110, y: 200 }] };
  two.ws.send(JSON.stringify({ type: "replace", operationId: "manual-edit", marks: [moved] }));
  expect(await receive).toMatchObject({ marks: [moved] });
  one.ws.close(); two.ws.close();
});
