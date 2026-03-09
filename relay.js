#!/usr/bin/env node
/**
 * OpenClaw Agent Relay
 *
 * Connects two OpenClaw agents across different machines via a shared room code.
 *
 * Usage:
 *   node relay.js join [room-code]   — join a room (creates code if omitted)
 *   node relay.js send <room> <msg>  — send a message to the room
 *   node relay.js leave              — disconnect
 *   node relay.js status             — check if connected
 *
 * Environment:
 *   RELAY_BROKER_URL   Override the broker WebSocket URL
 */

"use strict";

const { WebSocket } = require("ws");
const { createHmac } = require("crypto");
const fs   = require("fs");
const path = require("path");
const os   = require("os");
const { execSync, spawn } = require("child_process");

// ─── Paths ────────────────────────────────────────────────────────────────────

const OPENCLAW_DIR  = path.join(os.homedir(), ".openclaw");
const PID_FILE      = path.join(OPENCLAW_DIR, "relay-pid");
const ROOM_FILE     = path.join(OPENCLAW_DIR, "relay-room");
const SESSION_FILE  = path.join(OPENCLAW_DIR, "relay-session");
const BROKER_URL_FILE = path.join(OPENCLAW_DIR, "workspace", "relay", "broker-url.txt");
const IDENTITY_FILE = path.join(OPENCLAW_DIR, "workspace", "IDENTITY.md");

// ─── Broker URL ───────────────────────────────────────────────────────────────

function getBrokerUrl() {
  if (process.env.RELAY_BROKER_URL) return process.env.RELAY_BROKER_URL;
  try {
    const lines = fs.readFileSync(BROKER_URL_FILE, "utf8").trim().split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("wss://") || trimmed.startsWith("ws://")) return trimmed;
    }
  } catch {}
  return "wss://openclaw-relay-broker.onrender.com";
}

// ─── Agent name ───────────────────────────────────────────────────────────────

function getAgentName() {
  try {
    const content = fs.readFileSync(IDENTITY_FILE, "utf8");
    // Match "- **Name:** Stumpy" or "- Name: Stumpy" or "Name: Stumpy"
    const match = content.match(/[-*]\s*\*{0,2}Name\*{0,2}:\**\s*(.+)/i)
      || content.match(/^Name:\s*(.+)/im);
    if (match) return match[1].replace(/\*/g, "").trim();
  } catch {}
  return os.hostname().split(".")[0];
}

// ─── Room code generation ─────────────────────────────────────────────────────

function generateRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no ambiguous chars
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

// ─── Auth token ───────────────────────────────────────────────────────────────

function makeAuthToken(room) {
  const ts    = Math.floor(Date.now() / 30000);
  const token = createHmac("sha256", room).update(`${room}:${ts}`).digest("hex");
  return token;
}

// ─── Deliver message to local OpenClaw agent ─────────────────────────────────

function deliverToAgent(from, message) {
  const formatted = `📡 [${from}]: ${message}`;

  // 1. Try to find the right session key dynamically
  let sessionKey = null;
  try {
    const stored = fs.readFileSync(SESSION_FILE, "utf8").trim();
    if (stored) sessionKey = stored;
  } catch {}

  if (!sessionKey) {
    // Look up the most recent active direct telegram session
    try {
      const raw = execSync("openclaw sessions list --json 2>/dev/null || openclaw sessions list", {
        timeout: 5000, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
      });
      // Try to parse JSON array
      const parsed = JSON.parse(raw);
      const sessions = Array.isArray(parsed) ? parsed : (parsed.sessions || []);
      // Prefer direct telegram sessions
      const telegramDirect = sessions.filter(s =>
        s.id && s.id.includes(":telegram:direct:")
      );
      if (telegramDirect.length > 0) {
        // Sort by most recently active
        telegramDirect.sort((a, b) => (b.lastActive || 0) - (a.lastActive || 0));
        sessionKey = telegramDirect[0].id;
      } else if (sessions.length > 0) {
        sessions.sort((a, b) => (b.lastActive || 0) - (a.lastActive || 0));
        sessionKey = sessions[0].id;
      }
    } catch (listErr) {
      // Couldn't parse, will fall through to openclaw message send
    }
  }

  // 2. If we have a session key, use sessions send
  if (sessionKey) {
    try {
      execSync(
        `openclaw sessions send --session ${JSON.stringify(sessionKey)} --message ${JSON.stringify(formatted)}`,
        { timeout: 15000, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }
      );
      console.log(`[relay] ✓ Delivered via sessions send (${sessionKey})`);
      return;
    } catch (e) {
      console.error(`[relay] sessions send failed: ${e.message}`);
    }
  }

  // 3. Fallback: openclaw message send (detects channel from config)
  try {
    execSync(
      `openclaw message send --channel telegram --message ${JSON.stringify(formatted)}`,
      { timeout: 15000, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }
    );
    console.log("[relay] ✓ Delivered via message send");
    return;
  } catch (e) {
    console.error(`[relay] message send failed: ${e.message}`);
  }

  // 4. Last resort: just print to stdout (visible in logs)
  console.log(`[relay] UNDELIVERED: ${formatted}`);
}

// ─── FILE helpers ─────────────────────────────────────────────────────────────

function writePid(pid) {
  fs.mkdirSync(OPENCLAW_DIR, { recursive: true });
  fs.writeFileSync(PID_FILE, String(pid));
}
function writeRoom(room) {
  fs.mkdirSync(OPENCLAW_DIR, { recursive: true });
  fs.writeFileSync(ROOM_FILE, room);
}
function clearState() {
  try { fs.unlinkSync(PID_FILE); } catch {}
  try { fs.unlinkSync(ROOM_FILE); } catch {}
}

// ─── WebSocket daemon (join mode) ─────────────────────────────────────────────

function runDaemon(room, agentName, brokerUrl) {
  let ws = null;
  let stopping = false;
  let reconnectDelay = 1000;
  const MAX_DELAY = 30000;
  let joined = false;

  function connect() {
    if (stopping) return;

    console.log(`[relay] Connecting to broker...`);
    ws = new WebSocket(brokerUrl);

    ws.on("open", () => {
      reconnectDelay = 1000;
      console.log(`[relay] Connected. Joining room '${room}' as '${agentName}'...`);
      const timestamp = Date.now();
      const token = createHmac("sha256", room)
        .update(`${room}:${timestamp}`)
        .digest("hex");
      ws.send(JSON.stringify({ type: "join", room, from: agentName, timestamp, token }));
    });

    ws.on("message", (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      switch (msg.type) {
        case "joined":
          joined = true;
          console.log(`[relay] ✅ Joined room '${room}'. Members: ${(msg.members || []).join(", ")}`);
          writePid(process.pid);
          writeRoom(room);
          break;

        case "message":
          console.log(`[relay] Message from '${msg.from}': ${msg.message}`);
          deliverToAgent(msg.from, msg.message);
          break;

        case "presence":
          if (msg.event === "joined") {
            deliverToAgent("relay-system", `Agent '${msg.from}' joined room '${room}'.`);
          } else if (msg.event === "left" || msg.event === "disconnected") {
            deliverToAgent("relay-system", `Agent '${msg.from}' left room '${room}'.`);
          }
          break;

        case "error":
          console.error(`[relay] Server error: ${msg.message}`);
          break;
      }
    });

    ws.on("close", (code) => {
      joined = false;
      if (stopping) {
        console.log("[relay] Disconnected cleanly.");
        return;
      }
      console.log(`[relay] Disconnected (code ${code}). Reconnecting in ${reconnectDelay / 1000}s...`);
      setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, MAX_DELAY);
    });

    ws.on("error", (err) => {
      console.error(`[relay] Connection error: ${err.message}`);
    });
  }

  // Keepalive
  setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "ping", timestamp: Date.now() }));
    }
  }, 25000);

  // Graceful shutdown
  function shutdown() {
    stopping = true;
    clearState();
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify({ type: "leave", room, from: agentName, timestamp: Date.now() }));
        ws.close(1000);
      } catch {}
    }
    setTimeout(() => process.exit(0), 500);
  }
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  connect();
}

// ─── Commands ─────────────────────────────────────────────────────────────────

const cmd  = process.argv[2];
const arg1 = process.argv[3];
const arg2 = process.argv.slice(4).join(" ");

switch (cmd) {

  // ── join ──────────────────────────────────────────────────────────────────
  case "join": {
    const room      = (arg1 || generateRoomCode()).toUpperCase().trim();
    const agentName = getAgentName();
    const brokerUrl = getBrokerUrl();

    // Kill any existing relay daemon
    try {
      const oldPid = parseInt(fs.readFileSync(PID_FILE, "utf8").trim(), 10);
      if (!isNaN(oldPid)) process.kill(oldPid, "SIGTERM");
    } catch {}

    console.log(`\n🔗 OpenClaw Agent Relay`);
    console.log(`   Room code: ${room}`);
    console.log(`   Agent:     ${agentName}`);
    console.log(`   Broker:    ${brokerUrl}\n`);
    console.log(`📋 Share this code with the other agent: ${room}`);
    console.log(`   They run: node relay.js join ${room}\n`);

    // Spawn self as a detached background process (daemon)
    const child = spawn(process.execPath, [__filename, "_daemon", room, agentName, brokerUrl], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();

    writePid(child.pid);
    writeRoom(room);

    console.log(`✅ Relay started in background (PID ${child.pid})`);
    console.log(`   To disconnect: node relay.js leave\n`);
    process.exit(0);
    break;
  }

  // ── _daemon (internal: actual background process) ─────────────────────────
  case "_daemon": {
    const room      = process.argv[3];
    const agentName = process.argv[4];
    const brokerUrl = process.argv[5];
    // Redirect stdout/stderr to log file
    const logPath = path.join(OPENCLAW_DIR, "relay.log");
    const logStream = fs.createWriteStream(logPath, { flags: "a" });
    process.stdout.write = (d) => logStream.write(d);
    process.stderr.write = (d) => logStream.write(d);
    runDaemon(room, agentName, brokerUrl);
    break;
  }

  // ── send ──────────────────────────────────────────────────────────────────
  case "send": {
    if (!arg1) {
      console.error("Usage: node relay.js send <room-code> <message>");
      process.exit(1);
    }

    // arg1 is room, arg2 is message (or check if arg1 looks like a room code)
    let room, message;
    if (arg2) {
      room    = arg1.toUpperCase().trim();
      message = arg2;
    } else {
      // Try to use the stored room
      try {
        room = fs.readFileSync(ROOM_FILE, "utf8").trim();
        message = arg1;
      } catch {
        console.error("Usage: node relay.js send <room-code> <message>");
        process.exit(1);
      }
    }

    const agentName = getAgentName();
    const brokerUrl = getBrokerUrl();

    const ws = new WebSocket(brokerUrl);
    ws.on("open", () => {
      const timestamp = Date.now();
      const token = createHmac("sha256", room)
        .update(`${room}:${timestamp}`)
        .digest("hex");
      ws.send(JSON.stringify({ type: "join", room, from: agentName, timestamp, token }));
    });

    let sent = false;
    ws.on("message", (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if ((msg.type === "joined" || msg.type === "ack") && !sent) {
        sent = true;
        ws.send(JSON.stringify({
          type: "message", room, from: agentName, message, timestamp: Date.now(),
        }));
        console.log(`✅ Sent to room '${room}': ${message}`);
        setTimeout(() => { ws.close(); process.exit(0); }, 800);
      }
    });

    ws.on("error", (err) => {
      console.error(`❌ Send failed: ${err.message}`);
      process.exit(1);
    });

    setTimeout(() => {
      console.error("❌ Timed out waiting for broker connection");
      process.exit(1);
    }, 10000);
    break;
  }

  // ── leave ─────────────────────────────────────────────────────────────────
  case "leave": {
    try {
      const pid = parseInt(fs.readFileSync(PID_FILE, "utf8").trim(), 10);
      if (!isNaN(pid)) {
        process.kill(pid, "SIGTERM");
        console.log(`✅ Relay stopped (PID ${pid})`);
      } else {
        console.log("No relay daemon running.");
      }
    } catch {
      console.log("No relay daemon running.");
    }
    clearState();
    break;
  }

  // ── status ────────────────────────────────────────────────────────────────
  case "status": {
    try {
      const pid  = parseInt(fs.readFileSync(PID_FILE, "utf8").trim(), 10);
      const room = fs.readFileSync(ROOM_FILE, "utf8").trim();
      // Check if process is alive
      process.kill(pid, 0);
      console.log(`✅ Connected — room: ${room}, PID: ${pid}`);
    } catch {
      console.log("❌ Not connected (no active relay daemon)");
    }
    break;
  }

  // ── help / default ────────────────────────────────────────────────────────
  default: {
    console.log(`
OpenClaw Agent Relay

USAGE:
  node relay.js join [room-code]     Connect to a room (generates code if not given)
  node relay.js send <room> <msg>    Send a message to the room
  node relay.js leave                Disconnect
  node relay.js status               Check connection status

EXAMPLES:
  node relay.js join               → generates code, prints it, starts listening
  node relay.js join K7X2M9        → join room K7X2M9
  node relay.js send K7X2M9 "Hi!"  → send a message to room K7X2M9
  node relay.js leave              → stop the background daemon

Environment:
  RELAY_BROKER_URL   Override the broker WebSocket URL
`);
    process.exit(cmd ? 1 : 0);
  }
}
