# @virtue-ai/gateway-connect

One-command setup to connect [OpenClaw](https://github.com/openclaw/openclaw) to the VirtueAI MCP gateway.

## Quick Start

### Step 1: Install OpenClaw

```bash
npm install -g openclaw@latest
```

Make sure you have [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and logged in (`claude` command should work).

### Step 2: Connect to VirtueAI MCP Gateway

```bash
npx @virtue-ai/gateway-connect --gateway-url https://virtueai-agent-gtw-xxxx.ngrok.io
```

This will:

1. Open your browser for OAuth login (select "Authorize the platform")
2. Save gateway credentials to `~/.openclaw/mcp-gateway.json`
3. Patch `~/.openclaw/openclaw.json` to connect claude-cli to the gateway
4. Verify connection and list available tools

### Step 3: Start Using

```bash
openclaw agent --local --session-id demo --message "What tools do you have?"
```

That's it. OpenClaw now has access to all MCP tools on the gateway (GitHub, Google Workspace, Gmail, Calendar, Slack, PayPal, HR, Firebase, BigQuery, Brave Search, Chrome DevTools, and more).

## What It Does

`gateway-connect` automates the following:

1. **OAuth 2.0 PKCE authentication** — Registers an OAuth client, opens browser for login, exchanges authorization code for tokens
2. **MCP config generation** — Writes `~/.openclaw/mcp-gateway.json` with gateway URL and bearer token
3. **OpenClaw config patching** — Adds `--mcp-config` to the claude-cli backend args in `~/.openclaw/openclaw.json`
4. **Connection verification** — Calls `tools/list` on the gateway and reports available tools

## Options

```
npx @virtue-ai/gateway-connect [options]

Options:
  --gateway-url <url>  Gateway URL (required)
  --help               Show help message
```

## Re-authentication

If your token expires, just run the command again. It will update the existing config files.

## License

MIT
