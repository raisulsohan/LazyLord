#!/usr/bin/env node
/**
 * LazyLord bridge (stand-alone)
 * -----------------------------
 * The relay normally runs inside the first LazyLord panel opened in
 * Photoshop, Illustrator or After Effects, so nothing needs starting. This
 * runs the same relay on its own, for development and troubleshooting
 * (start-bridge.bat). If a panel already serves the port, it says so and exits.
 */

import { DEFAULT_BRIDGE_PORT } from "@lazylord/core";
import { startRelay } from "./relay";

const PORT = Number(process.env.LAZYLORD_PORT || DEFAULT_BRIDGE_PORT);
const HOSTS = process.env.LAZYLORD_HOST ? [process.env.LAZYLORD_HOST] : ["127.0.0.1", "::1"];
const EXTRA_ORIGINS = (process.env.LAZYLORD_ALLOW_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);

function log(...args: unknown[]) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[lazylord ${ts}]`, ...args);
}

startRelay({ port: PORT, hosts: HOSTS, allowOrigins: EXTRA_ORIGINS, log }).then(
  (relay) => {
    log("waiting for Figma and Adobe clients…");
    process.on("SIGINT", () => {
      log("shutting down");
      relay.close().then(() => process.exit(0));
    });
  },
  (err: NodeJS.ErrnoException) => {
    if (err && err.code === "EADDRINUSE") {
      log(`port ${PORT} is already served — most likely by a LazyLord panel, which runs the bridge itself. Nothing to do.`);
      process.exit(0);
    }
    log("server error:", (err && err.message) || String(err));
    process.exit(1);
  }
);
