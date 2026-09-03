# ── Build stage ───────────────────────────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# Build-time configuration. VITE_BACKEND_URL is optional: leaving it empty
# produces an image that resolves the backend at runtime instead, either from
# the BACKEND_URL environment variable or from the host that served the page.
ARG VITE_BACKEND_URL=
ARG VITE_AUTO_START_AUDIO=false
ENV VITE_BACKEND_URL=$VITE_BACKEND_URL
ENV VITE_AUTO_START_AUDIO=$VITE_AUTO_START_AUDIO

RUN npm run build

# ── Runtime stage ─────────────────────────────────────────────────────────────
FROM nginx:alpine

COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

# nginx runs every executable in this directory before starting. The script
# writes config.js from the environment, so the backend URL can change without
# rebuilding the image.
COPY docker-entrypoint.d/20-lofi-config.sh /docker-entrypoint.d/20-lofi-config.sh
RUN chmod +x /docker-entrypoint.d/20-lofi-config.sh

EXPOSE 80

HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
    CMD wget -q -O /dev/null http://127.0.0.1/ || exit 1
