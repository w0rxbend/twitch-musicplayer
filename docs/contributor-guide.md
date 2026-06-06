# Contributor Guide

## Development Principles

- Keep backend playback behavior authoritative and explicit.
- Keep frontend playback backend-only.
- Prefer resource-oriented HTTP endpoints under `/v1`.
- Prefer browser-native media streaming over fetching audio bytes into JavaScript.
- Add focused tests for queue, history, repository, and protocol behavior when changing backend semantics.
- Avoid visible UI controls that conflict with the current passive visualizer experience.

## Branch Workflow

1. Create a feature branch.
2. Keep backend and frontend changes scoped.
3. Run backend tests and frontend build.
4. Update docs when behavior or configuration changes.
5. Include known limitations in the PR description if a requirement is partially implemented.

## Suggested PR Checklist

- `go test ./...` passes in `backend/`.
- `npm run build` passes in `frontend/`.
- New configuration has examples in `backend/config.example.toml`, `backend/.env.example`, or `frontend/.env.example`.
- WebSocket payload shape changes are reflected in `docs/websocket-protocol.md`.
- HTTP endpoint changes are reflected in `docs/api.md`.
- User-visible workflow changes are reflected in `docs/user-guide.md`.

## Testing Gaps To Close

High-value tests to add:

- Queue manager: `round_robin` cycle behavior.
- Queue repository: missing row delete returns `sql.ErrNoRows`.
- History repository: mark finished behavior and row counts.
- Watcher: create event indexing and duplicate path handling.
- WebSocket: `need_song -> play_song -> song_finished -> play_song`.
- Frontend: WebSocket controller message handling with mocked `AudioEngine`.

## Supported Playback Model

The supported playback model is one active WebSocket client. Do not add frontend flows that create competing playback clients unless the backend protocol is intentionally redesigned.
