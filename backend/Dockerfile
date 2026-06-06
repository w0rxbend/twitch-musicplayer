# ── Build stage ───────────────────────────────────────────────────────────────
FROM golang:1.25-bookworm AS builder

WORKDIR /app

COPY go.mod go.sum ./
RUN go mod download

COPY . .

RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o /lofi-radio ./cmd/api/main.go

# ── Runtime stage ─────────────────────────────────────────────────────────────
FROM scratch

COPY --from=builder /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
COPY --from=builder /lofi-radio /lofi-radio
COPY --from=builder /app/config.example.toml /config.toml

EXPOSE 8080

ENV PORT=8080 \
    BLOOM_PATH=/data/lofi-radio.bloom \
    MUSIC_DIR=/music \
    BASE_URL=http://localhost:8080

CMD ["/lofi-radio"]
