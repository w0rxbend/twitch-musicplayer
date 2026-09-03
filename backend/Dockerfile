# ── Build stage ───────────────────────────────────────────────────────────────
FROM golang:1.25-bookworm AS builder

WORKDIR /app

COPY go.mod go.sum ./
RUN go mod download

COPY . .

# CGO stays off: nothing here needs a C library, so the result is a static
# binary that runs on any base image.
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o /lofi-radio ./cmd/api/main.go

# ── Runtime stage ─────────────────────────────────────────────────────────────
# Alpine rather than scratch. It costs about 8 MB, and buys a shell for
# debugging, wget for the healthcheck below, and the ability to create /data
# with the right ownership so the Bloom filter can be written by a non-root user.
FROM alpine:3.21

# wget comes from busybox in the base image, so only certificates and zone data
# are actually needed here.
RUN apk add --no-cache ca-certificates tzdata \
    && adduser -D -u 10001 -h /home/lofi lofi \
    && mkdir -p /data /music \
    && chown -R lofi:lofi /data

COPY --from=builder /lofi-radio /usr/local/bin/lofi-radio
COPY --from=builder /app/config.example.toml /config.toml

USER lofi
WORKDIR /

EXPOSE 8080

ENV PORT=8080 \
    BLOOM_PATH=/data/lofi-radio.bloom \
    MUSIC_DIR=/music \
    BASE_URL=http://localhost:8080

# The station is up when it answers /health. Compose uses this to hold the
# frontend back until the backend is actually accepting requests.
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
    CMD wget -q -O /dev/null http://127.0.0.1:8080/health || exit 1

CMD ["lofi-radio"]
