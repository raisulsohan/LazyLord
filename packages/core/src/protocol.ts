/**
 * LazyLord transfer protocol
 * ------------------------
 * Small JSON message envelope used on the bridge WebSocket. Both the Figma
 * plugin and the Adobe CEP panels connect to the same bridge and identify a
 * role; the bridge relays `transfer` payloads from Figma to Adobe clients.
 */

import type { Document, Diagnostic } from "./ir";

export const DEFAULT_BRIDGE_PORT = 7878;
export const PROTOCOL_VERSION = 1;

export type Role = "figma" | "photoshop" | "illustrator" | "aftereffects" | "unknown";

/** Sent by a client immediately after connecting. */
export type HelloMessage = {
  type: "hello";
  protocol: number;
  role: Role;
  /** Human-friendly client label, e.g. "After Effects 24.0". */
  client: string;
};

/** Bridge -> client, in response to hello. */
export type WelcomeMessage = {
  type: "welcome";
  protocol: number;
  /** Roles currently connected (so a UI can show who's listening). */
  peers: Role[];
};

/** Bridge -> all clients when the peer set changes. */
export type PeersMessage = {
  type: "peers";
  peers: Role[];
};

/** Figma -> bridge -> Adobe: the actual design payload. */
export type TransferMessage = {
  type: "transfer";
  id: string;
  /** Optional target; when omitted, all Adobe clients receive it. */
  target?: Role;
  document: Document;
};

/** Adobe -> bridge -> Figma: result of a transfer. */
export type AckMessage = {
  type: "ack";
  id: string;
  from: Role;
  ok: boolean;
  message?: string;
  /** Number of layers created on the host, when ok. */
  layersCreated?: number;
  /** Objects the host could not rebuild natively. */
  diagnostics?: Diagnostic[];
};

/**
 * One piece of a transfer too large to send in one message (images travel as
 * base64 and can pass the bridge's 100 MB frame limit). The sender splits the
 * TransferMessage's JSON into `total` pieces sent in order; the bridge relays
 * them to the same targets as the transfer; the receiver joins `data` in
 * `index` order and handles the result as the TransferMessage it was. The ack
 * comes back under the transfer's `id` as usual.
 */
export type ChunkMessage = {
  type: "chunk";
  id: string;
  target?: Role;
  index: number;
  total: number;
  data: string;
};

/**
 * A question for another app, answered by a ReplyMessage with the same id.
 * "active-document": what document is open, and where it is saved
 * (answered by Photoshop, for the After Effects panel's PSD import).
 */
export type RequestMessage = {
  type: "request";
  id: string;
  target: Role;
  what: "active-document";
};

/** The answer to a RequestMessage, routed back to whoever asked. */
export type ReplyMessage = {
  type: "reply";
  id: string;
  from: Role;
  ok: boolean;
  message?: string;
  /** For "active-document": { name, path, saved } — path is "" when never saved. */
  data?: { name?: string; path?: string; saved?: boolean };
};

export type PingMessage = { type: "ping"; t: number };
export type PongMessage = { type: "pong"; t: number };

export type Message =
  | HelloMessage
  | WelcomeMessage
  | PeersMessage
  | TransferMessage
  | ChunkMessage
  | AckMessage
  | RequestMessage
  | ReplyMessage
  | PingMessage
  | PongMessage;

/** A transfer whose JSON is longer than this (in characters) is sent in chunks. */
export const CHUNK_THRESHOLD = 4 * 1024 * 1024;
/** Characters per chunk. */
export const CHUNK_SIZE = 1024 * 1024;
/** A transfer whose pieces stop arriving for this long is dropped. */
export const CHUNK_TIMEOUT_MS = 2 * 60 * 1000;

/** The messages to send for a transfer: itself, or its chunks when it is large. */
export function chunkTransfer(
  msg: TransferMessage,
  size: number = CHUNK_SIZE,
  threshold: number = CHUNK_THRESHOLD
): Array<TransferMessage | ChunkMessage> {
  const text = JSON.stringify(msg);
  if (text.length <= threshold) return [msg];
  const total = Math.ceil(text.length / size);
  const out: ChunkMessage[] = [];
  for (let i = 0; i < total; i++) {
    out.push({ type: "chunk", id: msg.id, target: msg.target, index: i, total, data: text.slice(i * size, (i + 1) * size) });
  }
  return out;
}

/** Joins chunks back into transfers, whatever order they arrive in. */
export class ChunkJoiner {
  private readonly open = new Map<string, { total: number; got: number; data: string[]; at: number }>();

  /** Add one chunk; returns the whole transfer once its last piece is in, else null. */
  add(c: ChunkMessage, now: number = Date.now()): TransferMessage | null {
    for (const [id, rec] of this.open) if (now - rec.at > CHUNK_TIMEOUT_MS) this.open.delete(id);
    if (!c || typeof c.id !== "string" || !(c.total > 0) || !(c.index >= 0 && c.index < c.total)) return null;
    let rec = this.open.get(c.id);
    if (!rec || rec.total !== c.total) {
      rec = { total: c.total, got: 0, data: new Array(c.total), at: now };
      this.open.set(c.id, rec);
    }
    rec.at = now;
    if (rec.data[c.index] === undefined) rec.got++;
    rec.data[c.index] = String(c.data || "");
    if (rec.got < rec.total) return null;
    this.open.delete(c.id);
    try {
      const msg = JSON.parse(rec.data.join(""));
      return msg && msg.type === "transfer" ? (msg as TransferMessage) : null;
    } catch {
      return null;
    }
  }
}

export function isMessage(x: unknown): x is Message {
  return !!x && typeof x === "object" && typeof (x as any).type === "string";
}

export function roleLabel(role: Role): string {
  switch (role) {
    case "figma":
      return "Figma";
    case "photoshop":
      return "Photoshop";
    case "illustrator":
      return "Illustrator";
    case "aftereffects":
      return "After Effects";
    default:
      return "Unknown";
  }
}
