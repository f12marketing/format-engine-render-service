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
| `POST /render/wall-of-text` | Bold text on a plain (or colored) background → an MP4 |
| `POST /render/slideshow` | N generated stills with Ken Burns pan/zoom and a caption per slide → an MP4 |
| `POST /render/video-animation` | N clips, each with optional dialogue audio and a caption, stitched → an MP4 |
| `POST /render/video-hook-demo` | A trending clip then a demo video, caption on the hook → an MP4 |
| `POST /render/green-screen-meme` | Chroma-keys a trending clip over the user's own background → an MP4 |
| `POST /render/picture-in-picture` | An avatar keyed into a corner of a looping demo video → an MP4 |
| `POST /render/custom` | An upload → an MP4 at a target ratio, with optional caption and overlay. Also the caption-burn step for every avatar format, which has no renderer of its own |
| `POST /inspect/video` | A video URL → its duration and whether it has an audio track |
| `POST /frame/first` | A video URL → its first frame, as a PNG |
| `POST /extract/audio` | A video URL → just its audio track, as an MP3 |
| `POST /pack/images` | N image URLs → one zip archive, uploaded to the given URL |

Two response shapes, not one. `/render/carousel`, `/render/slideshow` and the
single-utility endpoints (`/inspect/video`, `/frame/first`, `/extract/audio`)
always return base64 — small enough that the round trip through JSON is
cheap. `/render/video-animation`, `/render/video-hook-demo`,
`/render/green-screen-meme`, `/render/picture-in-picture`, `/render/custom`
and `/render/wall-of-text` (which is `/render/custom` under a different
default) instead take an `uploadUrl` and upload the finished file straight to
it, returning a `storageId`; base64 there is a fallback only, kept so each
endpoint stays curl-able on its own for local testing. `/pack/images` always
uploads — a 10-50 photo zip has no small-payload case worth keeping.

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

Solved for the endpoints that upload straight to a signed URL instead of
round-tripping base64 through JSON, but `/render/carousel` and
`/render/slideshow` still don't take an `uploadUrl` — fine for a deck of
stills or a short slideshow, wrong for a long one, at which point they
should take the same `uploadUrl` the video endpoints already do.
