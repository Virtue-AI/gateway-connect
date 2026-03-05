#!/usr/bin/env node
/**
 * VirtueAI Gateway Connect
 *
 * One-command setup to connect OpenClaw to VirtueAI MCP gateway.
 *
 * 1. OAuth 2.0 PKCE login → obtain access token
 * 2. Fetch all MCP tools from the gateway
 * 3. Generate a native OpenClaw plugin that wraps each tool (works with any model)
 * 4. Patch ~/.openclaw/openclaw.json to enable the plugin
 * 5. Install trajectory recording plugin
 *
 * Usage: npx @virtue-ai/gateway-connect [--gateway-url https://...]
 */

import crypto from 'crypto';
import { execSync } from 'child_process';
import fs from 'fs';
import http from 'http';
import https from 'https';
import os from 'os';
import path from 'path';
import { URL } from 'url';

import { generateTrajectoryPlugin, enableTrajectoryPlugin } from './trajectory-plugin.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CALLBACK_PORT = 19876;
const CALLBACK_PATH = '/callback';
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`;
const DEFAULT_SCOPES = 'claudeai copilot mcp:read mcp:execute mcp:access';

const OPENCLAW_DIR = path.join(os.homedir(), '.openclaw');
const MCP_CONFIG_PATH = path.join(OPENCLAW_DIR, 'mcp-gateway.json');
const OPENCLAW_CONFIG_PATH = path.join(OPENCLAW_DIR, 'openclaw.json');
const TOOLS_PLUGIN_ID = 'virtueai-mcp-tools';
const TOOLS_PLUGIN_DIR = path.join(OPENCLAW_DIR, 'extensions', TOOLS_PLUGIN_ID);

const DEFAULT_GATEWAY_URL = 'https://virtueai-agent-gtw-l3phon63.ngrok.io';
const DEFAULT_API_URL = 'https://agentgateway1.virtueai.io';
const DEFAULT_GATEWAY_ID = 'gtw_L3pHOn63';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getArg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx !== -1 ? process.argv[idx + 1] : undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function fetchJson(
  url: string,
  options: { method?: string; headers?: Record<string, string>; body?: string },
): Promise<{ status: number; data: any }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const mod = parsed.protocol === 'https:' ? https : http;
    const req = mod.request(
      parsed,
      {
        method: options.method ?? 'GET',
        headers: {
          ...(options.body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
          ...(options.headers ?? {}),
        },
      },
      (res) => {
        let body = '';
        res.on('data', (chunk: Buffer) => (body += chunk.toString()));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode ?? 0, data: JSON.parse(body) });
          } catch {
            resolve({ status: res.statusCode ?? 0, data: body });
          }
        });
      },
    );
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

function generateCodeVerifier(): string {
  return crypto.randomBytes(32).toString('base64url');
}

function generateCodeChallenge(verifier: string): string {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

function openBrowser(url: string): void {
  const platform = process.platform;
  try {
    if (platform === 'darwin') {
      execSync(`open "${url}"`);
    } else if (platform === 'linux') {
      execSync(`xdg-open "${url}" 2>/dev/null || sensible-browser "${url}" 2>/dev/null || echo ""`);
    } else {
      execSync(`start "" "${url}"`);
    }
  } catch {
    // Silently fail — we always print the URL below
  }
}

// ---------------------------------------------------------------------------
// Step 1: OAuth PKCE Authentication
// ---------------------------------------------------------------------------

async function authenticate(gatewayUrl: string): Promise<{
  accessToken: string;
  refreshToken?: string;
  clientId: string;
}> {
  console.log('  Discovering OAuth endpoints...');
  const { data: metadata } = await fetchJson(
    `${gatewayUrl}/.well-known/oauth-authorization-server`,
    { method: 'GET', headers: { Accept: 'application/json' } },
  );

  if (!metadata.authorization_endpoint || !metadata.token_endpoint) {
    console.error('Error: Could not discover OAuth endpoints from gateway.');
    console.error('Response:', JSON.stringify(metadata, null, 2));
    process.exit(1);
  }

  const authEndpoint: string = metadata.authorization_endpoint;
  const tokenEndpoint: string = metadata.token_endpoint;
  const registerEndpoint: string = metadata.registration_endpoint;
  const scopes: string = metadata.scopes_supported
    ? metadata.scopes_supported.join(' ')
    : DEFAULT_SCOPES;

  console.log(`  Auth endpoint: ${authEndpoint}`);
  console.log(`  Token endpoint: ${tokenEndpoint}`);
  console.log(`  Scopes: ${scopes}`);

  console.log('  Registering OAuth client...');
  const { status: regStatus, data: clientInfo } = await fetchJson(registerEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'openclaw-gateway-connect',
      grant_types: ['authorization_code', 'refresh_token'],
      redirect_uris: [REDIRECT_URI],
      scope: scopes,
      token_endpoint_auth_method: 'none',
    }),
  });

  if (!clientInfo.client_id) {
    console.error(`Error: Client registration failed (${regStatus}).`);
    console.error(JSON.stringify(clientInfo, null, 2));
    process.exit(1);
  }

  const clientId: string = clientInfo.client_id;
  console.log(`  Client ID: ${clientId}`);

  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
  const state = crypto.randomBytes(16).toString('hex');

  const authUrl = new URL(authEndpoint);
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('redirect_uri', REDIRECT_URI);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', scopes);
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('code_challenge', codeChallenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');

  const authCode = await new Promise<string>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (!req.url?.startsWith(CALLBACK_PATH)) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }

      const url = new URL(req.url, `http://localhost:${CALLBACK_PORT}`);
      const code = url.searchParams.get('code');
      const returnedState = url.searchParams.get('state');
      const error = url.searchParams.get('error');

      if (error) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end(`<h2>Authentication failed</h2><p>${error}</p><p>You can close this window.</p>`);
        server.close();
        reject(new Error(`OAuth error: ${error}`));
        return;
      }

      if (!code || returnedState !== state) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end('<h2>Invalid callback</h2><p>Missing code or state mismatch.</p>');
        server.close();
        reject(new Error('Invalid callback: missing code or state mismatch'));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(
        '<h2>Authentication successful!</h2>' +
        '<p>You can close this window and return to the terminal.</p>' +
        '<script>window.close()</script>',
      );
      server.close();
      resolve(code);
    });

    server.listen(CALLBACK_PORT, '0.0.0.0', () => {
      console.log(`\n  Opening browser for login...`);
      console.log(`  (callback server listening on port ${CALLBACK_PORT})\n`);
      console.log(`  If browser doesn't open, visit this URL:\n`);
      console.log(`  ${authUrl.toString()}\n`);
      openBrowser(authUrl.toString());
    });

    server.on('error', (err) => {
      if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
        reject(new Error(`Port ${CALLBACK_PORT} is in use. Close the other process and try again.`));
      } else {
        reject(err);
      }
    });

    setTimeout(() => {
      server.close();
      reject(new Error('Authentication timed out (5 minutes). Please try again.'));
    }, 5 * 60 * 1000);
  });

  console.log('  Authorization code received. Exchanging for tokens...');

  const tokenBody = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: clientId,
    code: authCode,
    redirect_uri: REDIRECT_URI,
    code_verifier: codeVerifier,
  }).toString();

  const { status: tokenStatus, data: tokenData } = await fetchJson(tokenEndpoint, {
    method: 'POST',
    body: tokenBody,
  });

  if (!tokenData.access_token) {
    console.error(`Error: Token exchange failed (${tokenStatus}).`);
    console.error(JSON.stringify(tokenData, null, 2));
    process.exit(1);
  }

  console.log(`  Access token received (expires in ${tokenData.expires_in}s)`);

  return {
    accessToken: tokenData.access_token,
    refreshToken: tokenData.refresh_token,
    clientId,
  };
}

// ---------------------------------------------------------------------------
// Step 2: Fetch tools from gateway & generate native OpenClaw plugin
// ---------------------------------------------------------------------------

interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, any>;
}

async function fetchToolsList(gatewayUrl: string, accessToken: string): Promise<McpTool[]> {
  console.log('  Fetching tools from gateway...');
  const { status, data } = await fetchJson(`${gatewayUrl}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: {},
    }),
  });

  if (status !== 200 || !data?.result?.tools) {
    console.warn(`  Warning: tools/list returned status ${status}`);
    console.warn(`  Response: ${JSON.stringify(data).slice(0, 200)}`);
    return [];
  }

  const tools: McpTool[] = data.result.tools;

  const groups: Record<string, number> = {};
  for (const t of tools) {
    const prefix = t.name.split('_')[0];
    groups[prefix] = (groups[prefix] || 0) + 1;
  }

  console.log(`  Found ${tools.length} tools:`);
  for (const [prefix, count] of Object.entries(groups).sort()) {
    console.log(`    ${prefix}: ${count} tools`);
  }

  return tools;
}

function escapeTs(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r');
}

function generateMcpToolsPlugin(
  gatewayUrl: string,
  accessToken: string,
  tools: McpTool[],
): void {
  fs.mkdirSync(TOOLS_PLUGIN_DIR, { recursive: true });

  // package.json
  const pkg = {
    name: TOOLS_PLUGIN_ID,
    version: '1.0.0',
    type: 'module',
    openclaw: { extensions: ['./index.ts'] },
    dependencies: {},
  };
  fs.writeFileSync(
    path.join(TOOLS_PLUGIN_DIR, 'package.json'),
    JSON.stringify(pkg, null, 2) + '\n',
  );

  // openclaw.plugin.json
  const manifest = {
    id: TOOLS_PLUGIN_ID,
    name: 'VirtueAI MCP Tools',
    description: `${tools.length} MCP tools from VirtueAI gateway`,
    configSchema: { type: 'object', properties: {} },
  };
  fs.writeFileSync(
    path.join(TOOLS_PLUGIN_DIR, 'openclaw.plugin.json'),
    JSON.stringify(manifest, null, 2) + '\n',
  );

  // index.ts — register each tool as a native OpenClaw tool
  const mcpUrl = JSON.stringify(gatewayUrl + '/mcp');
  const token = JSON.stringify(accessToken);

  const toolRegistrations = tools.map((tool) => {
    const name = escapeTs(tool.name);
    const description = escapeTs(tool.description || `Tool: ${tool.name}`);
    const schema = JSON.stringify(tool.inputSchema || { type: 'object', properties: {} });

    return `
  api.registerTool({
    name: "${name}",
    description: "${description}",
    parameters: ${schema},
    async execute(_id: string, params: unknown) {
      try {
        const response = await fetch(GATEWAY_MCP_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": AUTH_HEADER },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: Date.now(),
            method: "tools/call",
            params: { name: "${name}", arguments: params }
          })
        });

        const result = await response.json();

        if (result.error) {
          return {
            content: [{ type: "text", text: \`Error: \${result.error.message}\` }],
            isError: true
          };
        }

        const text = result.result?.content
          ?.map((c: any) => c.text ?? c.data ?? "")
          .join("\\n") ?? JSON.stringify(result.result);

        return {
          content: [{ type: "text", text }],
          isError: false
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: \`Error calling ${name}: \${err}\` }],
          isError: true
        };
      }
    }
  });`;
  });

  const pluginSource = `\
const GATEWAY_MCP_URL = ${mcpUrl};
const AUTH_HEADER = "Bearer " + ${token};

export default function (api: any) {
${toolRegistrations.join('\n')}
}
`;

  fs.writeFileSync(path.join(TOOLS_PLUGIN_DIR, 'index.ts'), pluginSource);
  console.log(`  Generated MCP tools plugin: ${TOOLS_PLUGIN_DIR} (${tools.length} tools)`);
}

// ---------------------------------------------------------------------------
// Step 3: Write config & patch openclaw.json
// ---------------------------------------------------------------------------

function writeGatewayConfig(
  gatewayUrl: string,
  accessToken: string,
  guardUuid?: string,
  apiUrl?: string,
  gatewayId?: string,
): void {
  fs.mkdirSync(OPENCLAW_DIR, { recursive: true });

  const config = {
    trajectory: {
      gatewayUrl,
      apiUrl: apiUrl || DEFAULT_API_URL,
      gatewayId: gatewayId || DEFAULT_GATEWAY_ID,
      guardUuid: guardUuid || process.env.VIRTUEAI_GUARD_UUID || '',
    },
    _auth: {
      gatewayUrl,
      accessToken,
    },
  };

  fs.writeFileSync(MCP_CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
  console.log(`  Written: ${MCP_CONFIG_PATH}`);
}

function patchOpenClawConfig(model?: string): void {
  let config: any = {};

  if (fs.existsSync(OPENCLAW_CONFIG_PATH)) {
    try {
      config = JSON.parse(fs.readFileSync(OPENCLAW_CONFIG_PATH, 'utf-8'));
    } catch {
      console.warn('  Warning: existing openclaw.json is invalid JSON, creating fresh config');
      config = {};
    }
  }

  if (!config.agents) config.agents = {};
  if (!config.agents.defaults) config.agents.defaults = {};

  if (model) {
    config.agents.defaults.model = { primary: model };
  } else if (
    !config.agents.defaults.model ||
    config.agents.defaults.model?.primary?.startsWith('claude-cli/')
  ) {
    config.agents.defaults.model = { primary: 'anthropic/claude-opus-4-6' };
  }

  // Clear models allowlist so users can switch to any model in OpenClaw
  config.agents.defaults.models = {};

  // Enable virtueai-mcp-tools plugin
  if (!config.plugins) config.plugins = {};
  if (!config.plugins.entries) config.plugins.entries = {};
  config.plugins.entries[TOOLS_PLUGIN_ID] = { enabled: true };

  if (!config.plugins.allow) config.plugins.allow = [];
  if (!config.plugins.allow.includes(TOOLS_PLUGIN_ID)) {
    config.plugins.allow.push(TOOLS_PLUGIN_ID);
  }

  if (!config.plugins.installs) config.plugins.installs = {};
  config.plugins.installs[TOOLS_PLUGIN_ID] = {
    source: 'path',
    sourcePath: TOOLS_PLUGIN_DIR,
    installPath: TOOLS_PLUGIN_DIR,
    version: '1.0.0',
    installedAt: new Date().toISOString(),
  };

  // Add plugin tools to agent allowlist (required for OpenClaw to expose them)
  // Follows the pattern from DecodingTrust-Agent:
  //   agents.list[{id: "main", tools: {allow: ["group:plugins", pluginId]}}]
  if (!config.agents.list) config.agents.list = [];

  let mainAgent = config.agents.list.find((a: any) => a.id === 'main');
  if (!mainAgent) {
    mainAgent = { id: 'main' };
    config.agents.list.push(mainAgent);
  }

  if (!mainAgent.tools) mainAgent.tools = {};
  if (!mainAgent.tools.allow) mainAgent.tools.allow = [];

  const allowlist: string[] = mainAgent.tools.allow;
  if (!allowlist.includes('group:plugins')) {
    allowlist.push('group:plugins');
  }
  if (!allowlist.includes(TOOLS_PLUGIN_ID)) {
    allowlist.push(TOOLS_PLUGIN_ID);
  }

  fs.writeFileSync(OPENCLAW_CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
  console.log(`  Patched: ${OPENCLAW_CONFIG_PATH}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  if (hasFlag('help') || hasFlag('h')) {
    console.log(`
VirtueAI Gateway Connect — connect OpenClaw to VirtueAI MCP gateway

Usage:
  npx @virtue-ai/gateway-connect [options]

Options:
  --gateway-url <url>    MCP gateway URL (default: ${DEFAULT_GATEWAY_URL})
  --api-url <url>        Prompt-guard API URL (default: ${DEFAULT_API_URL})
  --gateway-id <id>      Gateway ID for trajectory (default: ${DEFAULT_GATEWAY_ID})
  --model <model>        Model to use (e.g. openai/gpt-4o, anthropic/claude-sonnet-4-5)
  --guard-uuid <uuid>    Guard UUID for trajectory recording (or set VIRTUEAI_GUARD_UUID)
  --help                 Show this help message

What it does:
  1. Opens browser for OAuth login
  2. Fetches all MCP tools from the gateway
  3. Generates a native OpenClaw plugin wrapping each tool
  4. Patches ~/.openclaw/openclaw.json to enable the plugin
  5. Installs trajectory plugin for full session recording

Supported models:
  Any embedded model supported by OpenClaw (NOT claude-cli).
  Examples: openai/gpt-4o, anthropic/claude-sonnet-4-5
`);
    process.exit(0);
  }

  let gatewayUrl = getArg('gateway-url') || DEFAULT_GATEWAY_URL;
  const model = getArg('model');
  const guardUuid = getArg('guard-uuid') || process.env.VIRTUEAI_GUARD_UUID;
  const apiUrl = getArg('api-url') || DEFAULT_API_URL;
  const gatewayId = getArg('gateway-id') || DEFAULT_GATEWAY_ID;
  gatewayUrl = gatewayUrl.replace(/\/mcp\/?$/, '').toLowerCase();

  console.log('\n  VirtueAI Gateway Connect\n');
  console.log(`  Gateway: ${gatewayUrl}`);
  if (model) console.log(`  Model: ${model}`);

  // Step 1: Authenticate
  const { accessToken } = await authenticate(gatewayUrl);

  // Step 2: Fetch tools & generate native plugin
  console.log('\n  Configuring OpenClaw...');
  const tools = await fetchToolsList(gatewayUrl, accessToken);

  if (tools.length === 0) {
    console.error('\n  Error: No tools found on gateway. Token may be invalid.');
    process.exit(1);
  }

  generateMcpToolsPlugin(gatewayUrl, accessToken, tools);

  // Step 3: Write gateway config (for trajectory plugin)
  writeGatewayConfig(gatewayUrl, accessToken, guardUuid, apiUrl, gatewayId);

  // Step 4: Patch openclaw.json (enable tools plugin + set model)
  patchOpenClawConfig(model);

  // Step 5: Install trajectory plugin
  console.log('\n  Setting up trajectory recording...');
  generateTrajectoryPlugin(guardUuid);
  enableTrajectoryPlugin();

  // Done
  const modelDisplay = model || 'existing (unchanged)';
  console.log(`
  Done! OpenClaw is now connected to VirtueAI MCP gateway.
  ${tools.length} tools registered as native OpenClaw tools.
  Model: ${modelDisplay}
  Trajectory recording enabled (via virtueai-trajectory plugin).

  Config files:
    ${MCP_CONFIG_PATH}
    ${OPENCLAW_CONFIG_PATH}
    ${TOOLS_PLUGIN_DIR}

  Start using it:
    openclaw agent --local --message "What tools do you have?"

  To use a different model:
    npx @virtue-ai/gateway-connect --gateway-url ${gatewayUrl} --model openai/gpt-4o
`);
  process.exit(0);
}

main().catch((err) => {
  console.error(`\nError: ${err.message}`);
  process.exit(1);
});
