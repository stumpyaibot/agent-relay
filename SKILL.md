---
name: agent-relay
description: Connects two OpenClaw agents across different machines using a shared 6-character room code. No servers, no config, no API keys. Use when the user wants to talk to another OpenClaw user's agent, set up a cross-instance agent relay, share a room code to link agents, or receive messages from a remote agent. Messages from the remote agent appear in chat with a 📡 prefix.
---

# Agent Relay

Connect your agent to another OpenClaw user's agent using a shared room code. Both sides run one command — done.

## Quick Start

**You (User A):**
```bash
node ~/.openclaw/skills/agent-relay/scripts/relay.js join
# Output: Room code: K7X2M9
```
Share `K7X2M9` with the other person (text, WhatsApp, whatever).

**Them (User B):**
```bash
node ~/.openclaw/skills/agent-relay/scripts/relay.js join K7X2M9
```
Both agents are now connected.

## Commands

```bash
# Join a room (generate code)
node relay.js join

# Join a specific room
node relay.js join K7X2M9

# Send a message to the room
node relay.js send K7X2M9 "Hello from the other side!"

# Check if connected
node relay.js status

# Disconnect
node relay.js leave
```

Script path: `~/.openclaw/skills/agent-relay/scripts/relay.js`

## Agent Instructions

**To help the user join a relay room:**
Run `node ~/.openclaw/skills/agent-relay/scripts/relay.js join` (no room code = generates one).
Tell the user the room code and ask them to share it with the other person.

**To send a message to the remote agent:**
Run `node ~/.openclaw/skills/agent-relay/scripts/relay.js send <ROOMCODE> "<message>"`

**To check if connected:**
Run `node ~/.openclaw/skills/agent-relay/scripts/relay.js status`
Or check if `~/.openclaw/relay-pid` exists with a live PID.

**To disconnect:**
Run `node ~/.openclaw/skills/agent-relay/scripts/relay.js leave`

## Incoming Messages

When the remote agent sends a message, it appears in the user's chat as:
```
📡 [AgentName]: their message here
```
The `📡` prefix means it's from the relay. Reply normally — the agent will use the send command to relay the response back.

## Notes

- Room codes are 6 chars, uppercase alphanumeric — share via any channel
- The relay daemon runs in the background; logs go to `~/.openclaw/relay.log`
- Reconnects automatically with exponential backoff (max 30s)
- Broker URL is read from `~/.openclaw/workspace/relay/broker-url.txt` if present, otherwise defaults to `wss://openclaw-relay.onrender.com`
- Override broker: `RELAY_BROKER_URL=wss://... node relay.js join`
