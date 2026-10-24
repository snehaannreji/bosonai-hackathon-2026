import { createHash, randomBytes } from "node:crypto";
import { networkInterfaces } from "node:os";
import type { Server as HttpServer, IncomingMessage } from "node:http";
import { Router, type Request } from "express";
import { WebSocket, WebSocketServer } from "ws";

export const PAIRING_TTL_MS = 10 * 60 * 1000;
const MAX_MARKS = 300;
const MAX_MESSAGE_BYTES = 900_000;

type Point = { x: number; y: number };
type Mark = { id?: string; owner?: "ai" | "user"; tool: string; color: string; width: number; points: Point[]; text?: string };
type Peer = { socket: WebSocket; clientId: string };
type Session = { token: string; tokenHash: string; expiresAt: number; marks: Mark[]; revision: number; peers: Set<Peer>; operations: Set<string> };

const sessions = new Map<string, Session>();
const owners = new Map<string, string>();
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const validId = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9_-]{6,160}$/u.test(value);
const validClient = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9_-]{8,80}$/u.test(value);
const validMarks = (value: unknown): value is Mark[] => Array.isArray(value) && value.length <= MAX_MARKS && value.every(mark => {
  if (!mark || typeof mark !== "object") return false;
  const item = mark as Partial<Mark>;
  return ["pen", "eraser", "line", "arrow", "rectangle", "circle", "text"].includes(item.tool ?? "")
    && (item.id === undefined || (typeof item.id === "string" && /^[a-zA-Z0-9_-]{1,64}$/u.test(item.id)))
    && (item.owner === undefined || item.owner === "ai" || item.owner === "user")
    && typeof item.color === "string" && /^#[0-9a-f]{6}$/iu.test(item.color)
    && typeof item.width === "number" && item.width >= 1 && item.width <= 20
    && Array.isArray(item.points) && item.points.length <= 2000
    && item.points.every(point => Number.isFinite(point?.x) && Number.isFinite(point?.y) && point.x >= 0 && point.x <= 640 && point.y >= 0 && point.y <= 480)
    && (item.text === undefined || (typeof item.text === "string" && item.text.length <= 500));
});

function localAddress(): string | null {
  const candidates = Object.entries(networkInterfaces()).flatMap(([name, entries]) => (entries ?? [])
    .filter(item => item.family === "IPv4" && !item.internal)
    .map(item => ({ name, address: item.address })));
  const isPrivateLan = (address: string) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/u.test(address);
  const isWifi = (name: string) => /wi[- ]?fi|wireless|wlan/iu.test(name);
  const isVirtual = (name: string) => /virtual|vethernet|vpn|loopback|docker|wsl|hyper-v|tailscale|wireguard|vmware|virtualbox|bluetooth|tap|tun|bridge/iu.test(name);
  const wifi = candidates.filter(item => isWifi(item.name));
  const physical = candidates.filter(item => !isVirtual(item.name));
  return wifi.find(item => isPrivateLan(item.address))?.address
    ?? wifi[0]?.address
    ?? physical.find(item => isPrivateLan(item.address))?.address
    ?? physical[0]?.address
    ?? candidates[0]?.address
    ?? null;
}

function publicOrigin(req: Request): string {
  const configured = process.env.PUBLIC_APP_URL?.trim().replace(/\/$/u, "");
  if (configured) return configured;
  const forwardedHost = req.get("x-forwarded-host") ?? req.get("host") ?? "localhost:5173";
  const forwardedProto = req.get("x-forwarded-proto") ?? req.protocol;
  if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/u.test(forwardedHost)) return `${forwardedProto}://${forwardedHost}`;
  return `http://${localAddress() ?? "localhost"}:${process.env.DEV_CLIENT_PORT ?? "5173"}`;
}

function peerCount(session: Session) {
  return [...session.peers].filter(peer => peer.socket.readyState === WebSocket.OPEN).length;
}

function broadcast(session: Session, payload: object, except?: WebSocket) {
  const text = JSON.stringify(payload);
  for (const peer of session.peers) if (peer.socket !== except && peer.socket.readyState === WebSocket.OPEN) peer.socket.send(text);
}

function announcePeers(session: Session) {
  broadcast(session, { type: "presence", peers: peerCount(session) });
}

export function createWhiteboardSync({ pairingTtlMs = PAIRING_TTL_MS }: { pairingTtlMs?: number } = {}) {
  const router = Router();
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });

  router.post("/pair", (req, res) => {
    const lessonId = req.body?.lessonId;
    if (!validId(lessonId)) return res.status(400).json({ error: "Invalid whiteboard lesson." });
    if (typeof req.body?.ownerToken !== "string" || owners.get(lessonId) !== hash(req.body.ownerToken)) return res.status(403).json({ error: "This browser does not own the whiteboard lesson." });
    if (req.body?.initialMarks !== undefined && !validMarks(req.body.initialMarks)) return res.status(400).json({ error: "Invalid initial board." });
    let session = sessions.get(lessonId);
    if (!session) {
      const token = randomBytes(24).toString("base64url");
      session = { token, tokenHash: hash(token), expiresAt: Date.now() + pairingTtlMs, marks: req.body.initialMarks ?? [], revision: 0, peers: new Set(), operations: new Set() };
      sessions.set(lessonId, session);
    }
    const url = new URL("/tablet", publicOrigin(req));
    url.searchParams.set("session", lessonId);
    url.hash = new URLSearchParams({ token: session.token, expires: String(session.expiresAt) }).toString();
    return res.json({ lessonId, token: session.token, expiresAt: session.expiresAt, url: url.toString() });
  });

  router.delete("/:lessonId", (req, res) => {
    if (typeof req.body?.ownerToken !== "string" || owners.get(req.params.lessonId) !== hash(req.body.ownerToken)) return res.status(403).json({ error: "This browser does not own the whiteboard lesson." });
    const session = sessions.get(req.params.lessonId);
    if (session) {
      for (const peer of session.peers) peer.socket.close(4001, "Whiteboard session ended");
      sessions.delete(req.params.lessonId);
    }
    owners.delete(req.params.lessonId);
    return res.status(204).end();
  });

  const handleUpgrade = (request: IncomingMessage, socket: import("node:stream").Duplex, head: Buffer) => {
    const url = new URL(request.url ?? "", `http://${request.headers.host ?? "localhost"}`);
    if (url.pathname !== "/api/whiteboard/ws") return false;
    const lessonId = url.searchParams.get("session"); const token = url.searchParams.get("token"); const clientId = url.searchParams.get("client");
    const session = lessonId ? sessions.get(lessonId) : undefined;
    if (!session || !token || !validClient(clientId) || session.expiresAt <= Date.now() || hash(token) !== session.tokenHash) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n"); socket.destroy(); return true;
    }
    wss.handleUpgrade(request, socket, head, ws => {
      const peer = { socket: ws, clientId }; session.peers.add(peer);
      ws.send(JSON.stringify({ type: "snapshot", marks: session.marks, revision: session.revision, peers: peerCount(session) })); announcePeers(session);
      ws.on("message", raw => {
        let event: { type?: string; marks?: unknown; operationId?: unknown };
        try { event = JSON.parse(raw.toString()); } catch { return; }
        if ((event.type !== "replace" && event.type !== "preview") || !validMarks(event.marks)) return;
        if (event.type === "replace") {
          if (typeof event.operationId !== "string" || event.operationId.length > 100 || session.operations.has(event.operationId)) return;
          session.operations.add(event.operationId); if (session.operations.size > 1000) session.operations.delete(session.operations.values().next().value!);
          session.marks = event.marks; session.revision++;
        }
        broadcast(session, { type: event.type, marks: event.marks, revision: session.revision, source: clientId }, ws);
      });
      ws.on("close", () => { session.peers.delete(peer); announcePeers(session); });
    });
    return true;
  };

  const attach = (server: HttpServer) => server.on("upgrade", (request, socket, head) => { if (!handleUpgrade(request, socket, head)) socket.destroy(); });
  const authorizeLesson = (lessonId: string) => { const ownerToken = randomBytes(24).toString("base64url"); owners.set(lessonId, hash(ownerToken)); return ownerToken; };
  return { router, attach, authorizeLesson, close: () => { for (const session of sessions.values()) for (const peer of session.peers) peer.socket.close(1001); wss.close(); sessions.clear(); owners.clear(); }, sessions };
}
