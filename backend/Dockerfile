# Mediasoup Backend Dockerfile
#
# Çok aşamalı: derleme araçları (python3, build-essential) yalnızca ilk
# aşamada kalır, son imaj yaklaşık yarı boyutta olur.
#
# Eskiden `npm install --only=production` kullanılıyordu: bayrak Node 16'dan
# beri kullanımdan kalktı ve package-lock.json'u yok sayabiliyordu, yani her
# derleme farklı sürümler kurabiliyordu. `npm ci` kilidi birebir uygular.

# ─────────────── Aşama 1: bağımlılıklar ───────────────
FROM node:20-bullseye AS deps

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ─────────────── Aşama 2: çalışma imajı ───────────────
FROM node:20-bullseye-slim

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY --chown=node:node . .

# Ayrıcalıksız kullanıcı: süreç artık root değil.
USER node

# 3000: HTTP/WebSocket
# 40000-49999: WebRTC UDP/TCP (docker-compose host ağı ile yönetiliyor)
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 \
    CMD node -e "require('http').get('http://127.0.0.1:3000/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

# SIGTERM doğrudan node'a ulaşsın ki düzgün kapanma çalışsın (exec form).
CMD ["node", "server.js"]
