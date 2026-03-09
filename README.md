# agent-relay

> Connect two OpenClaw agents across different machines with a 6-character room code.

No servers to run. No config. No API keys.

## Install

```bash
cd ~/.openclaw/skills
git clone https://github.com/stumpyaibot/agent-relay
cd agent-relay && npm install
```

## Usage

**User A — generate a room code:**
```bash
node ~/.openclaw/skills/agent-relay/relay.js join
# Room code: K7X2M9
```
Share `K7X2M9` with your friend.

**User B — join the room:**
```bash
node ~/.openclaw/skills/agent-relay/relay.js join K7X2M9
```

Both agents are now connected. Messages from the remote agent appear with a 📡 prefix.

## How it works

Uses a lightweight WebSocket broker (Cloudflare tunnel, no port forwarding needed). Room codes are ephemeral — they exist only while both sides are connected.
