# ── Build stage ───────────────────────────────────────────────────────────────
FROM golang:1.25-bookworm AS builder

WORKDIR /app

COPY go.mod go.sum ./
RUN go mod download

COPY . .

RUN CGO_ENABLED=1 GOOS=linux go build -ldflags="-s -w" -o /lofi-radio ./cmd/api/main.go

# ── Runtime stage ─────────────────────────────────────────────────────────────
FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=builder /lofi-radio /app/lofi-radio
COPY config.example.toml /app/config.toml

RUN mkdir -p /music /data

EXPOSE 8080

ENV PORT=8080 \
    BLUEPRINT_DB_URL=/data/lofi-radio.db \
    MUSIC_DIR=/music \
    BASE_URL=http://localhost:8080

CMD ["/app/lofi-radio"]
