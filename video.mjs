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
  durationSec = 5,
  captionPng, // Buffer | null -- a full-frame transparent overlay
  overlay, // { base64, contentType } | null
  fps = 30,
}) {
  if (!source?.base64) throw new Error("a source image or video is required");

  const ffmpeg = resolveFfmpeg();
  const [w, h] = dimensionsFor(dimensions);
  const dir = await mkdtemp(join(tmpdir(), "fe-custom-"));

  try {
    const isVideo = (source.contentType ?? "").startsWith("video/");
    const srcPath = join(dir, `source.${extFor(source.contentType, isVideo ? "mp4" : "png")}`);
    await writeFile(srcPath, Buffer.from(source.base64, "base64"));

    const args = ["-y"];

    // A still becomes a clip of the requested length; a video keeps its own.
    if (isVideo) {
      args.push("-i", srcPath);
    } else {
      args.push("-loop", "1", "-t", String(durationSec), "-i", srcPath);
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
      fit === "cover"
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
