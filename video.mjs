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
  source, // { base64, contentType }
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
  const generated = !source?.base64;
  if (generated && !backgroundColor) {
    throw new Error("a source upload or a backgroundColor is required");
  }

  const ffmpeg = resolveFfmpeg();
  const [w, h] = dimensionsFor(dimensions);
  const dir = await mkdtemp(join(tmpdir(), "fe-custom-"));

  try {
    const isVideo = !generated && (source.contentType ?? "").startsWith("video/");
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
 * Video Animation's final assembly: N already-generated clips, each with its
 * own optional dialogue audio and optional caption, concatenated into one
 * video with continuous audio.
 *
 * Every clip gets an audio track whether it has dialogue or not -- a real
 * track of silence for quiet shots, never a missing one -- because `concat`
 * with `a=1` needs exactly one audio input per video input; mixing "some
 * segments have audio, some don't" would need a second, harder-to-verify
 * code path for no real benefit.
 */
export async function renderVideoAnimation({
  shots, // [{ videoUrl, audioUrl: string|null, durationSec, caption: string|null }]
  dimensions = "16:9",
  captionStyle = "Classic",
  fps = 30,
}) {
  if (!shots?.length) throw new Error("at least one shot is required");

  const ffmpeg = resolveFfmpeg();
  const [w, h] = dimensionsFor(dimensions);
  const dir = await mkdtemp(join(tmpdir(), "fe-video-"));

  try {
    const args = ["-y"];
    const filters = [];
    const segmentPairs = [];
    let nextInputIndex = 0;

    for (let i = 0; i < shots.length; i += 1) {
      const shot = shots[i];
      const duration = shot.durationSec || 5;

      const vidRes = await fetch(shot.videoUrl);
      if (!vidRes.ok) throw new Error(`failed to fetch clip ${i}: ${vidRes.status}`);
      const vidPath = join(dir, `clip_${i}.mp4`);
      await writeFile(vidPath, Buffer.from(await vidRes.arrayBuffer()));
      args.push("-i", vidPath);
      const vIdx = nextInputIndex++;

      // Cover-fit, not letterbox: a generated clip is already meant to fill
      // the frame at roughly this aspect, so a crop here is a rounding
      // correction, not a real loss the way it would be on someone's upload.
      let vLabel = `v${i}`;
      filters.push(
        `[${vIdx}:v]scale=${w}:${h}:force_original_aspect_ratio=increase,` +
          `crop=${w}:${h},setsar=1,fps=${fps}[${vLabel}]`,
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
      if (shot.audioUrl) {
        const audRes = await fetch(shot.audioUrl);
        if (!audRes.ok) throw new Error(`failed to fetch audio ${i}: ${audRes.status}`);
        const audPath = join(dir, `audio_${i}.mp3`);
        await writeFile(audPath, Buffer.from(await audRes.arrayBuffer()));
        args.push("-i", audPath);
        const aIdx = nextInputIndex++;
        // TTS rarely lands exactly on the clip's duration: atrim cuts it down
        // if it ran long, apad's whole_dur pads with silence if it ran short.
        // Together they guarantee this segment is exactly `duration` long,
        // which concat's audio stream requires to stay in sync with its video.
        filters.push(
          `[${aIdx}:a]atrim=0:${duration},apad=whole_dur=${duration},` +
            `asetpts=PTS-STARTPTS[${aLabel}]`,
        );
      } else {
        // A real silent track, not a missing one -- see the function comment.
        args.push("-f", "lavfi", "-t", String(duration), "-i", "anullsrc=r=48000:cl=stereo");
        const aIdx = nextInputIndex++;
        filters.push(`[${aIdx}:a]asetpts=PTS-STARTPTS[${aLabel}]`);
      }

      segmentPairs.push(`[${vLabel}][${aLabel}]`);
    }

    filters.push(`${segmentPairs.join("")}concat=n=${shots.length}:v=1:a=1[outv][outa]`);

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
 * A Ken Burns slideshow: N stills, each held for a fixed duration with a slow
 * centred zoom, an optional caption burned onto each one, concatenated into a
 * single clip.
 *
 * Built as one filter_complex graph rather than N renders + a concat pass --
 * fewer intermediate files, and one encode instead of N+1.
 */
let renderCaptionOverlay = null;
export function setCaptionRenderer(fn) {
  renderCaptionOverlay = fn;
}

export async function renderSlideshow({
  images, // [{ url } | { base64, contentType }]
  captions = [], // same length as images, "" for no caption on that slide
  dimensions = "9:16",
  secondsPerImage = 3,
  captionStyle = "Classic",
  fps = 30,
}) {
  if (!images?.length) throw new Error("at least one image is required");

  const ffmpeg = resolveFfmpeg();
  const [w, h] = dimensionsFor(dimensions);
  const dir = await mkdtemp(join(tmpdir(), "fe-slideshow-"));
  const frames = Math.round(secondsPerImage * fps);

  try {
    const args = ["-y"];
    const filters = [];
    const segmentLabels = [];
    // Tracks the real ffmpeg input index as args are built. A slide and its
    // caption are pushed back-to-back (image, then caption, then the next
    // image...), not as two separate blocks -- an earlier version computed
    // the caption's index as `images.length + i`, which assumes a block
    // layout that this loop has never actually produced. That mismatch
    // pulled the WRONG slide's caption onto every segment; only slide 0
    // happened to render correctly, because at i=0 no prior inputs existed
    // to be off by.
    let nextInputIndex = 0;

    for (let i = 0; i < images.length; i += 1) {
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
      filters.push(
        `[${imgInputIndex}:v]scale=${w * 2}:${h * 2}:force_original_aspect_ratio=increase,` +
          `crop=${w * 2}:${h * 2},` +
          `zoompan=z='min(zoom+0.0012,1.3)':d=${frames}:` +
          `x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${w}x${h}:fps=${fps},` +
          `setsar=1,trim=duration=${secondsPerImage},setpts=PTS-STARTPTS[img${i}]`,
      );

      let label = `img${i}`;
      const caption = captions[i];
      if (caption && caption.trim()) {
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
        // `overlay` defaults to running for as long as its LONGER input lasts
        // (shortest=0), duplicating the shorter stream's last frame to keep
        // pace -- so pairing a 2-second trimmed clip with an infinitely
        // looped caption PNG produced a multi-minute output, not a 2-second
        // one. `shortest=1` makes it stop when [label] (already trimmed)
        // ends, which is what "one caption per slide" actually means.
        filters.push(
          `[${label}][${capInputIndex}:v]overlay=0:0:shortest=1[capped${i}]`,
        );
        label = `capped${i}`;
      }
      segmentLabels.push(`[${label}]`);
    }

    filters.push(`${segmentLabels.join("")}concat=n=${images.length}:v=1:a=0[outv]`);

    const outPath = join(dir, "out.mp4");
    args.push(
      "-filter_complex",
      filters.join(";"),
      "-map",
      "[outv]",
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
      "-an",
      outPath,
    );

    await run(ffmpeg, args);
    const buf = await readFile(outPath);
    return { buffer: buf, width: w, height: h };
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
        "stream=width,height,duration",
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
        resolve(JSON.parse(out).streams?.[0] ?? null);
      } catch {
        resolve(null);
      }
    });
  });
}
