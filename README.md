# Void Defender

A browser-based co-op deep space combat game. Play solo or team up with a friend in real-time via WebRTC (peer-to-peer), with a leaderboard backed by a SQLite database.

## Features

- Solo and co-op modes (WebRTC P2P, signaling over WebSocket)
- Persistent leaderboard with score, combo, time, and hull tracking
- Rate-limited score submission API
- Docker support

## Requirements

- Node.js 18+
- npm

## Getting Started

```bash
npm install
npm start
```

Then open [http://localhost:3000](http://localhost:3000).

## Docker

```bash
docker compose up --build
```

The server runs on port `3000`. Game data (SQLite database) is persisted in the `scores-data` Docker volume.

## API

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/scores` | Submit a game result |
| `GET` | `/api/scores` | Fetch leaderboard (`?mode=solo\|coop&sort=score\|time\|combo&limit=N`) |

## Project Structure

```
├── server.js          # Express + WebSocket signaling server
├── void-defender.html # Game (served via public/index.html symlink or directly)
├── public/            # Static assets
├── data/              # SQLite database (auto-created, gitignored)
├── Dockerfile
└── docker-compose.yml
```
