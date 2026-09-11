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

export type PingMessage = { type: "ping"; t: number };
export type PongMessage = { type: "pong"; t: number };

export type Message =
  | HelloMessage
  | WelcomeMessage
  | PeersMessage
  | TransferMessage
  | AckMessage
  | PingMessage
  | PongMessage;

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
