# Render service

The one thing Convex cannot do: run a real browser and `ffmpeg`.

Most of the format engine's twenty-five formats need video surgery —
stitching, chroma key, picture-in-picture, burned-in captions — and a Convex action is neither a
browser nor an encoder. This is a separate deployable so it can scale with
render minutes rather than with users.

```bash
npm install
RENDER_SERVICE_API_KEY=<a long random string> npm start   # http://localhost:4000
```

Then point the Convex deployment at it:

```bash
npx convex env set RENDER_SERVICE_URL http://localhost:4000
npx convex env set RENDER_SERVICE_API_KEY <the same string>
```

## Requirements

- **Chrome or Edge** — set `CHROME_BIN` if it isn't in a standard location.
- **ffmpeg** on PATH — set `FFMPEG_BIN` to override.
- **`RENDER_SERVICE_API_KEY`** — required. This service fetches whatever URL a
  caller supplies and runs a real browser and ffmpeg against it, and there is
  no platform-level auth in front of it on Railway, so every route but
  `/health` rejects requests with a missing or wrong `X-Render-Key` header.
  Generate a fresh value per environment (`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`)
  — local dev and production should not share one — and set the matching
  Convex env var above so the two sides agree. Leaving it unset makes the
  service reject everything but `/health`, on purpose: refusing is safer than
  serving unauthenticated.

`GET /health` reports whether it found Chrome and ffmpeg, and whether a warm
Chrome is running (`browserWarm`), and needs no key — Railway's own
healthcheck (`railway.json`) calls it with no headers.

**One warm Chrome.** Every renderer shares a single browser, started on the
first render and given a fresh tab per render, instead of launching and
closing its own each time. It closes after `BROWSER_IDLE_MS` with nothing
open (default 5 minutes, so an idle service holds no Chrome), and is recycled
every `BROWSER_RECYCLE_AFTER` tabs (default 300) so a slow leak in Chrome
can't grow forever. A warm render of a two-slide carousel measured 0.41s
against 1.02s cold.

## Endpoints

| | Does |
| --- | --- |
| `POST /render/carousel` | A slide deck → one PNG per slide at true size, a PDF, and caption.txt |
| `POST /render/wall-of-text` | A phone clip (`videoUrl`) cover-fit to 9:16 with a full-frame text layer over it for the whole video, keeping its own sound or replacing it with `audioUrl` → an MP4. The layer is `layerHtml`, a page the format engine builds from the same style module its studio previews with; this service screenshots it transparently and overlays it. Without `layerHtml`, the older bold-text-on-a-plain-background render |
| `POST /render/slideshow` | N generated stills with Ken Burns zoom and a caption per slide, crossfaded, with optional music underneath — then optionally wrapped in uploaded bookend videos and branded title/end cards → an MP4. Voice is either one `voiceoverUrl` for the whole cut (every slide then holds exactly `secondsPerImage`, and the last is extended only if the voice outruns them) or an optional `narration` line per slide (a slide holds as long as its line takes) |
| `POST /render/video-animation` | N clips, each with an optional caption and optional dialogue audio, stitched — optionally with one `voiceoverUrl` laid across the whole cut (each clip is then trimmed to exactly its `durationSec`, so the picture keeps the voice's clock) and a looped music bed under the voice, and wrapped in uploaded bookend videos and branded title/end cards → an MP4. Also the join for Kling's chained segments |
| `POST /render/drama` | N filmed beats that keep their own lip-synced audio, with optional narration per beat, subtitles and a music bed → an MP4 |
| `POST /render/video-hook-demo` | A hook clip then a demo video (both hook + demo formats) → an MP4. When the job went through the studio, the format engine burns the caption onto the hook first through `/render/wall-of-text` and sends an empty `captionText` here. The route's own caption burn-in is only used by older jobs |
| `POST /render/green-screen-meme` | A meme (GIF, clip, sticker or still from `memeUrl`) placed over the user's own photo or video (`backgroundUrl`) and captioned. The meme is placed at `meme` = `{x, y, w, flip, chroma}` (fractions of the 9:16 frame). With `chroma` on, its green is keyed out using a key color sampled from its corner. `sound` picks the audio: `meme`, `background` or `none`. `seconds` sets the length over a still. The text layer is `layerHtml`, screenshotted like Wall of Text's and laid over everything → an MP4. Without `layerHtml`, the older render: a trending clip keyed over a still with a fixed caption |
| `POST /render/picture-in-picture` | An avatar keyed into a corner of a looping demo video → an MP4 |
| `POST /render/custom` | An upload → an MP4 at a target ratio, with optional caption and overlay. Also the caption-burn step for every avatar format, which has no renderer of its own |
| `POST /render/image-pages` | Image Slideshow's export: up to 20 full-frame HTML `pages` (built by the format engine from the same style module its editor previews with) → one JPEG (or PNG) each at `width`×`height`, uploaded to the matching entry of `uploadUrls` |
| `POST /inspect/video` | A video URL → its duration and whether it has an audio track |
| `POST /frame/first` | A video URL → its first frame, as a PNG |
| `POST /extract/audio` | A video URL → just its audio track, as an MP3 |
| `POST /pack/images` | N image URLs → one zip archive, uploaded to the given URL |
| `POST /label/ai` | A finished video or image (`mediaUrl`, `kind`) → the same with an "AI-generated" badge burned into the top-left corner (`burn`) and/or an AI tag in the MP4's metadata (`metadata`, videos only; metadata-only copies the streams without re-encoding), uploaded to `uploadUrl`. The format engine runs it when a post is scheduled with either switch on (`label.mjs`). `/health` reports `aiLabel: true` when this route exists |

Two response shapes, not one. `/render/carousel` and the single-utility
endpoints (`/inspect/video`, `/frame/first`, `/frame/last`, `/extract/audio`)
always return base64 — small enough that the round trip through JSON is
cheap. `/render/slideshow`, `/render/video-animation`, `/render/drama`, `/render/video-hook-demo`,
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

**Bookends are re-encoded, never stream-copied.** `/render/slideshow`'s
`startVideoUrl` / `endVideoUrl` and its branded cards are joined through one
`filter_complex` concat, which forces every segment to a common resolution,
frame rate and timestamp base. The old app proved why: copy-concatenating an
arbitrary upload onto generated footage through the concat *demuxer* silently
corrupts the result — a 1280x650/24fps start frame joined onto 1920x1080/30fps
content produced a file reporting ~655s for under 100s of real footage, with
the end frame dropped entirely. Audio is delayed per segment and summed rather
than concatenated, and a segment with no audio track (a still card, a silent
upload, a cut with neither voiceover nor score) gets synthesised silence of its
own length — `[N:a?]` works on `-map` but **not** on a filtergraph input pad,
where it fails the whole graph with "matches no streams".

## Known limit

Solved for the endpoints that upload straight to a signed URL instead of
round-tripping base64 through JSON. `/render/carousel` still doesn't take an
`uploadUrl` — fine for a deck of stills, wrong for a very long one, at which
point it should take the same `uploadUrl` the video endpoints do.
`/render/slideshow` used to be in the same position and wasn't fine: a
12-second cut is ~6 MiB, over Convex's 5 MiB cap on a Node action's
arguments once base64-encoded, so it now takes an `uploadUrl` too.
