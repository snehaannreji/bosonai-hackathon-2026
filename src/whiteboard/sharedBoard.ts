import type { Mark } from "./board";

export type SharedBoardStatus = "disconnected" | "connecting" | "connected" | "reconnecting" | "expired" | "error";
export interface PairingDetails { lessonId: string; token: string; expiresAt: number; url: string }
export interface SharedBoardCallbacks { onMarks: (marks: Mark[], complete: boolean) => void; onStatus?: (status: SharedBoardStatus) => void; onPeers?: (peers: number) => void }

const validMarks = (value: unknown): value is Mark[] => Array.isArray(value) && value.length <= 300 && value.every(mark => mark && typeof mark === "object" && Array.isArray((mark as Mark).points));
const clientId = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

export class SharedBoardClient {
  private socket: WebSocket | null = null;
  private connectionTimer: ReturnType<typeof setTimeout> | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;
  private attempts = 0;
  private readonly clientId = clientId().replace(/[^a-zA-Z0-9_-]/gu, "");
  constructor(private pairing: Pick<PairingDetails, "lessonId" | "token" | "expiresAt">, private callbacks: SharedBoardCallbacks) {}

  connect() {
    this.stopped = false; this.open(false);
  }
  private open(reconnecting: boolean) {
    if (this.stopped) return;
    if (Date.now() >= this.pairing.expiresAt) { this.callbacks.onStatus?.("expired"); return; }
    this.callbacks.onStatus?.(reconnecting ? "reconnecting" : "connecting");
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const url = new URL("/api/whiteboard/ws", `${protocol}//${location.host}`);
    url.searchParams.set("session", this.pairing.lessonId); url.searchParams.set("token", this.pairing.token); url.searchParams.set("client", this.clientId);
    const socket = new WebSocket(url); this.socket = socket;
    this.connectionTimer = setTimeout(() => {
      if (this.socket !== socket || socket.readyState !== WebSocket.CONNECTING) return;
      socket.close();
    }, 4000);
    socket.onopen = () => {
      if (this.socket !== socket) return;
      if (this.connectionTimer) clearTimeout(this.connectionTimer);
      this.connectionTimer = null; this.attempts = 0; this.callbacks.onStatus?.("connected");
    };
    socket.onmessage = event => {
      if (this.socket !== socket) return;
      let message: { type?: string; marks?: unknown; source?: string; peers?: unknown };
      try { message = JSON.parse(String(event.data)); } catch { return; }
      if (typeof message.peers === "number") this.callbacks.onPeers?.(message.peers);
      if ((message.type === "snapshot" || message.type === "replace" || message.type === "preview") && message.source !== this.clientId && validMarks(message.marks)) this.callbacks.onMarks(message.marks, message.type !== "preview");
    };
    socket.onerror = () => { if (this.socket === socket) this.callbacks.onStatus?.("error"); };
    socket.onclose = event => {
      if (this.socket !== socket) return;
      if (this.connectionTimer) clearTimeout(this.connectionTimer);
      this.connectionTimer = null; this.socket = null;
      if (this.stopped || event.code === 4001) { this.callbacks.onStatus?.("disconnected"); return; }
      if (Date.now() >= this.pairing.expiresAt || event.code === 1008) { this.callbacks.onStatus?.("expired"); return; }
      this.callbacks.onStatus?.("reconnecting");
      const delay = Math.min(1500, 100 * 2 ** this.attempts++); this.retry = setTimeout(() => this.open(true), delay);
    };
  }
  send(marks: Mark[], complete: boolean) {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify({ type: complete ? "replace" : "preview", marks, operationId: complete ? clientId() : undefined }));
  }
  close() {
    this.stopped = true; if (this.retry) clearTimeout(this.retry); this.retry = null;
    if (this.connectionTimer) clearTimeout(this.connectionTimer); this.connectionTimer = null;
    this.socket?.close(1000, "Device disconnected"); this.socket = null; this.callbacks.onStatus?.("disconnected");
  }
}

export async function createWhiteboardPairing(lessonId: string, ownerToken: string): Promise<PairingDetails> {
  const response = await fetch("/api/whiteboard/pair", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ lessonId, ownerToken }) });
  const body = await response.json(); if (!response.ok) throw new Error(body.error ?? "Could not create tablet pairing.");
  return body;
}

export async function revokeWhiteboardPairing(lessonId: string, ownerToken: string) {
  await fetch(`/api/whiteboard/${encodeURIComponent(lessonId)}`, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ownerToken }), keepalive: true });
}
