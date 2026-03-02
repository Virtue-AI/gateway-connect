FROM node:22-bookworm

RUN apt-get update && apt-get install -y jq curl && rm -rf /var/lib/apt/lists/*

# Create non-root user (claude --dangerously-skip-permissions blocks root)
RUN useradd -m -s /bin/bash claw

# Install OpenClaw + Claude Code CLI
RUN npm install -g openclaw@latest @anthropic-ai/claude-code

# Copy gateway-connect tool
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Make the CLI executable
RUN chmod +x dist/index.js

# Switch to non-root user
RUN chown -R claw:claw /app /home/claw
USER claw

# Expose callback port for OAuth flow
EXPOSE 19876

CMD ["/bin/bash"]
