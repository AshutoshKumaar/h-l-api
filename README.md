# H-L API

Reusable higher-lower API built on Firebase Hosting, Firebase Functions, Firestore, and the YouTube Data API.

## What changed

- No tester page or browser UI.
- Public API responses are served from Express through a Firebase Function.
- Firebase Hosting rewrites all requests to the `api` function.
- Channel records live in Firestore.
- Random channel selection uses a `randomIndex` field on each channel document so the API can fetch random records efficiently without reading the full collection.
- The API is not limited to 5 channels. The Firestore collection can grow as large as your project limits allow.

## Firestore strategy

Each channel document in the `channels` collection stores a floating-point `randomIndex` value between `0` and `1`.

Random fetch flow:

1. Generate a random seed.
2. Query Firestore for docs where `randomIndex >= seed`, ordered by `randomIndex`, limited to a small window.
3. If needed, wrap around with a second query where `randomIndex < seed`, ordered by `randomIndex`.
4. Filter excluded IDs and channels missing the requested metric.

This avoids loading the whole collection and keeps random fetches fast even when the dataset grows.

## Main endpoints

- `GET /health`
- `GET /api/meta`
- `POST /api/admin/channels/discover`
- `POST /api/admin/channels/sync`
- `GET /api/admin/channels/count`
- `POST /api/admin/channels/reindex`
- `GET /api/channels/random?metric=subscribers&count=2`
- `GET /api/channels/:channelId?metric=subscribers`
- `POST /api/game/round`
- `POST /api/game/guess`

## Frontend use

This section is for frontend developers who only want to consume the API.

### 1. Decide your base URL

- Local: `http://localhost:3000`
- Live: `https://beautyglamours-f0ec7.web.app`

### 2. Check the API is alive

Open:

- `/health`
- `/api/meta`

If both return JSON, the API is reachable.

Example live URLs:

- `https://beautyglamours-f0ec7.web.app/health`
- `https://beautyglamours-f0ec7.web.app/api/meta`
- `https://beautyglamours-f0ec7.web.app/api/channels/random?metric=subscribers&count=2`

Example health response:

```json
{
  "ok": true,
  "service": "h-l-api",
  "storage": "firestore",
  "randomSelection": "randomIndex"
}
```

### 3. Create a new game round

Request:

```http
POST /api/game/round
Content-Type: application/json
```

Body:

```json
{
  "metric": "subscribers"
}
```

Frontend example:

```js
const roundResponse = await fetch(`${BASE_URL}/api/game/round`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json"
  },
  body: JSON.stringify({
    metric: "subscribers"
  })
});

const round = await roundResponse.json();
```

The response contains:

- `roundId`
- `left`
- `right`
- `metric`
- `expiresAt`

Example response shape:

```json
{
  "ok": true,
  "roundId": "round_123",
  "metric": "subscribers",
  "left": {
    "id": "UC...",
    "name": "Channel A",
    "metricValue": 1200000,
    "metricDisplay": "1.2M"
  },
  "right": {
    "id": "UC...",
    "name": "Channel B"
  }
}
```

Important:

- `left.metricValue` is visible
- `right.metricValue` is intentionally hidden before the guess

### 4. Show cards in the frontend

Render:

- `left.name`
- `left.image`
- `left.metricDisplay`
- `right.name`
- `right.image`

Do not expect the hidden card metric value before guessing.

### 5. Submit the player's guess

Request:

```http
POST /api/game/guess
Content-Type: application/json
```

Body:

```json
{
  "roundId": "round-id-from-create-round",
  "guess": "higher"
}
```

Frontend example:

```js
const guessResponse = await fetch(`${BASE_URL}/api/game/guess`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json"
  },
  body: JSON.stringify({
    roundId: round.roundId,
    guess: "higher"
  })
});

const result = await guessResponse.json();
```

The response contains:

- `correct`
- `answer`
- `left`
- `right`

After guess resolution, both cards include full metric values.

Example response shape:

```json
{
  "ok": true,
  "correct": true,
  "answer": "higher",
  "left": {
    "name": "Channel A",
    "metricValue": 1200000
  },
  "right": {
    "name": "Channel B",
    "metricValue": 2500000
  }
}
```

### 6. Load another round

After each guess, call `POST /api/game/round` again.

### 7. Optional random browsing endpoint

If your frontend wants random channel cards outside the game flow:

```http
GET /api/channels/random?metric=subscribers&count=2
```

### 8. Handle errors

Typical cases:

- `404` when a round is missing or already consumed
- `410` when a round expired
- `400` when request body is invalid
- `500` when server or upstream configuration is wrong

Example:

```js
if (!roundResponse.ok) {
  const error = await roundResponse.json();
  throw new Error(error.error || "API request failed");
}
```

### 9. Admin endpoints are not for the public frontend

These routes are for project owners / maintainers:

- `/api/admin/channels/discover`
- `/api/admin/channels/sync`
- `/api/admin/channels/count`
- `/api/admin/channels/reindex`

Only game/read endpoints should be used by the public frontend.

## Secrets and auth

Public frontend developers do not need any secret key for normal gameplay endpoints.

Public endpoints:

- `GET /health`
- `GET /api/meta`
- `GET /api/channels/random`
- `GET /api/channels/:channelId`
- `GET /api/game/round`
- `POST /api/game/round`
- `POST /api/game/guess`

These can be called directly from the frontend using only the public base URL.

Private admin endpoints:

- `POST /api/admin/channels/discover`
- `POST /api/admin/channels/sync`
- `GET /api/admin/channels/count`
- `POST /api/admin/channels/reindex`

These require:

- header `x-api-key: <ADMIN_API_KEY>`

Important security rule:

- never put `ADMIN_API_KEY` in browser code
- never put `ADMIN_API_KEY` in React/Vite/Next public env vars
- never share `YOUTUBE_API_KEY` with frontend developers

The YouTube API key and admin API key stay on the API server only. A frontend developer should only receive the public base URL unless they are also trusted maintainers of the backend.

If you ever need an admin dashboard, call admin routes from a secure backend/server action, not directly from browser JavaScript.

## Admin sync

Use `POST /api/admin/channels/sync` to fetch channel data from YouTube and store it in Firestore.

Headers:

- `x-api-key: <ADMIN_API_KEY>` when `ADMIN_API_KEY` is configured

Body:

```json
{
  "channelIds": [
    "UCX6OQ3DkcsbYNE6H8uQQuVA",
    "UC-lHJZR3Gqxm24_Vd_AJ5Yw"
  ],
  "refreshRandomIndex": false
}
```

You can also send `channelIdsText` or `channelIdsCsv` as one large comma/newline-separated string.

If `channelIds` is omitted, the API falls back to `CHANNEL_IDS` from the environment. Treat `CHANNEL_IDS` as a seed list, not a hard platform limit.

For large datasets like 1,000+ channels, the easiest workflow is:

1. Put IDs in [data/channel-ids.txt](/c:/Users/User/Desktop/H-L-API/data/channel-ids.txt)
2. Call `POST /api/admin/channels/sync`
3. Check `GET /api/admin/channels/count`

## Auto discovery

YouTube does not provide a single endpoint that returns every channel on the platform. Instead, this API can discover many channels automatically using YouTube search queries, then sync those discovered channel IDs into Firestore.

Use `POST /api/admin/channels/discover` when you do not already have channel IDs.

Example body:

```json
{
  "pagesPerQuery": 2,
  "maxChannelsToSync": 1000,
  "regionCodes": ["US", "IN", "GB"],
  "refreshRandomIndex": false
}
```

The default discovery queries are stored in [data/discovery-queries.txt](/c:/Users/User/Desktop/H-L-API/data/discovery-queries.txt). You can add more queries there to widen the pool.

Important quota note:

- YouTube `search.list` costs 100 quota units per request.
- A 1,000-channel discovery run can consume a meaningful amount of quota depending on overlap and pagination.

## Local use

1. Install dependencies:

```bash
npm install
```

2. Add environment variables in `.env`.

3. Start the local Express server:

```bash
npm start
```

Optional:

- local server uses port `3000` by default
- if you need another local port, set it in the shell before running `npm start`
- example PowerShell: ``$env:PORT=4000; npm start``

4. Or run the Firebase emulator stack:

```bash
npx firebase-tools emulators:start --only functions,hosting,firestore
```

## Deploy

1. Set your Firebase project:

```bash
npx firebase-tools use <project-id>
```

2. Deploy Hosting, Functions, and Firestore config:

```bash
npx firebase-tools deploy --only functions,hosting,firestore
```

## Suggested environment variables

```env
YOUTUBE_API_KEY=your_youtube_data_api_key
ADMIN_API_KEY=your_private_admin_key
ROUND_TTL_MS=900000
CHANNELS_COLLECTION=channels
ROUNDS_COLLECTION=rounds
CHANNEL_IDS=UCX6OQ3DkcsbYNE6H8uQQuVA,UC-lHJZR3Gqxm24_Vd_AJ5Yw
```

Local-only note:

- do not put `PORT` in `.env` when deploying to Firebase Functions because Firebase reserves it
- do not put `GOOGLE_CLOUD_PROJECT` in `.env` for Firebase deploys because Firebase injects it automatically
- for local Firestore access, set `GOOGLE_APPLICATION_CREDENTIALS` in your shell instead of committing it to `.env`

## Scaling note

- Store as many channel documents as you want in Firestore.
- `count` on `/api/channels/random` is no longer hard-capped by the API code.
- The real practical limits are Firestore quotas, your project budget, and response size, not a fixed 5-channel rule.
- For 1k+ channels, prefer [data/channel-ids.txt](/c:/Users/User/Desktop/H-L-API/data/channel-ids.txt) over a giant `.env` value.
