#!/usr/bin/env node
/**
 * LazyLord bridge
 * -------------
 * A tiny WebSocket relay so the Figma plugin (which can only reach localhost
 * from its UI iframe) can hand design payloads to the Adobe CEP panels, and
 * so Adobe can send acknowledgements back.
 *
 * It keeps no design state — it just tracks who is connected and forwards
 * `transfer` / `ack` messages to the right peers.
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

type Client = {
  socket: WebSocket;
  role: Role;
  label: string;
  alive: boolean;
};

const PORT = Number(process.env.LAZYLORD_PORT || DEFAULT_BRIDGE_PORT);
const HOST = process.env.LAZYLORD_HOST || "127.0.0.1";

const clients = new Set<Client>();

/**
 * transfer id -> the client that sent it, so acknowledgements go back to the
 * originator. Figma is no longer the only thing that can start a transfer.
 */
const transferOrigins = new Map<string, { client: Client; at: number }>();

/** Drop origin records older than this (the sender is long gone). */
const ORIGIN_TTL_MS = 5 * 60 * 1000;

function pruneOrigins() {
  const cutoff = Date.now() - ORIGIN_TTL_MS;
  for (const [id, rec] of transferOrigins) {
    if (rec.at < cutoff || !clients.has(rec.client)) transferOrigins.delete(id);
  }
}

function log(...args: unknown[]) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[lazylord ${ts}]`, ...args);
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

/**
 * The Figma plugin must connect to "localhost" (Figma's manifest rejects IP
 * addresses), which some Windows machines resolve to ::1 before 127.0.0.1.
 * So by default listen on both loopback addresses — never on the network.
 */
const HOSTS = process.env.LAZYLORD_HOST ? [HOST] : ["127.0.0.1", "::1"];
const servers: WebSocketServer[] = [];

for (const host of HOSTS) {
  const wss = new WebSocketServer({ port: PORT, host });
  const shown = host.includes(":") ? `[${host}]` : host;

  wss.on("listening", () => {
    log(`bridge listening on ws://${shown}:${PORT}`);
    if (host === HOSTS[0]) log("waiting for Figma and Adobe clients…");
  });

  wss.on("error", (err) => {
    // IPv6 may be switched off; the IPv4 listener alone still serves everyone.
    if (host === "::1" && HOSTS.length > 1) {
      log(`IPv6 loopback unavailable (${(err as Error).message}); continuing on 127.0.0.1 only`);
      return;
    }
    log("server error:", (err as Error).message);
    process.exit(1);
  });

  wss.on("connection", onConnection);
  servers.push(wss);
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

    case "transfer": {
      const targets = [...clients].filter((c) => {
        if (c === client) return false; // never echo to the sender
        if (c.role === "figma") return false; // Figma has no receive path yet
        if (msg.target && msg.target !== "unknown") return c.role === msg.target;
        return true; // broadcast to all Adobe clients
      });
      // Leaves, not top-level entries: a Figma frame arrives as one group.
      const layerCount = countLeaves(msg.document?.layers);
      const from = roleLabel(client.role);
      log(`transfer ${msg.id}: ${layerCount} layer(s) from ${from} -> ${targets.length} host(s)`);
      if (targets.length === 0) {
        send(client.socket, {
          type: "ack",
          id: msg.id,
          from: "unknown",
          ok: false,
          message: msg.target
            ? `${roleLabel(msg.target)} is not connected. Open the LazyLord panel there first.`
            : "No receiving app is connected. Open the LazyLord panel in Photoshop, Illustrator or After Effects.",
        });
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
        // Unknown transfer (bridge restarted, or sender gone): fall back to
        // telling every client that can display a result.
        for (const c of clients) {
          if (c !== client) send(c.socket, msg);
        }
      }
      transferOrigins.delete(msg.id);
      log(`ack ${msg.id} from ${roleLabel(msg.from)}: ${msg.ok ? "ok" : "failed"}${msg.message ? " — " + msg.message : ""}`);
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

process.on("SIGINT", () => {
  log("shutting down");
  clearInterval(heartbeat);
  for (const wss of servers) wss.close();
  process.exit(0);
});
