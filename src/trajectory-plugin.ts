/**
 * Trajectory Plugin Generator
 *
 * Generates and installs an OpenClaw plugin that hooks into the agent lifecycle
 * to send every trajectory step to the VirtueAI gateway's prompt-guard API.
 *
 * Hooks used (all fire-and-forget, never block the agent):
 *   - llm_input:       captures user prompt  → role "user"
 *   - llm_output:      captures agent reply   → role "agent"
 *   - after_tool_call:  captures tool results → role "agent"
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const OPENCLAW_DIR = path.join(os.homedir(), '.openclaw');
const OPENCLAW_CONFIG_PATH = path.join(OPENCLAW_DIR, 'openclaw.json');
const MCP_CONFIG_PATH = path.join(OPENCLAW_DIR, 'mcp-gateway.json');
const PLUGIN_ID = 'virtueai-trajectory';
const PLUGIN_DIR = path.join(OPENCLAW_DIR, 'extensions', PLUGIN_ID);

const DEFAULT_GUARD_UUID =
  '3a2389709528a539a12ba6239e402ef159ecffa88f99af6e13236e69dd9bb2e5';

// ---------------------------------------------------------------------------
// Plugin source code (generated as a string, written to disk)
// ---------------------------------------------------------------------------

function buildPluginSource(): string {
  return `\
import { readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

/**
 * VirtueAI Trajectory Plugin
 *
 * Sends every agent interaction step to the VirtueAI gateway prompt-guard API
 * so the full trajectory is visible in the dashboard.
 *
 * All hooks are fire-and-forget — errors are logged, never thrown.
 */

const MCP_CONFIG_PATH = join(homedir(), ".openclaw", "mcp-gateway.json");
const DEFAULT_GUARD_UUID =
  "${DEFAULT_GUARD_UUID}";

function loadConfig() {
  try {
    const raw = readFileSync(MCP_CONFIG_PATH, "utf-8");
    const cfg = JSON.parse(raw);
    const virtueai = cfg.mcpServers?.virtueai;
    if (!virtueai) return null;

    const authHeader = virtueai.headers?.Authorization ?? "";
    const token = authHeader.replace(/^Bearer\\s+/i, "");
    const gatewayUrl = (virtueai.url ?? "").replace(/\\/mcp\\/?$/, "");

    const guardUuid =
      cfg.trajectory?.guardUuid ||
      process.env.VIRTUEAI_GUARD_UUID ||
      DEFAULT_GUARD_UUID;

    if (!gatewayUrl || !token) return null;
    return { gatewayUrl, token, guardUuid };
  } catch {
    return null;
  }
}

function truncate(s, max = 2000) {
  if (typeof s !== "string") {
    try { s = JSON.stringify(s); } catch { s = String(s); }
  }
  return s.length > max ? s.slice(0, max) + "..." : s;
}

const plugin = {
  id: "${PLUGIN_ID}",
  name: "VirtueAI Trajectory",
  description: "Sends agent trajectory steps to VirtueAI gateway for dashboard visibility",

  register(api) {
    const config = loadConfig();
    if (!config) {
      api.logger.warn("[virtueai-trajectory] No valid config found in " + MCP_CONFIG_PATH + ", plugin disabled");
      return;
    }

    let gatewaySessionId = null;
    const endpoint = config.gatewayUrl + "/api/prompt-guard/topic_guard";

    async function sendStep(role, content) {
      const body = {
        user_prompt: truncate(content),
        guard_uuid: config.guardUuid,
        role,
      };
      if (gatewaySessionId) {
        body.session_id = gatewaySessionId;
      }

      try {
        const res = await fetch(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer " + config.token,
          },
          body: JSON.stringify(body),
        });
        const data = await res.json();

        if (data?.session_id && !gatewaySessionId) {
          gatewaySessionId = data.session_id;
          api.logger.info("[virtueai-trajectory] Gateway session: " + gatewaySessionId);
        }
      } catch (err) {
        api.logger.warn("[virtueai-trajectory] Failed to send step: " + (err?.message ?? err));
      }
    }

    // Hook: user prompt sent to LLM
    api.on("llm_input", (event) => {
      if (event.prompt) {
        sendStep("user", event.prompt);
      }
    });

    // Hook: LLM response received
    api.on("llm_output", (event) => {
      const text = (event.assistantTexts ?? []).join("\\n").trim();
      if (text) {
        sendStep("agent", text);
      }
    });

    // Hook: tool call completed
    api.on("after_tool_call", (event) => {
      const params = event.params
        ? Object.entries(event.params)
            .map(([k, v]) => k + "=" + JSON.stringify(v))
            .join(", ")
        : "";
      const callStr = event.toolName + "(" + params + ")";
      const resultStr = event.result != null ? truncate(event.result, 500) : (event.error ?? "no result");
      sendStep("agent", callStr + " → " + resultStr);
    });

    api.logger.info("[virtueai-trajectory] Plugin registered, sending to " + config.gatewayUrl);
  },
};

export default plugin;
`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate the trajectory plugin files on disk.
 */
export function generateTrajectoryPlugin(guardUuid?: string): void {
  fs.mkdirSync(PLUGIN_DIR, { recursive: true });

  // package.json
  const pkg = {
    name: '@virtue-ai/trajectory',
    version: '1.0.0',
    type: 'module',
    openclaw: {
      extensions: ['./index.ts'],
    },
  };
  fs.writeFileSync(path.join(PLUGIN_DIR, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');

  // index.ts (the actual plugin)
  fs.writeFileSync(path.join(PLUGIN_DIR, 'index.ts'), buildPluginSource());

  // Persist guard UUID in mcp-gateway.json trajectory section
  if (guardUuid) {
    try {
      const raw = fs.readFileSync(MCP_CONFIG_PATH, 'utf-8');
      const cfg = JSON.parse(raw);
      if (!cfg.trajectory) cfg.trajectory = {};
      cfg.trajectory.guardUuid = guardUuid;
      fs.writeFileSync(MCP_CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n');
    } catch {
      // Config may not exist yet — will be written by writeMcpConfig
    }
  }

  console.log(`  Generated trajectory plugin: ${PLUGIN_DIR}`);
}

/**
 * Enable the trajectory plugin in openclaw.json.
 */
export function enableTrajectoryPlugin(): void {
  let config: any = {};

  if (fs.existsSync(OPENCLAW_CONFIG_PATH)) {
    try {
      config = JSON.parse(fs.readFileSync(OPENCLAW_CONFIG_PATH, 'utf-8'));
    } catch {
      config = {};
    }
  }

  // plugins.entries
  if (!config.plugins) config.plugins = {};
  if (!config.plugins.entries) config.plugins.entries = {};
  config.plugins.entries[PLUGIN_ID] = { enabled: true };

  // plugins.allow
  if (!config.plugins.allow) config.plugins.allow = [];
  if (!config.plugins.allow.includes(PLUGIN_ID)) {
    config.plugins.allow.push(PLUGIN_ID);
  }

  // plugins.installs (so OpenClaw knows where the plugin lives)
  if (!config.plugins.installs) config.plugins.installs = {};
  config.plugins.installs[PLUGIN_ID] = {
    source: 'path',
    sourcePath: PLUGIN_DIR,
    installPath: PLUGIN_DIR,
    version: '1.0.0',
    installedAt: new Date().toISOString(),
  };

  fs.writeFileSync(OPENCLAW_CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
  console.log(`  Enabled trajectory plugin in: ${OPENCLAW_CONFIG_PATH}`);
}
