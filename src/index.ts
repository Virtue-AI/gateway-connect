#!/usr/bin/env node
/**
 * VirtueAI Gateway Connect
 *
 * One-command setup to connect OpenClaw to VirtueAI MCP gateway.
 *
 * 1. OAuth 2.0 PKCE login → obtain access token
 * 2. Write MCP gateway config to ~/.openclaw/mcp-gateway.json
 * 3. Patch ~/.openclaw/openclaw.json to use claude-cli with --mcp-config
 * 4. Verify connection by listing tools
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
const SCOPES = 'claudeai copilot mcp:read mcp:execute mcp:access';

const OPENCLAW_DIR = path.join(os.homedir(), '.openclaw');
const MCP_CONFIG_PATH = path.join(OPENCLAW_DIR, 'mcp-gateway.json');
const OPENCLAW_CONFIG_PATH = path.join(OPENCLAW_DIR, 'openclaw.json');

const DEFAULT_GATEWAY_URL = 'https://virtueai-agent-gtw-l3phon63.ngrok.io';

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
  // Discover OAuth metadata
  console.log('  Discovering OAuth endpoints...');
  const { data: metadata } = await fetchJson(
    `${gatewayUrl}/.well-known/oauth-authorization-server`,
    { method: 'GET' },
  );

  if (!metadata.authorization_endpoint || !metadata.token_endpoint) {
    console.error('Error: Could not discover OAuth endpoints from gateway.');
    console.error('Response:', JSON.stringify(metadata, null, 2));
    process.exit(1);
  }

  const authEndpoint: string = metadata.authorization_endpoint;
  const tokenEndpoint: string = metadata.token_endpoint;
  const registerEndpoint: string = metadata.registration_endpoint;

  console.log(`  Auth endpoint: ${authEndpoint}`);
  console.log(`  Token endpoint: ${tokenEndpoint}`);

  // Register OAuth client
  console.log('  Registering OAuth client...');
  const { status: regStatus, data: clientInfo } = await fetchJson(registerEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'openclaw-gateway-connect',
      grant_types: ['authorization_code', 'refresh_token'],
      redirect_uris: [REDIRECT_URI],
      scope: SCOPES,
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

  // Build authorization URL with PKCE
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
  const state = crypto.randomBytes(16).toString('hex');

  const authUrl = new URL(authEndpoint);
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('redirect_uri', REDIRECT_URI);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', SCOPES);
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('code_challenge', codeChallenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');

  // Start callback server & open browser
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

    // Timeout after 5 minutes
    setTimeout(() => {
      server.close();
      reject(new Error('Authentication timed out (5 minutes). Please try again.'));
    }, 5 * 60 * 1000);
  });

  console.log('  Authorization code received. Exchanging for tokens...');

  // Exchange code for tokens
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
// Step 2: Write MCP gateway config
// ---------------------------------------------------------------------------

function writeMcpConfig(gatewayUrl: string, accessToken: string, guardUuid?: string): void {
  fs.mkdirSync(OPENCLAW_DIR, { recursive: true });

  const config: any = {
    mcpServers: {
      virtueai: {
        type: 'http',
        url: `${gatewayUrl}/mcp`,
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      },
    },
    trajectory: {
      gatewayUrl,
      guardUuid: guardUuid || process.env.VIRTUEAI_GUARD_UUID || '',
    },
  };

  fs.writeFileSync(MCP_CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
  console.log(`  Written: ${MCP_CONFIG_PATH}`);
}

// ---------------------------------------------------------------------------
// Step 3: Patch openclaw.json
// ---------------------------------------------------------------------------

function patchOpenClawConfig(): void {
  let config: any = {};

  if (fs.existsSync(OPENCLAW_CONFIG_PATH)) {
    try {
      config = JSON.parse(fs.readFileSync(OPENCLAW_CONFIG_PATH, 'utf-8'));
    } catch {
      console.warn('  Warning: existing openclaw.json is invalid JSON, creating fresh config');
      config = {};
    }
  }

  // Ensure nested structure exists
  if (!config.agents) config.agents = {};
  if (!config.agents.defaults) config.agents.defaults = {};

  // Set model to claude-cli if not already set
  if (!config.agents.defaults.model) {
    config.agents.defaults.model = { primary: 'claude-cli/sonnet' };
  }

  // Ensure cliBackends.claude-cli exists
  if (!config.agents.defaults.cliBackends) config.agents.defaults.cliBackends = {};
  if (!config.agents.defaults.cliBackends['claude-cli']) {
    config.agents.defaults.cliBackends['claude-cli'] = {
      command: 'claude',
      args: ['-p', '--output-format', 'json'],
    };
  }

  const cliBackend = config.agents.defaults.cliBackends['claude-cli'];

  // Ensure args is an array
  if (!Array.isArray(cliBackend.args)) {
    cliBackend.args = ['-p', '--output-format', 'json'];
  }

  // Add or update --mcp-config
  const mcpIdx = cliBackend.args.indexOf('--mcp-config');
  if (mcpIdx !== -1) {
    // Update existing path
    cliBackend.args[mcpIdx + 1] = MCP_CONFIG_PATH;
  } else {
    // Append
    cliBackend.args.push('--mcp-config', MCP_CONFIG_PATH);
  }

  // Write back
  fs.writeFileSync(OPENCLAW_CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
  console.log(`  Patched: ${OPENCLAW_CONFIG_PATH}`);
}

// ---------------------------------------------------------------------------
// Step 4: Verify connection
// ---------------------------------------------------------------------------

async function verifyConnection(gatewayUrl: string, accessToken: string): Promise<number> {
  console.log('  Verifying token with gateway...');
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

  if (status === 200 && data?.result?.tools) {
    const tools = data.result.tools;
    const toolCount = tools.length;

    // Group by prefix
    const groups: Record<string, number> = {};
    for (const t of tools) {
      const prefix = t.name.split('_')[0];
      groups[prefix] = (groups[prefix] || 0) + 1;
    }

    console.log(`  Verified! ${toolCount} tools available:`);
    for (const [prefix, count] of Object.entries(groups).sort()) {
      console.log(`    ${prefix}: ${count} tools`);
    }

    return toolCount;
  } else {
    console.warn(`  Warning: verification returned status ${status}`);
    console.warn(`  Response: ${JSON.stringify(data).slice(0, 200)}`);
    console.warn('  Token was saved but may not work yet.');
    return 0;
  }
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
  --gateway-url <url>    Gateway URL (default: ${DEFAULT_GATEWAY_URL})
  --guard-uuid <uuid>    Guard UUID for trajectory recording (or set VIRTUEAI_GUARD_UUID)
  --help                 Show this help message

What it does:
  1. Opens browser for OAuth login
  2. Saves MCP config to ~/.openclaw/mcp-gateway.json
  3. Patches ~/.openclaw/openclaw.json to use the gateway
  4. Installs trajectory plugin for full session recording
  5. Verifies connection by listing available tools
`);
    process.exit(0);
  }

  let gatewayUrl = getArg('gateway-url') || DEFAULT_GATEWAY_URL;
  const guardUuid = getArg('guard-uuid') || process.env.VIRTUEAI_GUARD_UUID;
  // Strip /mcp suffix and normalize to lowercase
  gatewayUrl = gatewayUrl.replace(/\/mcp\/?$/, '').toLowerCase();

  console.log('\n  VirtueAI Gateway Connect\n');
  console.log(`  Gateway: ${gatewayUrl}`);

  // Step 1: Authenticate
  const { accessToken } = await authenticate(gatewayUrl);

  // Step 2: Write MCP config
  console.log('\n  Configuring OpenClaw...');
  writeMcpConfig(gatewayUrl, accessToken, guardUuid);

  // Step 3: Patch openclaw.json
  patchOpenClawConfig();

  // Step 4: Install trajectory plugin
  console.log('\n  Setting up trajectory recording...');
  generateTrajectoryPlugin(guardUuid);
  enableTrajectoryPlugin();

  // Step 5: Verify
  console.log('');
  const toolCount = await verifyConnection(gatewayUrl, accessToken);

  // Done
  console.log(`
  Done! OpenClaw is now connected to VirtueAI MCP gateway.
  ${toolCount} tools available across the gateway.
  Trajectory recording enabled (via virtueai-trajectory plugin).

  Config files:
    ${MCP_CONFIG_PATH}
    ${OPENCLAW_CONFIG_PATH}

  Start using it:
    openclaw agent --local --message "What tools do you have?"
`);
  process.exit(0);
}

main().catch((err) => {
  console.error(`\nError: ${err.message}`);
  process.exit(1);
});
