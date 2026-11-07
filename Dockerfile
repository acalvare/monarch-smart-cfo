FROM node:24-alpine

WORKDIR /app

# Copy application manifests and source
COPY package.json ./
COPY server ./server
COPY public ./public

# Create persistent SQLite volume mount point for Unraid (/mnt/user/appdata/monarch-cfo)
RUN mkdir -p /data && chown -R node:node /app /data

ENV NODE_ENV=production
ENV PORT=3080
ENV DATA_DIR=/data

EXPOSE 3080

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3080/api/health || exit 1

USER node

CMD ["node", "server/index.js"]
