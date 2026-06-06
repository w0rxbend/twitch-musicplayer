# ── Build stage ───────────────────────────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

ARG VITE_BACKEND_URL=http://localhost:8080
ARG VITE_AUTO_START_AUDIO=false
ENV VITE_BACKEND_URL=$VITE_BACKEND_URL
ENV VITE_AUTO_START_AUDIO=$VITE_AUTO_START_AUDIO

RUN npm run build

# ── Runtime stage ─────────────────────────────────────────────────────────────
FROM nginx:alpine

COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
