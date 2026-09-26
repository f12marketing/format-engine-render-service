/**
 * The ffmpeg half of the render service.
 *
 * This is the piece Convex genuinely cannot do, and the reason Railway is not
 * optional: twelve of the sixteen formats need real video surgery. Custom is
 * the one that exercises it hardest without calling a single model, which is
 * why it goes first.
 */

import { spawn } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dimensionsFor } from "./caption-styles.js";

/** Same shape as resolveBrowser: prefer an override, then the usual places. */
export function resolveFfmpeg() {
  if (process.env.FFMPEG_BIN && existsSync(process.env.FFMPEG_BIN)) {
    return process.env.FFMPEG_BIN;
  }
  return "ffmpeg"; // on PATH locally and in the Railway image
}

export function run(bin, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { windowsHide: true });
    let stderr = "";
    proc.stderr.on("data", (d) => {
      stderr += d.toString();
      // ffmpeg is verbose; keep only the tail so a failure is still readable.
      if (stderr.length > 8000) stderr = stderr.slice(-8000);
    });
    proc.on("error", reject);
    proc.on("close", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`${bin} exited ${code}\n${stderr.trim()}`)),
    );
  });
}

const EXT_BY_MIME = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
};

function extFor(mime, fallback) {
  return EXT_BY_MIME[mime] ?? fallback;
}

/**
 * Composites one source into a finished MP4 at the target dimensions.
 *
 * The filter chain is deliberately scale-then-pad rather than crop: cropping to
 * fit silently throws away the edges of someone's upload, which is a bad
 * default for a tool where the upload is the point. Letterboxing is visible and
 * reversible; a crop is neither.
 */
export async function renderCustom({
  source, // { base64, contentType } | null
  /**
   * A source fetched server-side instead of round-tripped as base64 -- the
   * fix the function's own long-standing comment already called for once
   * something bigger than a short upload needed this path. An avatar clip at
   * 30-60s/720p routinely clears what base64-in-JSON should carry, the same
   * ceiling Video Animation's stitch hit on its own output.
   */
  sourceUrl = null,
  sourceIsVideo = true,
  dimensions = "9:16",
  /** "contain" letterboxes and keeps everything; "cover" crops to fill. */
  fit = "contain",
  /** Used instead of a source when there is no upload, e.g. Wall of Text. */
  backgroundColor = null,
  durationSec = 5,
  captionPng, // Buffer | null -- a full-frame transparent overlay
  overlay, // { base64, contentType } | null
  fps = 30,
}) {
  // Wall of Text has no upload at all: the background is generated, and the
  // text layer is the entire picture. Same compositing path, one fewer input.
  const generated = !source?.base64 && !sourceUrl;
  if (generated && !backgroundColor) {
    throw new Error("a source upload or a backgroundColor is required");
  }

  const ffmpeg = resolveFfmpeg();
  const [w, h] = dimensionsFor(dimensions);
  const dir = await mkdtemp(join(tmpdir(), "fe-custom-"));

  try {
    const isVideo = generated
      ? false
      : sourceUrl
      ? sourceIsVideo
      : (source.contentType ?? "").startsWith("video/");
    const args = ["-y"];

    if (generated) {
      // lavfi synthesises the background, so no file is written at all.
      args.push(
        "-f",
        "lavfi",
        "-t",
        String(durationSec),
        "-i",
        `color=c=${backgroundColor}:s=${w}x${h}:r=${fps}`,
      );
    } else if (sourceUrl) {
      const res = await fetch(sourceUrl);
      if (!res.ok) throw new Error(`failed to fetch source: ${res.status}`);
      const srcPath = join(dir, `source.${isVideo ? "mp4" : "png"}`);
      await writeFile(srcPath, Buffer.from(await res.arrayBuffer()));
      if (isVideo) {
        args.push("-i", srcPath);
      } else {
        args.push("-loop", "1", "-t", String(durationSec), "-i", srcPath);
      }
    } else {
      const srcPath = join(
        dir,
        `source.${extFor(source.contentType, isVideo ? "mp4" : "png")}`,
      );
      await writeFile(srcPath, Buffer.from(source.base64, "base64"));
      // A still becomes a clip of the requested length; a video keeps its own.
      if (isVideo) {
        args.push("-i", srcPath);
      } else {
        args.push("-loop", "1", "-t", String(durationSec), "-i", srcPath);
      }
    }

    const filters = [];
    let last = "[0:v]";

    // Two honest options rather than one silent default. `contain` keeps the
    // whole upload and letterboxes; `cover` fills the frame and loses the
    // edges. Neither is right for every source -- a 16:9 screen recording into
    // 9:16 is unwatchable cropped, a photo is fine -- so it is the user's call.
    //
    // setsar matters in both: without it some sources carry a pixel aspect
    // ratio that makes players letterbox the result a second time.
    filters.push(
      generated
        ? `${last}setsar=1[base]`
        : fit === "cover"
        ? `${last}scale=${w}:${h}:force_original_aspect_ratio=increase,` +
            `crop=${w}:${h},setsar=1[base]`
        : `${last}scale=${w}:${h}:force_original_aspect_ratio=decrease,` +
            `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1[base]`,
    );
    last = "[base]";

    let inputIndex = 1;
    if (overlay?.base64) {
      const overlayPath = join(dir, `overlay.${extFor(overlay.contentType, "png")}`);
      await writeFile(overlayPath, Buffer.from(overlay.base64, "base64"));
      args.push("-i", overlayPath);
      // Overlays are sized against the frame, not pasted at native pixels, so
      // the same asset behaves the same way at every aspect ratio.
      filters.push(
        `[${inputIndex}:v]scale=${Math.round(w * 0.28)}:-1[ov]`,
        `${last}[ov]overlay=W-w-${Math.round(w * 0.05)}:${Math.round(h * 0.05)}[ovout]`,
      );
      last = "[ovout]";
      inputIndex += 1;
    }

    if (captionPng) {
      const capPath = join(dir, "caption.png");
      await writeFile(capPath, captionPng);
      args.push("-i", capPath);
      // Already a full-frame layer, so it lands at 0:0 with no scaling.
      filters.push(`${last}[${inputIndex}:v]overlay=0:0[capout]`);
      last = "[capout]";
      inputIndex += 1;
    }

    const outPath = join(dir, "out.mp4");
    args.push(
      "-filter_complex",
      filters.join(";"),
      "-map",
      last,
      "-r",
      String(fps),
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p", // the format every player and platform actually accepts
      "-profile:v",
      "high",
      "-preset",
      "medium",
      "-crf",
      "20",
      "-movflags",
      "+faststart", // metadata first, so it starts playing before it finishes downloading
    );

    if (isVideo) {
      // Keep the source's audio when there is any, and don't fail when there isn't.
      args.push("-map", "0:a?", "-c:a", "aac", "-b:a", "128k");
    } else {
      args.push("-an");
    }

    args.push(outPath);
    await run(ffmpeg, args);

    const buf = await readFile(outPath);
    return { buffer: buf, width: w, height: h };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Video Hook & Demo: a few seconds of a trending clip, then a hard cut to the
 * demo video -- the shape of the "trending content hook + demo" ads this
 * format copies, where the hook runs 2-6s (most often ~4s) and the demo
 * carries the rest.
 *
 * The hook is cover-fit: it is a face-to-camera clip, and filling the frame is
 * the whole look. The demo is cover-fit only when its shape is already close
 * to the frame's (a phone recording into 9:16 loses a sliver, not the UI);
 * anything further off -- a 16:9 screen recording, say -- is letterboxed on
 * black instead, which is exactly what the reference ads do. Cropping a
 * landscape demo to vertical would throw away most of the product.
 *
 * The caption sits mid-frame, TikTok-style, over the hook only by default;
 * `captionOver: "all"` keeps it up through the demo too, which about half the
 * references do.
 */
export async function renderVideoHookDemo({
  hookUrl,
  demoUrl,
  dimensions = "9:16",
  captionText = "",
  captionStyle = "Outline",
  /** How much of the trending clip to use, from its start. 0 or less keeps all of it. */
  hookSeconds = 4,
  /** "hook" (default) or "all". */
  captionOver = "hook",
  /** A background track under the whole video; null keeps the clips' own sound. */
  audioUrl = null,
  /** Mix the track under the clips' sound instead of replacing it -- for a hook that speaks. */
  keepOriginal = false,
  fps = 30,
}) {
  if (!hookUrl) throw new Error("a hook clip is required");
  if (!demoUrl) throw new Error("a demo video is required");

  const ffmpeg = resolveFfmpeg();
  const [w, h] = dimensionsFor(dimensions);
  const dir = await mkdtemp(join(tmpdir(), "fe-hookdemo-"));

  try {
    const args = ["-y"];
    const filters = [];
    let nextInputIndex = 0;

    async function fetchTo(url, name) {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`failed to fetch ${name}: ${res.status}`);
      const path = join(dir, name);
      await writeFile(path, Buffer.from(await res.arrayBuffer()));
      return path;
    }

    const hookPath = await fetchTo(hookUrl, "hook.mp4");
    const trim = Number(hookSeconds) > 0 ? Number(hookSeconds) : null;
    // An input-level -t trims video and audio together, before decoding the rest.
    if (trim) args.push("-t", String(trim));
    args.push("-i", hookPath);
    const hookIdx = nextInputIndex++;

    const demoPath = await fetchTo(demoUrl, "demo.mp4");
    args.push("-i", demoPath);
    const demoIdx = nextInputIndex++;

    // Cover when the source's aspect is within 12% of the frame's, contain
    // otherwise -- decided inside the filter from the decoded frame size, so
    // a phone video carrying rotation metadata is judged the way it plays,
    // not by its coded (sideways) width and height. `k` is 1 when the width
    // is the limiting side. crop-then-pad makes the one chain serve both
    // fits: crop only bites when the scaled frame overshoots (cover), pad
    // only when it falls short (contain).
    const r = (w / h).toFixed(6);
    // The single quotes are what keep these commas from splitting the chain.
    // XOR of two 0/1 tests, as abs(x-y): ffmpeg's expressions have no `ne`.
    const k = `abs(lt(abs(a/${r}-1),0.12)-gt(a,${r}))`;
    const demoFit =
      `scale=w='if(${k},${w},-2)':h='if(${k},-2,${h})',` +
      `crop='min(iw,${w})':'min(ih,${h})',` +
      `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black`;
    const hookFit = `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}`;

    let capIdx = null;
    if (captionText.trim()) {
      const capPng = await renderCaptionOverlay({
        text: captionText,
        style: captionStyle,
        width: w,
        height: h,
        position: "center",
        // The reference ads set the hook line larger than a caption.
        scale: 1.35,
      });
      const capPath = join(dir, "cap.png");
      await writeFile(capPath, capPng);
      args.push("-loop", "1", "-i", capPath);
      capIdx = nextInputIndex++;
    }
    const captionAll = capIdx !== null && captionOver === "all";
    // One looped caption image can only feed one overlay.
    if (capIdx !== null && !captionAll) filters.push(`[${capIdx}:v]null[caphook]`);

    // Each segment paired with its own (or a real silent) audio track --
    // concat with a=1 needs exactly one audio input per video input, same
    // requirement as renderVideoAnimation.
    async function buildSegment(inputIdx, sourcePath, label, fit, withCaption) {
      let vLabel = `v${label}`;
      filters.push(`[${inputIdx}:v]${fit},setsar=1,fps=${fps}[${vLabel}]`);
      if (withCaption) {
        filters.push(`[${vLabel}][caphook]overlay=0:0:shortest=1[vc${label}]`);
        vLabel = `vc${label}`;
      }

      const hasAudioStream = await hasAudio(sourcePath);
      const aLabel = `a${label}`;
      if (hasAudioStream) {
        filters.push(`[${inputIdx}:a]asetpts=PTS-STARTPTS[${aLabel}]`);
      } else {
        const probed = await probe(sourcePath);
        const full = Number(probed?.duration) || 5;
        const duration = label === "hook" && trim ? Math.min(trim, full) : full;
        args.push("-f", "lavfi", "-t", String(duration), "-i", "anullsrc=r=48000:cl=stereo");
        const aIdx = nextInputIndex++;
        filters.push(`[${aIdx}:a]asetpts=PTS-STARTPTS[${aLabel}]`);
      }
      return [`[${vLabel}]`, `[${aLabel}]`];
    }

    const hookPair = await buildSegment(
      hookIdx,
      hookPath,
      "hook",
      hookFit,
      capIdx !== null && !captionAll,
    );
    const demoPair = await buildSegment(demoIdx, demoPath, "demo", demoFit, false);

    filters.push(
      `${hookPair[0]}${hookPair[1]}${demoPair[0]}${demoPair[1]}concat=n=2:v=1:a=1[catv][cata]`,
    );
    filters.push(
      captionAll
        ? `[catv][${capIdx}:v]overlay=0:0:shortest=1[outv]`
        : `[catv]null[outv]`,
    );

    // A background track, cut and padded to exactly the video's length so a
    // short one never shortens the video and a long one never lengthens it
    // (same rule as Wall of Text). It replaces the clips' own sound, as there
    // -- unless `keepOriginal`, for a hook someone speaks in, where it sits
    // underneath instead of drowning the line out.
    if (audioUrl) {
      const hookDur = Number((await probe(hookPath))?.duration) || 5;
      const total = (trim ? Math.min(trim, hookDur) : hookDur) + (Number((await probe(demoPath))?.duration) || 5);
      const musicPath = await fetchTo(audioUrl, `music${audioExt(audioUrl)}`);
      args.push("-i", musicPath);
      const musicIdx = nextInputIndex++;
      const fitted = `atrim=0:${total.toFixed(3)},asetpts=PTS-STARTPTS,apad=whole_dur=${total.toFixed(3)}`;
      if (keepOriginal) {
        filters.push(
          `[${musicIdx}:a]${fitted},volume=0.25[mus]`,
          `[cata][mus]amix=inputs=2:duration=first:normalize=0[outa]`,
        );
      } else {
        // The clips' own sound still has to go somewhere: an unconnected
        // filter output fails the whole graph.
        filters.push(`[${musicIdx}:a]${fitted}[outa]`, `[cata]anullsink`);
      }
    } else {
      filters.push(`[cata]anull[outa]`);
    }

    const outPath = join(dir, "out.mp4");
    args.push(
      "-filter_complex",
      filters.join(";"),
      "-map",
      "[outv]",
      "-map",
      "[outa]",
      "-r",
      String(fps),
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-profile:v",
      "high",
      "-preset",
      "medium",
      "-crf",
      "20",
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      "-movflags",
      "+faststart",
      outPath,
    );

    await run(ffmpeg, args);
    const buf = await readFile(outPath);
    return { buffer: buf, width: w, height: h };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Green Screen Meme: a trending clip shot on a green screen, chroma-keyed and
 * composited over the user's own background image, with an optional caption
 * on top.
 *
 * `chromakey` (YUV-space, unlike the coarser RGB `colorkey`) is applied at a
 * fixed green + tolerance -- there is no color picker in the config yet, so
 * this assumes a reasonably clean green screen, which is what "trending
 * green screen meme" clips are in practice.
 */
export async function renderGreenScreenMeme({
  clipUrl,
  backgroundUrl,
  dimensions = "9:16",
  captionText = "",
  captionStyle = "Classic",
  chromaColor = "0x00FF00",
  similarity = 0.12,
  blend = 0.06,
  fps = 30,
}) {
  if (!clipUrl) throw new Error("a clip is required");
  if (!backgroundUrl) throw new Error("a background image is required");

  const ffmpeg = resolveFfmpeg();
  const [w, h] = dimensionsFor(dimensions);
  const dir = await mkdtemp(join(tmpdir(), "fe-gsmeme-"));

  try {
    const clipRes = await fetch(clipUrl);
    if (!clipRes.ok) throw new Error(`failed to fetch clip: ${clipRes.status}`);
    const clipPath = join(dir, "clip.mp4");
    await writeFile(clipPath, Buffer.from(await clipRes.arrayBuffer()));

    const bgRes = await fetch(backgroundUrl);
    if (!bgRes.ok) throw new Error(`failed to fetch background: ${bgRes.status}`);
    const bgPath = join(dir, `bg.${extFor(bgRes.headers.get("content-type"), "png")}`);
    await writeFile(bgPath, Buffer.from(await bgRes.arrayBuffer()));

    const probed = await probe(clipPath);
    const duration = Number(probed?.duration) || 6;
    const clipHasAudio = await hasAudio(clipPath);

    const args = ["-y"];
    // Background held for the clip's own duration -- looping a still, same
    // as every other generated-background path in this file.
    args.push("-loop", "1", "-t", String(duration), "-i", bgPath);
    args.push("-i", clipPath);
    let nextInputIndex = 2;

    const filters = [
      `[0:v]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},setsar=1[bg]`,
      `[1:v]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},setsar=1,` +
        `chromakey=${chromaColor}:${similarity}:${blend}[keyed]`,
      `[bg][keyed]overlay=0:0:shortest=1,fps=${fps}[composited]`,
    ];

    let last = "[composited]";
    if (captionText.trim()) {
      const capPng = await renderCaptionOverlay({
        text: captionText,
        style: captionStyle,
        width: w,
        height: h,
      });
      const capPath = join(dir, "cap.png");
      await writeFile(capPath, capPng);
      args.push("-loop", "1", "-i", capPath);
      const capIdx = nextInputIndex++;
      filters.push(`${last}[${capIdx}:v]overlay=0:0:shortest=1[capped]`);
      last = "[capped]";
    }

    const outPath = join(dir, "out.mp4");
    args.push(
      "-filter_complex",
      filters.join(";"),
      "-map",
      last,
      "-t",
      String(duration),
      "-r",
      String(fps),
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-profile:v",
      "high",
      "-preset",
      "medium",
      "-crf",
      "20",
      "-movflags",
      "+faststart",
    );

    // The clip's own sound (music, voice) is the meme's audio; the background
    // is a still image with nothing to contribute.
    if (clipHasAudio) {
      args.push("-map", "1:a", "-c:a", "aac", "-b:a", "128k");
    } else {
      args.push("-an");
    }

    args.push(outPath);
    await run(ffmpeg, args);
    const buf = await readFile(outPath);
    return { buffer: buf, width: w, height: h };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Green Screen Meme, as its studio designs it: the client's background (a
 * still or a video), a meme -- a GIF, a clip or a sticker -- moved, sized,
 * mirrored and keyed where the editor put it, and the caption layer the
 * format engine drew on top.
 *
 * The meme is composited here rather than drawn into the layer because it
 * moves: the layer page is one screenshot, and a GIF in it would freeze on
 * its first frame. Placement arrives as fractions of the 1080x1920 frame --
 * the numbers the editor's preview is positioned from -- so what was
 * dragged is what renders.
 *
 * Length: a background video sets it (up to `maxDurationSec`). Over a still,
 * `seconds` does, or -- left to us -- the meme loops whole to about six
 * seconds, so a two-second GIF isn't a two-second video.
 *
 * The meme's media is fetched from the URL given, as given, into a temp
 * directory that is removed when the render ends -- nothing of it is kept.
 */
export async function renderMemeComposite({
  backgroundUrl,
  memeUrl,
  layerPng,
  meme = {},
  sound = "meme",
  seconds = null,
  maxDurationSec = 60,
  fps = 30,
}) {
  if (!backgroundUrl) throw new Error("a background is required");
  if (!memeUrl) throw new Error("a meme is required");
  const ffmpeg = resolveFfmpeg();
  const [W, H] = dimensionsFor("9:16");
  const dir = await mkdtemp(join(tmpdir(), "fe-meme-"));

  try {
    const bg = await fetchMedia(backgroundUrl, dir, "bg", "the background");
    const mm = await fetchMedia(memeUrl, dir, "meme", "the meme");
    const layerPath = join(dir, "layer.png");
    await writeFile(layerPath, layerPng);

    const memeLen = mm.kind === "still" ? 0 : Number((await probe(mm.path))?.duration) || 0;
    let duration;
    if (bg.kind === "video") {
      duration = Math.min(Number((await probe(bg.path))?.duration) || maxDurationSec, maxDurationSec);
    } else if (Number(seconds) > 0) {
      duration = Math.min(Number(seconds), maxDurationSec);
    } else if (memeLen > 0) {
      // Whole loops, so the video ends where the meme does.
      duration = Math.min(memeLen * Math.max(1, Math.ceil(6 / memeLen)), 20);
    } else {
      duration = 6;
    }
    const t = duration.toFixed(3);

    const args = ["-y"];
    if (bg.kind === "video") args.push("-i", bg.path);
    else args.push("-loop", "1", "-framerate", String(fps), "-t", t, "-i", bg.path);
    // Every meme input repeats for the whole video: a clip or GIF loops, a still holds.
    if (mm.kind === "video") args.push("-stream_loop", "-1", "-t", t, "-i", mm.path);
    else if (mm.kind === "gif") args.push("-ignore_loop", "0", "-t", t, "-i", mm.path);
    else args.push("-loop", "1", "-framerate", String(fps), "-t", t, "-i", mm.path);
    args.push("-i", layerPath);

    const frac = (n, lo, hi, d) => Math.min(hi, Math.max(lo, Number.isFinite(Number(n)) ? Number(n) : d));
    const cx = Math.round(W * frac(meme.x, 0, 1, 0.5));
    const cy = Math.round(H * frac(meme.y, 0, 1, 0.58));
    // Even, as yuv420p wants; the height follows the meme's own shape.
    const mw = Math.max(2, Math.round((W * frac(meme.w, 0.1, 1.6, 0.86)) / 2) * 2);

    const memeChain = [`fps=${fps}`];
    if (meme.chroma) {
      const key = await keyColour(mm.path);
      memeChain.push(
        "format=yuva444p",
        key
          ? `chromakey=0x${key}:0.16:0.08`
          : // No green found in the corner: key studio green, a little looser.
            "chromakey=0x00FF00:0.22:0.1",
      );
    }
    if (meme.flip) memeChain.push("hflip");
    memeChain.push(`scale=${mw}:-2`, "format=yuva420p");

    const filters = [
      `[0:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1,fps=${fps}[bg]`,
      `[1:v]${memeChain.join(",")}[m]`,
      `[bg][m]overlay=x=${cx}-w/2:y=${cy}-h/2:eof_action=pass[c]`,
      // A single still input holds its one frame for the whole video.
      `[c][2:v]overlay=0:0[v]`,
    ];

    let audioMap = [];
    if (sound === "meme" && (await hasAudio(mm.path))) audioMap = ["-map", "1:a"];
    else if (sound === "background" && bg.kind === "video" && (await hasAudio(bg.path))) audioMap = ["-map", "0:a"];

    const outPath = join(dir, "out.mp4");
    args.push(
      "-filter_complex",
      filters.join(";"),
      "-map",
      "[v]",
      ...audioMap,
      "-t",
      t,
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-profile:v",
      "high",
      "-preset",
      "medium",
      "-crf",
      "20",
      ...(audioMap.length ? ["-c:a", "aac", "-b:a", "160k"] : ["-an"]),
      "-movflags",
      "+faststart",
      outPath,
    );
    await run(ffmpeg, args);

    return { buffer: await readFile(outPath), width: W, height: H, durationSec: duration };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Downloads one input and says what it is -- a video, an animated GIF or a
 * still -- from its Content-Type, then its URL, then its first bytes, since
 * the demuxer options a GIF and a still need differ from a video's.
 */
async function fetchMedia(url, dir, name, what) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`failed to fetch ${what}: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const type = String(res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  const ext = /\.(gif|png|jpe?g|webp|mp4|webm|mov)(?:$|\?)/i.exec(url)?.[1]?.toLowerCase();
  const magicGif = buf.subarray(0, 4).toString("latin1") === "GIF8";
  const kind =
    type === "image/gif" || ext === "gif" || magicGif
      ? "gif"
      : type.startsWith("video/") || ["mp4", "webm", "mov"].includes(ext)
        ? "video"
        : "still";
  const path = join(dir, `${name}.${kind === "gif" ? "gif" : extFor(type, ext ?? (kind === "video" ? "mp4" : "png"))}`);
  await writeFile(path, buf);
  return { path, kind };
}

/**
 * The green a meme was shot against, read from its first frame's top-left
 * corner -- green screens are rarely studio #00FF00, and keying the color
 * that's really there lets the similarity stay tight enough to spare the
 * subject. Null when that corner isn't green.
 */
function keyColour(path) {
  return new Promise((resolve) => {
    const proc = spawn(
      resolveFfmpeg(),
      ["-v", "error", "-i", path, "-frames:v", "1", "-vf", "crop=8:8:2:2,scale=1:1:flags=area", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"],
      { windowsHide: true },
    );
    const chunks = [];
    proc.stdout.on("data", (d) => chunks.push(d));
    proc.on("error", () => resolve(null));
    proc.on("close", () => {
      const px = Buffer.concat(chunks);
      if (px.length < 3) return resolve(null);
      const [r, g, b] = px;
      const green = g > 80 && g > r * 1.35 && g > b * 1.35;
      resolve(green ? [r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("").toUpperCase() : null);
    });
  });
}

/**
 * Talking Head Green Screen: an avatar clip, chroma-keyed and placed as a
 * small inset over a looping demo video, with a caption on top.
 *
 * Relies on the avatar clip actually having been generated against a keyable
 * background -- the caller (talkingHeadGreenScreen.ts) asks for that in the
 * prompt it hands the avatar-render primitive, but a video model instructed
 * to paint a green background is not the same guarantee as an actual studio
 * green screen. A visible fringe around the inset is a real, known
 * possibility, same caveat as Green Screen Meme's fixed key color.
 *
 * The avatar's own speech duration drives the total length -- it's the
 * narration pacing that matters here, not the demo's -- so the demo loops
 * (`-stream_loop -1`) to cover it rather than the other way around.
 */
export async function renderPictureInPicture({
  demoUrl,
  avatarUrl,
  dimensions = "9:16",
  pipScale = 0.42,
  pipPosition = "bottom-right",
  chromaColor = "0x00FF00",
  similarity = 0.12,
  blend = 0.06,
  captionText = "",
  captionStyle = "Classic",
  fps = 30,
}) {
  if (!demoUrl) throw new Error("a demo video is required");
  if (!avatarUrl) throw new Error("an avatar clip is required");

  const ffmpeg = resolveFfmpeg();
  const [w, h] = dimensionsFor(dimensions);
  const dir = await mkdtemp(join(tmpdir(), "fe-pip-"));

  try {
    const demoRes = await fetch(demoUrl);
    if (!demoRes.ok) throw new Error(`failed to fetch demo video: ${demoRes.status}`);
    const demoPath = join(dir, "demo.mp4");
    await writeFile(demoPath, Buffer.from(await demoRes.arrayBuffer()));

    const avatarRes = await fetch(avatarUrl);
    if (!avatarRes.ok) throw new Error(`failed to fetch avatar clip: ${avatarRes.status}`);
    const avatarPath = join(dir, "avatar.mp4");
    await writeFile(avatarPath, Buffer.from(await avatarRes.arrayBuffer()));

    const probed = await probe(avatarPath);
    const duration = Number(probed?.duration) || 15;
    const avatarHasAudio = await hasAudio(avatarPath);

    const pipW = Math.round(w * pipScale);
    const pipH = Math.round(h * pipScale);
    const margin = Math.round(w * 0.04);
    const [pipX, pipY] = {
      "bottom-right": [`W-w-${margin}`, `H-h-${margin}`],
      "bottom-left": [`${margin}`, `H-h-${margin}`],
      "top-right": [`W-w-${margin}`, `${margin}`],
      "top-left": [`${margin}`, `${margin}`],
    }[pipPosition] ?? [`W-w-${margin}`, `H-h-${margin}`];

    const args = ["-y", "-stream_loop", "-1", "-i", demoPath, "-i", avatarPath];

    const filters = [
      `[0:v]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},setsar=1[bg]`,
      `[1:v]scale=${pipW}:${pipH}:force_original_aspect_ratio=increase,crop=${pipW}:${pipH},setsar=1,` +
        `chromakey=${chromaColor}:${similarity}:${blend}[keyed]`,
      `[bg][keyed]overlay=${pipX}:${pipY}:shortest=1,fps=${fps}[composited]`,
    ];

    let last = "[composited]";
    let nextInputIndex = 2;
    if (captionText.trim()) {
      const capPng = await renderCaptionOverlay({
        text: captionText,
        style: captionStyle,
        width: w,
        height: h,
      });
      const capPath = join(dir, "cap.png");
      await writeFile(capPath, capPng);
      args.push("-loop", "1", "-i", capPath);
      const capIdx = nextInputIndex++;
      filters.push(`${last}[${capIdx}:v]overlay=0:0:shortest=1[capped]`);
      last = "[capped]";
    }

    const outPath = join(dir, "out.mp4");
    args.push(
      "-filter_complex",
      filters.join(";"),
      "-map",
      last,
      "-t",
      String(duration),
      "-r",
      String(fps),
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-profile:v",
      "high",
      "-preset",
      "medium",
      "-crf",
      "20",
      "-movflags",
      "+faststart",
    );

    // The avatar's own voice is the ad's only audio; the looping demo footage
    // contributes nothing and is muted by omission.
    if (avatarHasAudio) {
      args.push("-map", "1:a", "-c:a", "aac", "-b:a", "128k");
    } else {
      args.push("-an");
    }

    args.push(outPath);
    await run(ffmpeg, args);
    const buf = await readFile(outPath);
    return { buffer: buf, width: w, height: h };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Video Animation's final assembly: N already-generated clips, each with its
 * own optional dialogue audio and optional caption, concatenated into one
 * video with continuous audio.
 *
 * Every clip gets an audio track whether it has dialogue or not -- a real
 * track of silence for quiet shots, never a missing one -- because `concat`
 * with `a=1` needs exactly one audio input per video input; mixing "some
 * segments have audio, some don't" would need a second, harder-to-verify
 * code path for no real benefit.
 *
 * `extendToAudio` is for a single narrated clip (the format engine's
 * narrated formats): a shot whose narration outlasts its clip is lengthened
 * to the narration, holding the clip's last frame, instead of the voice
 * being cut off mid-sentence. Off by default, so Video Animation's per-shot
 * timing is unchanged.
 */
export async function renderVideoAnimation({
  shots, // [{ videoUrl, audioUrl: string|null, durationSec, caption: string|null }]
  dimensions = "16:9",
  captionStyle = "Classic",
  fps = 30,
  extendToAudio = false,
  // ONE continuous voiceover laid across the whole cut, on top of the concat.
  // Each clip is trimmed to exactly its durationSec so the picture keeps the
  // same clock as the voice (clips run a frame or two off what was asked, and
  // twenty of those is a second of drift).
  voiceoverUrl = null,
  musicUrl = null, // a score, looped and ducked under any dialogue
  musicVolume = 0.14, // under a voice; a cut with no dialogue at all runs it louder
}) {
  if (!shots?.length) throw new Error("at least one shot is required");
  const exactLengths = extendToAudio || Boolean(voiceoverUrl);

  const ffmpeg = resolveFfmpeg();
  const [w, h] = dimensionsFor(dimensions);
  const dir = await mkdtemp(join(tmpdir(), "fe-video-"));

  try {
    const args = ["-y"];
    const filters = [];
    const segmentPairs = [];
    let nextInputIndex = 0;
    // The finished timeline's length, summed as each segment is built: the
    // score is trimmed and faded against it, and it cannot be known earlier
    // because extendToAudio can lengthen a segment past its requested time.
    let total = 0;

    for (let i = 0; i < shots.length; i += 1) {
      const shot = shots[i];
      const duration = shot.durationSec || 5;

      const vidRes = await fetch(shot.videoUrl);
      if (!vidRes.ok) throw new Error(`failed to fetch clip ${i}: ${vidRes.status}`);
      const vidPath = join(dir, `clip_${i}.mp4`);
      await writeFile(vidPath, Buffer.from(await vidRes.arrayBuffer()));
      args.push("-i", vidPath);
      const vIdx = nextInputIndex++;

      // Fetched before the video filter is built, because with
      // extendToAudio its length decides how long this segment runs.
      let audPath = null;
      if (shot.audioUrl) {
        const audRes = await fetch(shot.audioUrl);
        if (!audRes.ok) throw new Error(`failed to fetch audio ${i}: ${audRes.status}`);
        audPath = join(dir, `audio_${i}.mp3`);
        await writeFile(audPath, Buffer.from(await audRes.arrayBuffer()));
      }
      let length = duration;
      if (extendToAudio && audPath) {
        const spoken = Number((await probe(audPath))?.duration);
        if (Number.isFinite(spoken) && spoken > length) length = spoken;
      }
      total += length;

      // Cover-fit, not letterbox: a generated clip is already meant to fill
      // the frame at roughly this aspect, so a crop here is a rounding
      // correction, not a real loss the way it would be on someone's upload.
      // With extendToAudio, tpad holds the last frame and trim lands the
      // segment on exactly `length`, whatever the clip's own length.
      let vLabel = `v${i}`;
      filters.push(
        `[${vIdx}:v]scale=${w}:${h}:force_original_aspect_ratio=increase,` +
          `crop=${w}:${h},setsar=1,fps=${fps}` +
          (exactLengths
            ? `,tpad=stop_mode=clone:stop_duration=${length},` +
              `trim=duration=${length},setpts=PTS-STARTPTS`
            : "") +
          `[${vLabel}]`,
      );

      if (shot.caption && shot.caption.trim()) {
        const capPng = await renderCaptionOverlay({
          text: shot.caption,
          style: captionStyle,
          width: w,
          height: h,
        });
        const capPath = join(dir, `cap_${i}.png`);
        await writeFile(capPath, capPng);
        args.push("-loop", "1", "-i", capPath);
        const capIdx = nextInputIndex++;
        // shortest=1 for the same reason as the slideshow renderer: the
        // caption PNG is looped indefinitely, and without this the overlay
        // would run until that infinite input ends, i.e. never.
        filters.push(`[${vLabel}][${capIdx}:v]overlay=0:0:shortest=1[vc${i}]`);
        vLabel = `vc${i}`;
      }

      const aLabel = `a${i}`;
      if (audPath) {
        args.push("-i", audPath);
        const aIdx = nextInputIndex++;
        // TTS rarely lands exactly on the clip's duration: atrim cuts it down
        // if it ran long, apad's whole_dur pads with silence if it ran short.
        // Together they guarantee this segment is exactly `length` long,
        // which concat's audio stream requires to stay in sync with its video.
        // (With extendToAudio, `length` already covers the whole narration,
        // so the atrim no longer cuts anything spoken.)
        filters.push(
          `[${aIdx}:a]atrim=0:${length},apad=whole_dur=${length},` +
            `asetpts=PTS-STARTPTS[${aLabel}]`,
        );
      } else {
        // A real silent track, not a missing one -- see the function comment.
        args.push("-f", "lavfi", "-t", String(length), "-i", "anullsrc=r=48000:cl=stereo");
        const aIdx = nextInputIndex++;
        filters.push(`[${aIdx}:a]asetpts=PTS-STARTPTS[${aLabel}]`);
      }

      segmentPairs.push(`[${vLabel}][${aLabel}]`);
    }

    filters.push(`${segmentPairs.join("")}concat=n=${shots.length}:v=1:a=1[outv][outa]`);

    // An optional score, mixed under whatever dialogue the cut has. Added
    // after the concat rather than per segment: one continuous bed that runs
    // across the joins is what a score is, and a per-shot one would restart
    // at every cut.
    let audioMap = "[outa]";
    let audioLabel = "outa";
    if (voiceoverUrl) {
      const voicePath = join(dir, `voiceover${audioExt(voiceoverUrl)}`);
      await fetchTo(voiceoverUrl, voicePath, "voiceover");
      args.push("-i", voicePath);
      const vIdx = nextInputIndex++;
      // Padded to the cut's length so the mix below, which follows its first
      // input, runs to the last frame. The per-shot audio underneath is silence.
      filters.push(
        `[${vIdx}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,` +
          `apad=whole_dur=${total.toFixed(3)}[voice]`,
      );
      filters.push("[outa][voice]amix=inputs=2:duration=first:normalize=0[voiced]");
      audioMap = "[voiced]";
      audioLabel = "voiced";
    }
    if (musicUrl) {
      const musicPath = join(dir, `music${audioExt(musicUrl)}`);
      await fetchTo(musicUrl, musicPath, "music");
      // Looped, so a bed that comes back shorter than the cut still runs to
      // the last frame instead of dropping out. Pushed after every shot's
      // inputs, so its index is simply the next one.
      args.push("-stream_loop", "-1", "-i", musicPath);
      const mIdx = nextInputIndex++;
      const hasDialogue = shots.some((s) => s.audioUrl) || Boolean(voiceoverUrl);
      const volume = hasDialogue ? musicVolume : 0.5;
      filters.push(
        `[${mIdx}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,` +
          `atrim=0:${total.toFixed(3)},asetpts=PTS-STARTPTS,volume=${volume},` +
          `afade=t=in:d=0.8,afade=t=out:st=${Math.max(0, total - 1.5).toFixed(3)}:d=1.5[music]`,
      );
      // normalize=0 keeps the dialogue at its own level instead of halving
      // it; the limiter catches the rare peak where the two sum past 0 dBFS.
      filters.push(
        `[${audioLabel}][music]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.97[mixed]`,
      );
      audioMap = "[mixed]";
    }

    const outPath = join(dir, "out.mp4");
    args.push(
      "-filter_complex",
      filters.join(";"),
      "-map",
      "[outv]",
      "-map",
      audioMap,
      "-r",
      String(fps),
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-profile:v",
      "high",
      "-preset",
      "medium",
      "-crf",
      "20",
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      "-movflags",
      "+faststart",
      outPath,
    );

    await run(ffmpeg, args);
    const buf = await readFile(outPath);
    return { buffer: buf, width: w, height: h };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Drama's final cut: N filmed beats concatenated, keeping each clip's OWN
 * audio. That is the difference from Video Animation's stitch, which swaps a
 * clip's sound for separately generated dialogue -- here Seedance has already
 * spoken the line inside the clip, lip-synced, so replacing its audio would
 * throw the performance away.
 *
 * Narration beats get their voice-over laid on top with the clip's own
 * ambience ducked under it, and an optional music bed runs under the whole
 * episode, faded out at the end.
 *
 * Each segment is cut to its clip's real, probed length rather than the
 * requested one: Seedance lands within a frame or two of what was asked, and
 * trusting the probe keeps audio and picture in step across the concat.
 */
export async function renderDrama({
  beats, // [{ videoUrl, voiceoverUrl: string|null, caption: string|null, durationSec }]
  dimensions = "9:16",
  captionStyle = "Classic",
  musicUrl = null,
  musicVolume = 0.14,
  fps = 30,
}) {
  if (!beats?.length) throw new Error("at least one beat is required");

  const ffmpeg = resolveFfmpeg();
  const [w, h] = dimensionsFor(dimensions);
  const dir = await mkdtemp(join(tmpdir(), "fe-drama-"));
  // Every audio branch is brought to one format before it meets concat or
  // amix -- Seedance, IndexTTS and ElevenLabs don't agree on sample rate.
  const toStereo48k = "aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo";

  try {
    const args = ["-y"];
    const filters = [];
    const segmentPairs = [];
    let nextInputIndex = 0;
    let total = 0;

    for (let i = 0; i < beats.length; i += 1) {
      const beat = beats[i];

      const vidPath = join(dir, `clip_${i}.mp4`);
      await fetchTo(beat.videoUrl, vidPath, `clip ${i}`);
      const [info, withAudio] = await Promise.all([probe(vidPath), hasAudio(vidPath)]);
      const duration = Number(info?.duration) || beat.durationSec || 5;
      total += duration;

      args.push("-i", vidPath);
      const vIdx = nextInputIndex++;
      let vLabel = `v${i}`;
      filters.push(
        `[${vIdx}:v]trim=duration=${duration},setpts=PTS-STARTPTS,` +
          `scale=${w}:${h}:force_original_aspect_ratio=increase,` +
          `crop=${w}:${h},setsar=1,fps=${fps}[${vLabel}]`,
      );

      if (beat.caption && beat.caption.trim()) {
        const capPng = await renderCaptionOverlay({
          text: beat.caption,
          style: captionStyle,
          width: w,
          height: h,
        });
        const capPath = join(dir, `cap_${i}.png`);
        await writeFile(capPath, capPng);
        args.push("-loop", "1", "-i", capPath);
        const capIdx = nextInputIndex++;
        filters.push(`[${vLabel}][${capIdx}:v]overlay=0:0:shortest=1[vc${i}]`);
        vLabel = `vc${i}`;
      }

      // The clip's own sound, or a real silent track when it has none -- the
      // same one-audio-per-video rule concat imposes in renderVideoAnimation.
      let aLabel = `ca${i}`;
      if (withAudio) {
        filters.push(
          `[${vIdx}:a]${toStereo48k},atrim=0:${duration},apad=whole_dur=${duration},` +
            `asetpts=PTS-STARTPTS[${aLabel}]`,
        );
      } else {
        args.push("-f", "lavfi", "-t", String(duration), "-i", "anullsrc=r=48000:cl=stereo");
        const sIdx = nextInputIndex++;
        filters.push(`[${sIdx}:a]${toStereo48k},asetpts=PTS-STARTPTS[${aLabel}]`);
      }

      if (beat.voiceoverUrl) {
        const voPath = join(dir, `vo_${i}${audioExt(beat.voiceoverUrl)}`);
        await fetchTo(beat.voiceoverUrl, voPath, `voice-over ${i}`);
        args.push("-i", voPath);
        const oIdx = nextInputIndex++;
        filters.push(
          `[${oIdx}:a]${toStereo48k},atrim=0:${duration},apad=whole_dur=${duration},` +
            `asetpts=PTS-STARTPTS[vo${i}]`,
        );
        filters.push(`[${aLabel}]volume=0.35[duck${i}]`);
        filters.push(`[duck${i}][vo${i}]amix=inputs=2:duration=first:normalize=0[a${i}]`);
        aLabel = `a${i}`;
      }

      segmentPairs.push(`[${vLabel}][${aLabel}]`);
    }

    filters.push(`${segmentPairs.join("")}concat=n=${beats.length}:v=1:a=1[outv][cut]`);

    let outA = "cut";
    if (musicUrl) {
      const musicPath = join(dir, `music${audioExt(musicUrl)}`);
      await fetchTo(musicUrl, musicPath, "music");
      // Looped, so a score that comes back shorter than the cut still runs
      // to the last frame instead of dropping out.
      args.push("-stream_loop", "-1", "-i", musicPath);
      const mIdx = nextInputIndex++;
      const fadeStart = Math.max(0, total - 1.5);
      filters.push(
        `[${mIdx}:a]${toStereo48k},atrim=0:${total},asetpts=PTS-STARTPTS,` +
          `volume=${musicVolume},afade=t=out:st=${fadeStart}:d=1.5[music]`,
      );
      // normalize=0 keeps the dialogue at its own level instead of halving
      // it; the limiter catches the rare peak where the two sum past 0 dBFS.
      filters.push(
        `[cut][music]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.97[scored]`,
      );
      outA = "scored";
    }

    const outPath = join(dir, "out.mp4");
    args.push(
      "-filter_complex",
      filters.join(";"),
      "-map",
      "[outv]",
      "-map",
      `[${outA}]`,
      "-r",
      String(fps),
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-profile:v",
      "high",
      "-preset",
      "medium",
      "-crf",
      "20",
      "-c:a",
      "aac",
      "-b:a",
      "160k",
      "-movflags",
      "+faststart",
      outPath,
    );

    await run(ffmpeg, args);
    const buf = await readFile(outPath);
    return { buffer: buf, width: w, height: h };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function fetchTo(url, path, what) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`failed to fetch ${what}: ${res.status}`);
  await writeFile(path, Buffer.from(await res.arrayBuffer()));
}

/** Keep the source's extension so ffmpeg's demuxer probe gets an honest hint. */
function audioExt(url) {
  const m = /\.(mp3|wav|m4a|aac|ogg|opus|flac)(?:$|\?)/i.exec(String(url));
  return m ? `.${m[1].toLowerCase()}` : ".mp3";
}

/**
 * A Ken Burns slideshow: N stills, each held with a slow centred zoom and an
 * optional caption burned onto it, crossfaded into one clip. Optionally a
 * voice line per slide -- a slide stays up as long as its line needs, never
 * less than `secondsPerImage` -- and a score looped underneath.
 *
 * Built as one filter_complex graph rather than N renders + a concat pass --
 * fewer intermediate files, and one encode instead of N+1.
 */
let renderCaptionOverlay = null;
export function setCaptionRenderer(fn) {
  renderCaptionOverlay = fn;
}

/**
 * Branded title/end cards, like the caption layers, need Chrome -- which this
 * module cannot launch. server.mjs hands the renderer in at startup, same as
 * it does for captions.
 */
let renderBrandCard = null;
export function setCardRenderer(fn) {
  renderBrandCard = fn;
}

export async function renderSlideshow({
  images, // [{ url } | { base64, contentType }]
  captions = [], // same length as images, "" for no caption on that slide
  dimensions = "9:16",
  secondsPerImage = 3, // the FLOOR for how long a slide stays up; a longer voice line stretches it
  captionStyle = "Classic",
  fps = 30,
  narration = [], // same length as images: an audio URL, or a falsy value for no voice on that slide
  // ONE continuous voiceover the whole cut is built around. When given, every
  // slide holds for exactly secondsPerImage (the slide count was fitted to the
  // voice, not the other way round) and `narration` is ignored.
  voiceoverUrl = null,
  musicUrl = null, // a score, looped and ducked under the voice
  transition = "fade", // an ffmpeg xfade transition name, or "none" for hard cuts
  transitionSeconds = 0.5,
  musicVolume = 0.14, // under a voice, matching the drama cut; a music-only cut runs louder
}) {
  if (!images?.length) throw new Error("at least one image is required");

  const ffmpeg = resolveFfmpeg();
  const [w, h] = dimensionsFor(dimensions);
  const dir = await mkdtemp(join(tmpdir(), "fe-slideshow-"));
  const n = images.length;
  // Every audio branch is brought to one format before it meets amix --
  // ElevenLabs speech and a music model don't agree on sample rate.
  const toStereo48k = "aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo";
  const d = transition === "none" || n < 2 ? 0 : transitionSeconds;

  try {
    // Narration first. How long a slide stays up is decided by how long its
    // line takes to say, so each clip is fetched and measured before any
    // video is built -- a fixed 3 seconds would cut a 5-second sentence off.
    let voiceoverPath = null;
    let voiceoverSecs = 0;
    if (voiceoverUrl) {
      voiceoverPath = join(dir, `voiceover${audioExt(voiceoverUrl)}`);
      await fetchTo(voiceoverUrl, voiceoverPath, "voiceover");
      voiceoverSecs = Number((await probe(voiceoverPath))?.duration);
      if (!Number.isFinite(voiceoverSecs) || voiceoverSecs <= 0) {
        throw new Error("could not read the length of the voiceover");
      }
    }

    const voicePaths = [];
    const voiceSecs = [];
    const perSlide = voiceoverPath ? [] : narration;
    for (let i = 0; i < n; i += 1) {
      const url = perSlide[i];
      if (!url) {
        voicePaths.push(null);
        voiceSecs.push(0);
        continue;
      }
      const p = join(dir, `voice_${i}${audioExt(url)}`);
      await fetchTo(url, p, `narration for slide ${i}`);
      const info = await probe(p);
      const secs = Number(info?.duration);
      if (!Number.isFinite(secs) || secs <= 0) {
        throw new Error(`could not read the length of the narration for slide ${i}`);
      }
      voicePaths.push(p);
      voiceSecs.push(secs);
    }

    // The voice starts once the slide has finished fading in (or 0.3s into the
    // first one, which has no fade) and ends a beat before the next cut.
    const VOICE_TAIL = 0.35;
    const lead = (i) => (i === 0 ? 0.3 : d);
    // hold[i] is how much of the FINISHED timeline slide i owns; start[i] where
    // it begins. Their sum is the video's length. The crossfade INTO slide i
    // runs over [start[i], start[i] + d].
    const hold = images.map((_, i) => {
      const spoken = voiceSecs[i] ? lead(i) + voiceSecs[i] + VOICE_TAIL : 0;
      return Math.round(Math.max(secondsPerImage, spoken) * 1000) / 1000;
    });
    // A single voiceover can outrun the slides by a hair when its length is a
    // near-exact multiple of the slide time: hold the last slide so it is never cut.
    if (voiceoverPath) {
      const shortBy = voiceoverSecs - hold.reduce((sum, h) => sum + h, 0);
      if (shortBy > 0) hold[hold.length - 1] = Math.round((hold[hold.length - 1] + shortBy) * 1000) / 1000;
    }
    const start = [];
    let total = 0;
    for (const s of hold) {
      start.push(total);
      total += s;
    }

    const args = ["-y"];
    const filters = [];
    const segmentLabels = [];
    // Tracks the real ffmpeg input index as args are built. Images are pushed
    // first, then (below) one caption per captioned slide, then the audio.
    // An earlier version pushed a slide and its caption back-to-back and got
    // the index arithmetic wrong, pulling the WRONG slide's caption onto every
    // segment; keeping one counter that every push goes through is what
    // prevents that.
    let nextInputIndex = 0;

    for (let i = 0; i < n; i += 1) {
      const img = images[i];
      const ext = img.contentType ? extFor(img.contentType, "png") : "png";
      const imgPath = join(dir, `slide_${i}.${ext}`);
      if (img.base64) {
        await writeFile(imgPath, Buffer.from(img.base64, "base64"));
      } else if (img.url) {
        const res = await fetch(img.url);
        if (!res.ok) throw new Error(`failed to fetch slide ${i}: ${res.status}`);
        await writeFile(imgPath, Buffer.from(await res.arrayBuffer()));
      } else {
        throw new Error(`slide ${i} has neither url nor base64`);
      }

      // A slide is rendered `d` seconds longer than it owns (except the last),
      // because the next one crossfades in over its tail.
      const segSeconds = hold[i] + (i < n - 1 ? d : 0);
      // ...and, when crossfading, one frame longer again: see the fps note below.
      const trimSeconds = segSeconds + (d > 0 ? 1 / fps : 0);
      const frames = Math.ceil(trimSeconds * fps);

      // No -t on the input. zoompan restarts its full d-frame zoom cycle for
      // EVERY input frame it receives, not once overall -- so `-loop 1 -t N`
      // here (N seconds of a looped image, at the demuxer's implicit ~25fps)
      // fed roughly N*25 input frames through the filter, each triggering
      // another full d-frame cycle. A 2-second slide came out 100 seconds
      // long before this comment existed. The `trim` filter below is what
      // actually bounds each segment; input duration must be left uncapped.
      args.push("-loop", "1", "-i", imgPath);
      const imgInputIndex = nextInputIndex++;

      // Scale well past the frame before zoompan, or a source already near
      // WxH runs out of resolution to zoom into and the shot judders.
      // Centred zoom-in only: safe regardless of subject placement, unlike a
      // pan, which can drift a generated image's subject off-frame.
      //
      // No caption here: one burned in now would crossfade WITH its slide,
      // leaving two captions blended into mush for half a second at every
      // cut. Captions go on after the join instead.
      //
      // xfade, unlike concat, needs every input to have a known constant frame
      // rate, and zoompan's own fps= option does not give the link one -- an
      // explicit fps filter does. That filter drops the LAST frame of each
      // segment (measured: 89 frames out of a 3s/30fps segment, with or
      // without eof_action=pass), which is why each segment was rendered one
      // frame long above. Hard cuts go through concat, which needs none of
      // this and keeps its exact frame count.
      filters.push(
        `[${imgInputIndex}:v]scale=${w * 2}:${h * 2}:force_original_aspect_ratio=increase,` +
          `crop=${w * 2}:${h * 2},` +
          `zoompan=z='min(zoom+0.0012,1.3)':d=${frames}:` +
          `x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${w}x${h}:fps=${fps},` +
          `setsar=1,trim=duration=${trimSeconds.toFixed(3)},setpts=PTS-STARTPTS,` +
          (d > 0 ? `fps=${fps},` : "") +
          `format=yuv420p[seg${i}]`,
      );
      segmentLabels.push(`[seg${i}]`);
    }

    if (d > 0) {
      // Each join starts `d` seconds before the outgoing slide's hold ends, so
      // the timeline still adds up to exactly `total`.
      let current = segmentLabels[0];
      let offset = 0;
      for (let i = 1; i < n; i += 1) {
        offset += hold[i - 1];
        const out = i === n - 1 ? "joined" : `xf${i}`;
        filters.push(
          `${current}${segmentLabels[i]}xfade=transition=${transition}:` +
            `duration=${d}:offset=${offset.toFixed(3)}[${out}]`,
        );
        current = `[${out}]`;
      }
    } else {
      filters.push(`${segmentLabels.join("")}concat=n=${n}:v=1:a=0[joined]`);
    }

    // Captions, onto the finished timeline. Slide i's is up while that slide is
    // fully on screen: from the end of the fade into it to the start of the
    // fade out of it, so at a cut there is a beat with none rather than two.
    let videoLabel = "joined";
    for (let i = 0; i < n; i += 1) {
      const caption = captions[i];
      if (!caption || !caption.trim()) continue;
      const capPng = await renderCaptionOverlay({
        text: caption,
        style: captionStyle,
        width: w,
        height: h,
      });
      const capPath = join(dir, `cap_${i}.png`);
      await writeFile(capPath, capPng);
      args.push("-loop", "1", "-i", capPath);
      const capInputIndex = nextInputIndex++;
      const from = i === 0 ? 0 : start[i] + d;
      const to = i === n - 1 ? total : start[i + 1];
      // `overlay` defaults to running for as long as its LONGER input lasts
      // (shortest=0), duplicating the shorter stream's last frame to keep
      // pace -- so pairing the finished video with an infinitely looped
      // caption PNG would produce an endless output. `shortest=1` ends it
      // with the video, which is what "one caption per slide" means.
      const out = `cap${i}`;
      filters.push(
        `[${videoLabel}][${capInputIndex}:v]overlay=0:0:shortest=1:` +
          `enable='between(t,${from.toFixed(3)},${to.toFixed(3)})'[${out}]`,
      );
      videoLabel = out;
    }
    filters.push(`[${videoLabel}]format=yuv420p[outv]`);

    // ---- audio -----------------------------------------------------------
    const voiceLabels = [];
    if (voiceoverPath) {
      // Starts with the first slide, not a beat into it: window i of the script
      // was cut for slide i, so the voice and the picture share a clock.
      args.push("-i", voiceoverPath);
      const idx = nextInputIndex++;
      filters.push(`[${idx}:a]${toStereo48k}[vo0]`);
      voiceLabels.push("[vo0]");
    }
    voicePaths.forEach((p, i) => {
      if (!p) return;
      args.push("-i", p);
      const idx = nextInputIndex++;
      const ms = Math.round((start[i] + lead(i)) * 1000);
      filters.push(`[${idx}:a]${toStereo48k},adelay=${ms}|${ms}[vo${i}]`);
      voiceLabels.push(`[vo${i}]`);
    });
    let voiceOut = null;
    if (voiceLabels.length) {
      // Padded to the video's length so the mix below, which follows its first
      // input, runs to the last frame.
      filters.push(
        `${voiceLabels.join("")}amix=inputs=${voiceLabels.length}:duration=longest:normalize=0,` +
          `apad=whole_dur=${total.toFixed(3)}[voice]`,
      );
      voiceOut = "voice";
    }

    let musicOut = null;
    if (musicUrl) {
      const musicPath = join(dir, `music${audioExt(musicUrl)}`);
      await fetchTo(musicUrl, musicPath, "music");
      // Looped, so a score that comes back shorter than the video still runs
      // to the last frame instead of dropping out.
      args.push("-stream_loop", "-1", "-i", musicPath);
      const mIdx = nextInputIndex++;
      const volume = voiceOut ? musicVolume : 0.5;
      filters.push(
        `[${mIdx}:a]${toStereo48k},atrim=0:${total.toFixed(3)},asetpts=PTS-STARTPTS,` +
          `volume=${volume},afade=t=in:d=0.8,` +
          `afade=t=out:st=${Math.max(0, total - 1.5).toFixed(3)}:d=1.5[music]`,
      );
      musicOut = "music";
    }

    let audioOut = voiceOut ?? musicOut;
    if (voiceOut && musicOut) {
      // normalize=0 keeps the voice at its own level instead of halving it;
      // the limiter catches the rare peak where the two sum past 0 dBFS.
      filters.push(
        "[voice][music]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.97[mixed]",
      );
      audioOut = "mixed";
    }

    const outPath = join(dir, "out.mp4");
    args.push("-filter_complex", filters.join(";"), "-map", "[outv]");
    if (audioOut) {
      args.push("-map", `[${audioOut}]`, "-c:a", "aac", "-b:a", "160k", "-ar", "48000");
    }
    args.push(
      "-r",
      String(fps),
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-profile:v",
      "high",
      "-preset",
      "medium",
      "-crf",
      "20",
      "-movflags",
      "+faststart",
    );
    if (!audioOut) args.push("-an");
    args.push("-t", total.toFixed(3), outPath);

    await run(ffmpeg, args);
    const buf = await readFile(outPath);
    return { buffer: buf, width: w, height: h, durationSec: total };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** How long a branded card stays up. The old app's Remotion cards' timings. */
const TITLE_CARD_SECONDS = 3;
const END_CARD_SECONDS = 5;

/**
 * Whether a file carries an audio stream at all.
 *
 * `probe` above answers only about video (`-select_streams v:0`), and the
 * difference matters: a filtergraph pad aimed at an input with no audio
 * fails the entire render rather than being skipped. Treated as "no" when
 * ffprobe can't be run, which is the safe direction -- silence is
 * synthesised and the render still completes.
 */
async function hasAudioStream(path) {
  const ffprobe = process.env.FFPROBE_BIN || "ffprobe";
  return new Promise((resolve) => {
    const proc = spawn(
      ffprobe,
      ["-v", "error", "-select_streams", "a", "-show_entries", "stream=codec_type", "-of", "json", path],
      { windowsHide: true },
    );
    let out = "";
    proc.stdout.on("data", (d) => (out += d.toString()));
    proc.on("error", () => resolve(false));
    proc.on("close", () => {
      try {
        resolve((JSON.parse(out).streams ?? []).length > 0);
      } catch {
        resolve(false);
      }
    });
  });
}

/**
 * Wraps a finished cut in uploaded bookend videos and branded cards:
 *
 *     [start frame] [title card] << the cut >> [end card] [end frame]
 *
 * Every segment is RE-ENCODED through one filter_complex concat rather than
 * stream-copied through the concat demuxer. That is not caution, it is a
 * measured failure: bookend frames are arbitrary user uploads with no
 * guaranteed resolution, frame rate or container time_base, and the old app
 * found that copy-concatenating mismatched inputs silently corrupts the
 * result -- a 1280x650/24fps start frame joined onto 1920x1080/30fps content
 * produced a file reporting ~655s for under 100s of real footage, with the
 * end frame dropped entirely (worker/pipeline.py, _concat_bookend_frames).
 * Routing every segment through one graph forces a common resolution, frame
 * rate and timestamp base, so both duration and playback come out right.
 *
 * Audio is delayed per segment and summed rather than concatenated: each
 * segment's own audio is offset to its absolute start and mixed, so segments
 * without any (a silent card, a muted upload) leave a real gap instead of
 * needing a filter to infer where one ends. `apad` gives every segment the
 * full-length silent bed that makes that arithmetic hold.
 *
 * Returns the original buffer untouched when there is nothing to wrap, so
 * the caller never pays for a re-encode it didn't ask for.
 */
export async function wrapWithBookends({
  buffer, // the finished cut
  width,
  height,
  fps = 30,
  startVideoUrl = null,
  endVideoUrl = null,
  branding = null, // { name, tagline, closingMessage, colours, fontFamily, logoUrl }
}) {
  const wantsCards = Boolean(branding && (branding.name || branding.closingMessage));
  if (!startVideoUrl && !endVideoUrl && !wantsCards) {
    return { buffer, width, height };
  }

  const ffmpeg = resolveFfmpeg();
  const dir = await mkdtemp(join(tmpdir(), "fe-bookend-"));

  try {
    const contentPath = join(dir, "content.mp4");
    await writeFile(contentPath, buffer);

    /**
     * The timeline, in order. `seconds` is known up front for a card (it is a
     * still we hold) and probed for an upload -- the concat filter needs a
     * duration per segment to place the next one's audio.
     */
    const segments = [];

    const addUpload = async (url, name) => {
      const path = join(dir, `${name}.mp4`);
      await fetchTo(url, path, `${name} frame`);
      const info = await probe(path);
      const seconds = Number(info?.duration);
      if (!Number.isFinite(seconds) || seconds <= 0) {
        throw new Error(
          `could not read the length of the ${name} frame -- is it a valid video file?`,
        );
      }
      segments.push({ path, seconds, still: false, hasAudio: await hasAudioStream(path) });
    };

    const addCard = async (kind, seconds) => {
      if (!renderBrandCard) throw new Error("no brand-card renderer was registered");
      const png = await renderBrandCard({ ...branding, kind, width, height });
      const path = join(dir, `card_${kind}.png`);
      await writeFile(path, png);
      segments.push({ path, seconds, still: true });
    };

    if (startVideoUrl) await addUpload(startVideoUrl, "start");
    if (wantsCards) await addCard("title", TITLE_CARD_SECONDS);

    const contentInfo = await probe(contentPath);
    segments.push({
      path: contentPath,
      seconds: Number(contentInfo?.duration) || 0,
      still: false,
      content: true,
      // A cut with no voiceover and no score has no audio stream at all.
      hasAudio: await hasAudioStream(contentPath),
    });

    if (wantsCards) await addCard("end", END_CARD_SECONDS);
    if (endVideoUrl) await addUpload(endVideoUrl, "end");

    const args = ["-y"];
    const filters = [];
    const videoPads = [];
    const audioPads = [];
    let offset = 0;

    segments.forEach((seg, i) => {
      if (seg.still) {
        // A still has no duration of its own; -loop plus -t gives it one.
        args.push("-loop", "1", "-t", String(seg.seconds), "-i", seg.path);
      } else {
        args.push("-i", seg.path);
      }

      // Scale to fit and pad rather than crop: a bookend frame the client
      // shot at another ratio should letterbox onto the slideshow's frame,
      // not lose its edges. setsar=1 keeps a source with a non-square pixel
      // aspect from skewing once it is on a common timeline.
      filters.push(
        `[${i}:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
          `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,` +
          `fps=${fps},format=yuv420p,setpts=PTS-STARTPTS[bv${i}]`,
      );
      videoPads.push(`[bv${i}]`);

      // A still card has no audio track at all; nor does a silent upload, or
      // a cut rendered with neither voiceover nor score. Each of those gets a
      // silence of exactly its own length instead, so the delays below still
      // add up to the right offsets.
      //
      // Silence rather than `[i:a?]`: the optional-stream suffix works on
      // `-map`, but NOT on a filtergraph input pad. Pointing one at an input
      // with no audio doesn't skip the pad, it fails the whole graph with
      // "matches no streams" -- measured, on a cut with no audio at all.
      const ms = Math.round(offset * 1000);
      const secs = seg.seconds.toFixed(3);
      if (seg.still || !seg.hasAudio) {
        filters.push(
          `anullsrc=channel_layout=stereo:sample_rate=48000,` +
            `atrim=0:${secs},asetpts=PTS-STARTPTS,adelay=${ms}|${ms}[ba${i}]`,
        );
      } else {
        filters.push(
          `[${i}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,` +
            `apad=whole_dur=${secs},atrim=0:${secs},` +
            `asetpts=PTS-STARTPTS,adelay=${ms}|${ms}[ba${i}]`,
        );
      }
      audioPads.push(`[ba${i}]`);
      offset += seg.seconds;
    });

    filters.push(`${videoPads.join("")}concat=n=${segments.length}:v=1:a=0[outv]`);
    filters.push(
      `${audioPads.join("")}amix=inputs=${segments.length}:duration=longest:normalize=0,` +
        `alimiter=limit=0.97[outa]`,
    );

    const outPath = join(dir, "wrapped.mp4");
    args.push(
      "-filter_complex",
      filters.join(";"),
      "-map",
      "[outv]",
      "-map",
      "[outa]",
      "-r",
      String(fps),
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-profile:v",
      "high",
      "-preset",
      "medium",
      "-crf",
      "20",
      "-c:a",
      "aac",
      "-b:a",
      "160k",
      "-ar",
      "48000",
      "-movflags",
      "+faststart",
      "-t",
      offset.toFixed(3),
      outPath,
    );

    await run(ffmpeg, args);
    return { buffer: await readFile(outPath), width, height };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Probe a source so the caller knows what it is holding. */
export async function probe(path) {
  const ffprobe = process.env.FFPROBE_BIN || "ffprobe";
  return new Promise((resolve) => {
    const proc = spawn(
      ffprobe,
      [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=width,height,duration:format=duration",
        "-of",
        "json",
        path,
      ],
      { windowsHide: true },
    );
    let out = "";
    proc.stdout.on("data", (d) => (out += d.toString()));
    // A probe failure is not fatal -- the render can still proceed on defaults.
    proc.on("error", () => resolve(null));
    proc.on("close", () => {
      try {
        const parsed = JSON.parse(out);
        const stream = parsed.streams?.[0] ?? {};
        // Container-level duration (format.duration) is present far more
        // reliably than the per-stream figure -- fall back to it rather than
        // trust stream.duration alone, which several mp4 producers omit.
        const duration = stream.duration ?? parsed.format?.duration ?? null;
        resolve({ ...stream, duration });
      } catch {
        resolve(null);
      }
    });
  });
}

/** Whether a media file has an audio stream at all -- ffprobe exits non-zero (via -select_streams a) when there is none, which the promise resolves as false rather than rejecting. */
export async function hasAudio(path) {
  const ffprobe = process.env.FFPROBE_BIN || "ffprobe";
  return new Promise((resolve) => {
    const proc = spawn(
      ffprobe,
      ["-v", "error", "-select_streams", "a", "-show_entries", "stream=index", "-of", "json", path],
      { windowsHide: true },
    );
    let out = "";
    proc.stdout.on("data", (d) => (out += d.toString()));
    proc.on("error", () => resolve(false));
    proc.on("close", () => {
      try {
        resolve((JSON.parse(out).streams ?? []).length > 0);
      } catch {
        resolve(false);
      }
    });
  });
}

/**
 * Character Swap's own three small utilities, grouped here because all three
 * exist for the same reason: neither Convex nor a fal model can tell you what
 * an UPLOADED video actually contains, or hand you a plain frame or a plain
 * audio track out of one -- that is real video surgery, same as everything
 * else in this file.
 */

/** Downloads a URL to a temp file and reports duration and whether it has audio, so the workflow can cost and branch on the source's real length rather than a guess. */
export async function inspectVideo(videoUrl) {
  const ffprobe = process.env.FFPROBE_BIN || "ffprobe";
  const dir = await mkdtemp(join(tmpdir(), "fe-inspect-"));
  try {
    const res = await fetch(videoUrl);
    if (!res.ok) throw new Error(`failed to fetch video: ${res.status}`);
    const srcPath = join(dir, "source.mp4");
    await writeFile(srcPath, Buffer.from(await res.arrayBuffer()));

    const [info, withAudio] = await Promise.all([probe(srcPath), hasAudio(srcPath)]);
    return {
      durationSec: Number(info?.duration) || 0,
      width: info?.width ?? null,
      height: info?.height ?? null,
      hasAudio: withAudio,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * One frame of a video, as a PNG.
 *
 * `position` is "first" -- Recreate mode composites a character into it, and
 * verification reads one off the swap output to compare against the reference
 * image -- or "last", which is how a clip longer than a video model's own
 * per-generation ceiling is chained: the tail of one segment is the opening
 * frame of the next, so the motion carries across the join.
 */
export async function extractFrame(videoUrl, position = "first") {
  const ffmpeg = resolveFfmpeg();
  const dir = await mkdtemp(join(tmpdir(), "fe-frame-"));
  try {
    const res = await fetch(videoUrl);
    if (!res.ok) throw new Error(`failed to fetch video: ${res.status}`);
    const srcPath = join(dir, "source.mp4");
    await writeFile(srcPath, Buffer.from(await res.arrayBuffer()));

    const outPath = join(dir, "frame.png");
    // `-sseof -1` seeks a second from the end, then the LAST decoded frame of
    // what remains is written: seeking to the exact final timestamp lands
    // past the last keyframe often enough to come back empty.
    const args =
      position === "last"
        ? ["-y", "-sseof", "-1", "-i", srcPath, "-update", "1", "-q:v", "2", outPath]
        : ["-y", "-i", srcPath, "-vframes", "1", outPath];
    await run(ffmpeg, args);
    return readFile(outPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Back-compat alias: the first frame, by its original name. */
export async function extractFirstFrame(videoUrl) {
  return extractFrame(videoUrl, "first");
}

/** Just the audio track, as an mp3 -- ElevenLabs' voice changer takes a plain audio file, not a video container. */
export async function extractAudioTrack(videoUrl) {
  const ffmpeg = resolveFfmpeg();
  const dir = await mkdtemp(join(tmpdir(), "fe-audio-"));
  try {
    const res = await fetch(videoUrl);
    if (!res.ok) throw new Error(`failed to fetch video: ${res.status}`);
    const srcPath = join(dir, "source.mp4");
    await writeFile(srcPath, Buffer.from(await res.arrayBuffer()));

    const outPath = join(dir, "audio.mp3");
    await run(ffmpeg, ["-y", "-i", srcPath, "-vn", "-acodec", "libmp3lame", outPath]);
    return readFile(outPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Wall of Text: a phone clip with one full-frame text layer over it, start to
 * finish -- no timing, no animation, which is exactly how the posts it copies
 * look.
 *
 * The layer arrives already drawn (a transparent 1080x1920 PNG the caller
 * screenshots from the studio's own markup), so this is only the surgery:
 * cover-fit the clip to 9:16, lay the layer on top, and either keep the
 * clip's own sound or replace it with the chosen track. A replacement track
 * is padded with silence and cut at the video's length, so a short sound
 * never shortens the video and a long one never lengthens it.
 */
export async function renderWallOfText({
  videoUrl,
  audioUrl = null,
  layerPng,
  maxDurationSec = 60,
  fps = 30,
}) {
  if (!videoUrl) throw new Error("videoUrl is required");
  const ffmpeg = resolveFfmpeg();
  const [w, h] = dimensionsFor("9:16");
  const dir = await mkdtemp(join(tmpdir(), "fe-wall-"));

  try {
    const videoPath = join(dir, "source.mp4");
    await fetchTo(videoUrl, videoPath, "the video");
    const layerPath = join(dir, "layer.png");
    await writeFile(layerPath, layerPng);

    const info = await probe(videoPath);
    const duration = Math.min(Number(info?.duration) || maxDurationSec, maxDurationSec);

    const args = ["-y", "-i", videoPath, "-i", layerPath];
    const filters = [
      `[0:v]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},setsar=1,fps=${fps}[base]`,
      // A single still input holds its one frame for the whole clip.
      `[base][1:v]overlay=0:0[v]`,
    ];
    let audioMap = ["-map", "0:a?"];
    if (audioUrl) {
      const audioPath = join(dir, `audio${audioExt(audioUrl)}`);
      await fetchTo(audioUrl, audioPath, "the audio");
      args.push("-i", audioPath);
      filters.push("[2:a]apad[a]");
      audioMap = ["-map", "[a]"];
    }

    const outPath = join(dir, "out.mp4");
    args.push(
      "-filter_complex",
      filters.join(";"),
      "-map",
      "[v]",
      ...audioMap,
      "-t",
      duration.toFixed(3),
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-profile:v",
      "high",
      "-preset",
      "medium",
      "-crf",
      "20",
      "-c:a",
      "aac",
      "-b:a",
      "160k",
      "-movflags",
      "+faststart",
      outPath,
    );
    await run(ffmpeg, args);

    return { buffer: await readFile(outPath), width: w, height: h, durationSec: duration };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
