# Render service

The one thing Convex cannot do: run a real browser and `ffmpeg`.

Twelve of the sixteen formats need video surgery — stitching, chroma key,
picture-in-picture, burned-in captions — and a Convex action is neither a
browser nor an encoder. This is a separate deployable so it can scale with
render minutes rather than with users.

```bash
npm install
npm start          # http://localhost:4000
```

Then point the Convex deployment at it:

```bash
npx convex env set RENDER_SERVICE_URL http://localhost:4000
```

## Requirements

- **Chrome or Edge** — set `CHROME_BIN` if it isn't in a standard location.
- **ffmpeg** on PATH — set `FFMPEG_BIN` to override.

`GET /health` reports whether it found both.

## Endpoints

| | Does |
| --- | --- |
| `POST /render/carousel` | A slide deck → one PNG per slide at true size, a PDF, and caption.txt |
| `POST /render/custom` | An upload → an MP4 at a target ratio, with optional caption and overlay |

Both return files as base64 for the caller to store.

## Two decisions worth not re-litigating

**Text goes through Chrome, not ffmpeg's `drawtext`.** Real typography,
wrapping that behaves, and no escaping minefield for arbitrary user text —
and it reuses the browser already running for carousels. The caption is
drawn into a full-frame transparent PNG and composited as an overlay.

**Framing is the user's choice, not a default.** `contain` letterboxes and
keeps the whole upload; `cover` crops to fill. A 16:9 screen recording is
unwatchable cropped into 9:16, and a photo is fine — so the tool asks
rather than guessing.

## Known limit

Files round-trip as base64 through JSON. Fine for images and short clips,
wrong for a 200MB demo video — at which point this should take a signed URL
and fetch the bytes itself.
