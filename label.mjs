/**
 * The AI-disclosure pass: a finished video or image, with an "AI-generated"
 * badge burned into the frame and/or an AI-generated tag written into the
 * file's metadata.
 *
 * The format engine runs it when a post is scheduled with either switch on,
 * and posts the copy this returns. A burned-in badge is the disclosure that
 * survives a download or a repost, which is what New York's synthetic
 * performer law and the EU AI Act's deepfake rule ask of an ad. The metadata
 * tag is a hint for tools that read it; most platforms strip it on upload.
 *
 * The badge is drawn by Chrome from `badgeHtml` below (sized to the frame),
 * then overlaid by ffmpeg -- the same split every text layer here uses.
 */

import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probe, resolveFfmpeg, run } from "./video.mjs";

export const DEFAULT_LABEL = "AI-generated";

/**
 * Written as the file's comment and description. An MP4 has no standard
 * field for this; IPTC's digital source type name is what C2PA and the
 * platforms use for "made by a generative model", so it goes in as well.
 */
const METADATA_NOTE = "AI-generated content (IPTC digital source type: trainedAlgorithmicMedia).";

/**
 * A rounded, translucent pill in the top-left corner, below where TikTok,
 * Reels and Shorts draw their own top bar (about the first 11% of a 9:16
 * frame) and clear of the right-hand action column and the caption at the
 * bottom. Sized from the frame's height so it reads the same on any size.
 */
export function badgeHtml(text, width, height) {
  const font = Math.max(14, Math.round(height * 0.02));
  const esc = String(text)
    .slice(0, 60)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;width:${width}px;height:${height}px;background:transparent;}
.b{position:absolute;left:${Math.round(width * 0.04)}px;top:${Math.round(height * 0.12)}px;
font:600 ${font}px/1.2 -apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:#fff;
background:rgba(0,0,0,0.55);padding:${Math.round(font * 0.35)}px ${Math.round(font * 0.7)}px;
border-radius:${font}px;letter-spacing:0.01em;}
</style></head><body><div class="b">${esc}</div></body></html>`;
}

/**
 * @param {object} p
 * @param {string} p.mediaUrl        the finished video or image
 * @param {"video"|"image"} p.kind
 * @param {boolean} p.burn           draw the badge into the frame
 * @param {boolean} p.metadata       write the AI tag into the file (videos only)
 * @param {(html: string, w: number, h: number) => Promise<Buffer>} p.renderLayer
 *   Chrome's screenshot of an HTML layer, from server.mjs.
 * @returns {Promise<{ buffer: Buffer, width: number, height: number, contentType: string }>}
 */
export async function labelMedia({ mediaUrl, kind, burn, metadata, text = DEFAULT_LABEL, renderLayer }) {
  if (!mediaUrl) throw new Error("mediaUrl is required");
  if (kind !== "video" && kind !== "image") throw new Error('kind must be "video" or "image"');
  if (!burn && !metadata) throw new Error("nothing to do: turn on burn or metadata");
  if (kind === "image" && !burn) throw new Error("an image can only be labeled by burning the badge in");

  const ffmpeg = resolveFfmpeg();
  const dir = await mkdtemp(join(tmpdir(), "fe-label-"));
  try {
    const res = await fetch(mediaUrl);
    if (!res.ok) throw new Error(`failed to fetch the media: ${res.status}`);
    // ffmpeg's image demuxer goes by extension, so give it the real one.
    const type = res.headers.get("content-type") ?? "";
    const ext = kind === "video" ? "mp4" : /png/.test(type) ? "png" : /webp/.test(type) ? "webp" : "jpg";
    const inPath = join(dir, `in.${ext}`);
    await writeFile(inPath, Buffer.from(await res.arrayBuffer()));

    const info = await probe(inPath);
    const width = Number(info?.width) || 1080;
    const height = Number(info?.height) || 1920;

    const args = ["-y", "-i", inPath];
    if (burn) {
      const badgePath = join(dir, "badge.png");
      await writeFile(badgePath, await renderLayer(badgeHtml(text, width, height), width, height));
      args.push("-i", badgePath, "-filter_complex", "[0:v][1:v]overlay=0:0[v]", "-map", "[v]");
    } else {
      args.push("-map", "0:v");
    }

    if (kind === "image") {
      const outPath = join(dir, "out.png");
      args.push("-frames:v", "1", outPath);
      await run(ffmpeg, args);
      return { buffer: await readFile(outPath), width, height, contentType: "image/png" };
    }

    const outPath = join(dir, "out.mp4");
    args.push("-map", "0:a?");
    if (burn) {
      args.push("-c:v", "libx264", "-pix_fmt", "yuv420p", "-profile:v", "high", "-preset", "medium", "-crf", "20");
    } else {
      // Metadata only: the frames are untouched, so nothing is re-encoded.
      args.push("-c:v", "copy");
    }
    args.push("-c:a", "copy");
    if (metadata) {
      args.push(
        "-metadata", `comment=${METADATA_NOTE}`,
        "-metadata", `description=${METADATA_NOTE}`,
        "-metadata", "ai_generated=true",
        "-movflags", "+faststart+use_metadata_tags",
      );
    } else {
      args.push("-movflags", "+faststart");
    }
    args.push(outPath);
    await run(ffmpeg, args);
    return { buffer: await readFile(outPath), width, height, contentType: "video/mp4" };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
