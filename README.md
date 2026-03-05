# @virtue-ai/gateway-connect

One-command setup to connect [OpenClaw](https://github.com/openclaw/openclaw) to the VirtueAI MCP gateway. Works with **any model** — Anthropic, OpenAI, Google, LiteLLM, etc.

## Quick Start

### Step 1: Install OpenClaw

```bash
npm install -g openclaw@latest
```

### Step 2: Configure Model Auth

Set up API key for your preferred model provider:

```bash
openclaw models auth paste-token --provider anthropic
# or
openclaw models auth paste-token --provider openai
```

### Step 3: Connect to VirtueAI MCP Gateway

```bash
npx @virtue-ai/gateway-connect --gateway-url https://virtueai-agent-gtw-xxxx.ngrok.io
```

This will:

1. Open your browser for OAuth login
2. Fetch all MCP tools from the gateway
3. Generate a native OpenClaw plugin wrapping each tool (`~/.openclaw/extensions/virtueai-mcp-tools/`)
4. Patch `~/.openclaw/openclaw.json` to enable the plugin
5. Install the trajectory recording plugin

### Step 4: Start Using

One-shot mode:

```bash
openclaw agent --local --message "What tools do you have?"
```

Interactive TUI mode:

```bash
# Terminal 1: start the OpenClaw gateway
openclaw gateway --allow-unconfigured

# Terminal 2: open the TUI
openclaw tui
```

To stop the gateway, press `Ctrl+C` in Terminal 1, or run:

```bash
openclaw gateway stop
```

### Switching Models

In TUI mode, use slash commands to switch models on the fly:

```
/model openai/gpt-4o
/model anthropic/claude-opus-4-6
/models                              # opens model picker
```

All gateway tools remain available regardless of which model you use. Any model with a configured API key can be selected.

## What It Does

`gateway-connect` generates a **native OpenClaw plugin** that registers every MCP gateway tool via `api.registerTool()`. Each tool call is proxied to the gateway as a JSON-RPC `tools/call` request with Bearer auth.

This approach works with any embedded model provider (not just Claude CLI), because the tools are part of OpenClaw's plugin system rather than being passed via `--mcp-config`.

### Generated Files

| Path | Purpose |
|------|---------|
| `~/.openclaw/extensions/virtueai-mcp-tools/` | Native plugin with all gateway tools |
| `~/.openclaw/extensions/virtueai-trajectory/` | Trajectory recording plugin |
| `~/.openclaw/mcp-gateway.json` | Auth & trajectory config |
| `~/.openclaw/openclaw.json` | Patched with plugin entries |

## Options

```
npx @virtue-ai/gateway-connect [options]

Options:
  --gateway-url <url>    Gateway URL (default: https://virtueai-agent-gtw-l3phon63.ngrok.io)
  --model <model>        Model to use (e.g. openai/gpt-4o, anthropic/claude-sonnet-4-5)
  --guard-uuid <uuid>    Guard UUID for trajectory recording (or set VIRTUEAI_GUARD_UUID)
  --help                 Show help message
```

## Re-authentication

If your token expires, just run the command again. It will regenerate the plugin with a fresh token.

## License

MIT
