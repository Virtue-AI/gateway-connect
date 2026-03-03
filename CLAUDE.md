# gateway-connect

## 项目概述

一键连接 OpenClaw 到 VirtueAI MCP Gateway 的 CLI 工具。用户只需运行 `npx @virtue-ai/gateway-connect --gateway-url <url>`，全部自动完成。

## 架构

零外部依赖，仅用 Node.js 内置模块（crypto, http, https, fs, path, os, child_process, url）。

### 文件结构

- `src/index.ts` — CLI 主入口，包含 OAuth 认证、配置写入、连接验证
- `src/trajectory-plugin.ts` — 生成并安装 OpenClaw 插件，用于 trajectory 记录

### Setup 流程（`src/index.ts` → `main()`）

1. **OAuth 2.0 PKCE 认证** — 发现 OAuth 端点 → 注册客户端 → 浏览器登录 → 换取 token
2. **写入 MCP 配置** — `~/.openclaw/mcp-gateway.json`（gateway URL、token、trajectory 配置）
3. **修补 OpenClaw 配置** — `~/.openclaw/openclaw.json`（claude-cli backend 添加 `--mcp-config`）
4. **安装 Trajectory 插件** — 生成插件到 `~/.openclaw/extensions/virtueai-trajectory/`，在 openclaw.json 中启用
5. **验证连接** — JSON-RPC `tools/list` 调用

### Trajectory 插件机制（`src/trajectory-plugin.ts`）

gateway-connect 在 setup 时生成一个 OpenClaw 插件（TypeScript，运行在 OpenClaw 的 Bun 运行时），利用 OpenClaw 的 plugin hook 系统：

| Hook | 模式 | 捕获内容 |
|------|------|---------|
| `llm_input` | fire-and-forget | 用户 prompt → `role: "user"` |
| `llm_output` | fire-and-forget | agent 回复 → `role: "agent"` |
| `after_tool_call` | fire-and-forget | tool 调用结果 → `role: "agent"` |

每个 step 发送到 `POST {gatewayUrl}/api/prompt-guard/topic_guard`，不做任何 block，纯记录。第一次调用获取 `session_id`，后续复用。

插件生成的文件：
- `~/.openclaw/extensions/virtueai-trajectory/package.json`
- `~/.openclaw/extensions/virtueai-trajectory/index.ts`

### 配置文件

**`~/.openclaw/mcp-gateway.json`**（由 `writeMcpConfig` 写入）：
```json
{
  "mcpServers": {
    "virtueai": {
      "type": "http",
      "url": "{gatewayUrl}/mcp",
      "headers": { "Authorization": "Bearer {token}" }
    }
  },
  "trajectory": {
    "gatewayUrl": "...",
    "guardUuid": "..."
  }
}
```

**`~/.openclaw/openclaw.json`**（由 `patchOpenClawConfig` + `enableTrajectoryPlugin` 写入）：
- `agents.defaults.cliBackends.claude-cli` — claude CLI 配置
- `plugins.entries.virtueai-trajectory` — 插件启用
- `plugins.allow` — 插件白名单
- `plugins.installs` — 插件安装路径

### guard_uuid

优先级：`--guard-uuid` CLI 参数 > `VIRTUEAI_GUARD_UUID` 环境变量 > 硬编码默认值

## 构建与发布

```bash
npm run build                # tsc 编译到 dist/
```

### 发版流程

1. 修改 `package.json` 中的 `version`（遵循 semver：新功能 minor bump，bug fix patch bump）
2. `npm run build`
3. `git add` 改动文件（src/、README.md、package.json、package-lock.json）— dist/ 在 .gitignore 中，不提交
4. `git commit` 并 `git push origin main`
5. `npm publish --access public` — 发布到 npm registry

## 注意事项

- `patchOpenClawConfig()` 和 `enableTrajectoryPlugin()` 都读写 `openclaw.json`，顺序很重要：先 patch 再 enable
- 生成的插件 `index.ts` 是字符串模板（`buildPluginSource()`），修改时注意转义（`\\n` → 输出文件中的 `\n`）
- 插件运行在 OpenClaw 的 Bun 运行时中，使用原生 `fetch()`，不依赖 Node.js 的 http 模块
