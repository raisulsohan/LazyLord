/**
 * LazyLord relay
 * --------------
 * The WebSocket relay between the Figma plugin and the Adobe panels. It keeps
 * no design state — it tracks who is connected and forwards transfers, pieces
 * of large transfers, acknowledgements, requests and replies to the right
 * peers.
 *
 * It runs in two places: inside an Adobe panel (the first LazyLord panel to
 * open hosts it, bundled to packages/adobe-cep/js/relay.js), and as the
 * stand-alone bridge (server.ts) for development and troubleshooting.
 */

import { WebSocketServer, WebSocket, RawData } from "ws";
import {
  DEFAULT_BRIDGE_PORT,
  PROTOCOL_VERSION,
  Message,
  Role,
  countLeaves,
  isMessage,
  roleLabel,
} from "@lazylord/core";

export type RelayOptions = {
  port?: number;
  /**
   * Loopback addresses to listen on. The Figma plugin must connect to
   * "localhost" (Figma's manifest rejects IP addresses), which some Windows
   * machines resolve to ::1 before 127.0.0.1, so both by default — never the network.
   */
  hosts?: string[];
  /** More Origins to admit, for development. */
  allowOrigins?: string[];
  log?: (...args: unknown[]) => void;
};

export type Relay = {
  port: number;
  /** The addresses actually listened on. */
  hosts: string[];
  /** How many clients are connected. */
  clientCount(): number;
  close(): Promise<void>;
};

/**
 * Who may connect. Listening on loopback keeps the network out, but not a web
 * page open in the user's browser, which can open a WebSocket to localhost too
 * and would then receive transfers or push files into the panels. Browsers
 * always send an Origin header; LazyLord's own clients send none a web page
 * can have: the Figma plugin UI is a sandboxed iframe (Origin "null"), a CEP
 * panel is a file:// page, and Node tools send no Origin at all.
 */
export function originAllowed(origin: string | undefined, extra: string[] = []): boolean {
  if (!origin || origin === "null") return true;
  if (/^file:/i.test(origin)) return true;
  return extra.indexOf(origin) >= 0;
}

type Client = {
  socket: WebSocket;
  role: Role;
  label: string;
  alive: boolean;
};

/** Drop routing records older than this (the sender is long gone). */
const ORIGIN_TTL_MS = 5 * 60 * 1000;

/**
 * Start a relay. Resolves once it listens on the first host; rejects when that
 * port is taken (EADDRINUSE: another panel, or the stand-alone bridge, already
 * serves it) or cannot be opened. A failure on a further host (IPv6 switched
 * off) is logged and the relay carries on.
 */
export function startRelay(opts: RelayOptions = {}): Promise<Relay> {
  const port = opts.port || DEFAULT_BRIDGE_PORT;
  const hosts = opts.hosts && opts.hosts.length ? opts.hosts : ["127.0.0.1", "::1"];
  const extra = opts.allowOrigins || [];
  const log = opts.log || (() => {});

  const clients = new Set<Client>();
  /** transfer / request id -> the client that sent it, so answers go back to it. */
  const transferOrigins = new Map<string, { client: Client; at: number }>();
  /** chunked transfer id -> who sent it and who receives its pieces (fixed at piece 0). */
  const chunkTargets = new Map<string, { from: Client; targets: Client[]; at: number }>();
  const servers: WebSocketServer[] = [];
  const listening: string[] = [];

  function pruneOrigins() {
    const cutoff = Date.now() - ORIGIN_TTL_MS;
    for (const [id, rec] of transferOrigins) {
      if (rec.at < cutoff || !clients.has(rec.client)) transferOrigins.delete(id);
    }
    for (const [id, rec] of chunkTargets) {
      if (rec.at < cutoff || !clients.has(rec.from)) chunkTargets.delete(id);
    }
  }

  function currentPeers(): Role[] {
    const roles = new Set<Role>();
    for (const c of clients) roles.add(c.role);
    return Array.from(roles);
  }

  function send(socket: WebSocket, msg: Message) {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
  }

  function broadcastPeers() {
    const peers = currentPeers();
    for (const c of clients) send(c.socket, { type: "peers", peers });
  }

  /** Who receives a transfer: the named app, or everyone but the sender. */
  function targetsFor(sender: Client, target: Role | undefined): Client[] {
    return [...clients].filter((c) => {
      if (c === sender) return false; // never echo to the sender
      if (target && target !== "unknown") return c.role === target;
      return true;
    });
  }

  function notConnected(target: Role | undefined): string {
    return target
      ? `${roleLabel(target)} is not connected. Open the LazyLord panel there first.`
      : "No receiving app is connected. Open the LazyLord panel in Photoshop, Illustrator or After Effects, or the plugin in Figma.";
  }

  function onConnection(socket: WebSocket) {
    const client: Client = { socket, role: "unknown", label: "unknown", alive: true };
    clients.add(client);

    socket.on("message", (data: RawData) => {
      let msg: Message;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        log("dropped non-JSON message");
        return;
      }
      if (!isMessage(msg)) return;
      handleMessage(client, msg);
    });
    socket.on("pong", () => {
      client.alive = true;
    });
    socket.on("close", () => {
      clients.delete(client);
      log(`disconnected: ${client.label} (${roleLabel(client.role)})`);
      broadcastPeers();
    });
    socket.on("error", () => {
      /* handled by close */
    });
  }

  function handleMessage(client: Client, msg: Message) {
    switch (msg.type) {
      case "hello": {
        client.role = msg.role;
        client.label = msg.client || roleLabel(msg.role);
        log(`connected: ${client.label} (${roleLabel(client.role)})`);
        send(client.socket, { type: "welcome", protocol: PROTOCOL_VERSION, peers: currentPeers() });
        broadcastPeers();
        break;
      }

      case "chunk": {
        // A large transfer in pieces, relayed to the targets the first piece
        // found, so an app connecting half-way never gets a tail it cannot join.
        let targets: Client[];
        if (msg.index === 0) {
          targets = targetsFor(client, msg.target);
          log(`transfer ${msg.id}: ${msg.total} chunk(s) from ${roleLabel(client.role)} -> ${targets.length} host(s)`);
          if (targets.length === 0) {
            send(client.socket, { type: "ack", id: msg.id, from: "unknown", ok: false, message: notConnected(msg.target) });
            return;
          }
          pruneOrigins();
          transferOrigins.set(msg.id, { client, at: Date.now() });
          chunkTargets.set(msg.id, { from: client, targets, at: Date.now() });
        } else {
          const rec = chunkTargets.get(msg.id);
          if (!rec || rec.from !== client) return; // its first piece never came through here
          targets = rec.targets.filter((t) => clients.has(t));
        }
        for (const t of targets) send(t.socket, msg);
        if (msg.index >= msg.total - 1) chunkTargets.delete(msg.id);
        break;
      }

      case "transfer": {
        const targets = targetsFor(client, msg.target);
        // Leaves, not top-level entries: a Figma frame arrives as one group.
        const layerCount = countLeaves(msg.document?.layers);
        log(`transfer ${msg.id}: ${layerCount} layer(s) from ${roleLabel(client.role)} -> ${targets.length} host(s)`);
        if (targets.length === 0) {
          send(client.socket, { type: "ack", id: msg.id, from: "unknown", ok: false, message: notConnected(msg.target) });
          return;
        }
        pruneOrigins();
        transferOrigins.set(msg.id, { client, at: Date.now() });
        for (const t of targets) send(t.socket, msg);
        break;
      }

      case "ack": {
        const origin = transferOrigins.get(msg.id);
        if (origin && clients.has(origin.client)) {
          send(origin.client.socket, msg);
        } else {
          // Unknown transfer (relay restarted, or sender gone): tell every
          // client that can display a result.
          for (const c of clients) if (c !== client) send(c.socket, msg);
        }
        transferOrigins.delete(msg.id);
        log(`ack ${msg.id} from ${roleLabel(msg.from)}: ${msg.ok ? "ok" : "failed"}${msg.message ? " — " + msg.message : ""}`);
        break;
      }

      case "request": {
        // A question for one app (the AE panel asking Photoshop for its document):
        // routed like a transfer, answered like an ack.
        const targets = targetsFor(client, msg.target);
        if (targets.length === 0) {
          send(client.socket, { type: "reply", id: msg.id, from: "unknown", ok: false, message: notConnected(msg.target) });
          return;
        }
        pruneOrigins();
        transferOrigins.set(msg.id, { client, at: Date.now() });
        send(targets[0].socket, msg);
        break;
      }

      case "reply": {
        const origin = transferOrigins.get(msg.id);
        if (origin && clients.has(origin.client)) send(origin.client.socket, msg);
        transferOrigins.delete(msg.id);
        break;
      }

      case "ping": {
        send(client.socket, { type: "pong", t: msg.t });
        break;
      }

      default:
        break;
    }
  }

  // Heartbeat: drop dead sockets.
  const heartbeat = setInterval(() => {
    for (const c of clients) {
      if (!c.alive) {
        c.socket.terminate();
        clients.delete(c);
        continue;
      }
      c.alive = false;
      try {
        c.socket.ping();
      } catch {
        /* ignore */
      }
    }
  }, 15000);
  // Never the reason a process (or a panel's Node context) stays up.
  if (typeof (heartbeat as any).unref === "function") (heartbeat as any).unref();

  function closeAll(): Promise<void> {
    clearInterval(heartbeat);
    for (const c of clients) {
      try {
        c.socket.terminate();
      } catch {
        /* already gone */
      }
    }
    clients.clear();
    return Promise.all(servers.map((s) => new Promise<void>((res) => s.close(() => res())))).then(() => undefined);
  }

  function listen(host: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const wss = new WebSocketServer({
        port,
        host,
        verifyClient: (info: { origin?: string }) => {
          const ok = originAllowed(info.origin, extra);
          if (!ok) log(`refused a connection from ${info.origin} (not a LazyLord client)`);
          return ok;
        },
      });
      const shown = host.includes(":") ? `[${host}]` : host;
      wss.once("listening", () => {
        listening.push(host);
        log(`bridge listening on ws://${shown}:${port}`);
        resolve();
      });
      wss.once("error", (err) => reject(err));
      wss.on("connection", onConnection);
      servers.push(wss);
    });
  }

  return listen(hosts[0]).then(
    async () => {
      for (const host of hosts.slice(1)) {
        try {
          await listen(host);
        } catch (err) {
          // IPv6 may be switched off; the first listener alone still serves everyone.
          log(`${host} unavailable (${(err as Error).message}); continuing on ${hosts[0]} only`);
        }
      }
      return {
        port,
        hosts: listening.slice(),
        clientCount: () => clients.size,
        close: closeAll,
      };
    },
    (err) => {
      clearInterval(heartbeat);
      for (const s of servers) {
        try {
          s.close();
        } catch {
          /* never listened */
        }
      }
      throw err;
    }
  );
}
