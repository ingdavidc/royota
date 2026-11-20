# ═══════════════════════════════════════════════════════════════
#  Dockerfile — Hotspot Fichas ROYOTA
#  Usa Node.js 22-alpine con SQLite nativo (node:sqlite)
# ═══════════════════════════════════════════════════════════════

FROM node:22-alpine AS runtime

LABEL org.opencontainers.image.title="Hotspot Fichas ROYOTA"
LABEL org.opencontainers.image.description="Sistema de venta de fichas Hotspot MikroTik"
LABEL org.opencontainers.image.version="1.0.0"

WORKDIR /app

RUN mkdir -p /app/data /app/logs && chown -R node:node /app

COPY --chown=node:node package*.json ./
RUN npm ci --only=production --ignore-scripts

COPY --chown=node:node src/        ./src/
COPY --chown=node:node public/     ./public/

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3000/api/health || exit 1

CMD ["node", "src/server.js"]
