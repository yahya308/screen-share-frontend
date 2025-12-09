# Mediasoup Backend Dockerfile
# Uses Node 20 with Debian Bullseye for native compilation support

FROM node:20-bullseye

# Install build dependencies required for mediasoup
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# Create app directory
WORKDIR /app

# Copy package files first (for better layer caching)
COPY package*.json ./

# Install dependencies
RUN npm install --only=production

# Copy application source
COPY . .

# Expose ports
# 3000: HTTP/WebSocket server
# 40000-49999: WebRTC UDP ports (handled by docker-compose)
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD node -e "require('http').get('http://localhost:3000', (r) => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

# Start the server
CMD ["node", "server.js"]
