/**
 * The render service. Railway's job, and the first endpoint on it.
 *
 * This exists because a slide is HTML and CSS, so rasterising one needs a real
 * browser -- which Convex actions are not, and which is the one thing Convex
 * genuinely cannot do. It is `app/worker/export_carousel.mjs` with an HTTP
 * wrapper: the same shared slide DOM, the same inlined CSS, the same true-size
 * geometry, so preview and export agree by construction rather than by
 * discipline.
 *
 * Runs locally with `node server.mjs` and deploys to Railway unchanged; the
 * only difference is where CHROME_BIN points.
 */

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { timingSafeEqual } from "node:crypto";
import puppeteer from "puppeteer-core";
import { dimsFor, slideHtml } from "./carousel-templates/slide-dom.js";
import { brandCardHtml, captionLayerHtml, dimensionsFor } from "./caption-styles.js";
import {
  renderCustom,
  renderSlideshow,
  wrapWithBookends,
  renderVideoAnimation,
  renderDrama,
  renderVideoHookDemo,
  renderGreenScreenMeme,
  renderMemeComposite,
  renderPictureInPicture,
  renderWallOfText,
  inspectVideo,
  extractFrame,
  extractAudioTrack,
  resolveFfmpeg,
  run,
  setCaptionRenderer,
  setCardRenderer,
} from "./video.mjs";
import { packImages } from "./images.mjs";
import { labelMedia } from "./label.mjs";

const ROOT = dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = join(ROOT, "carousel-templates");
const PORT = Number(process.env.PORT || 4000);

/**
 * This service fetches whatever URL a caller supplies (`videoUrl`,
 * `imageUrls`, etc.) and runs a real browser and ffmpeg against it -- with no
 * platform-level gate in front of it on Railway, an unauthenticated request
 * would make it a free SSRF/compute proxy for anyone who finds the URL. Every
 * route but /health (Railway's own healthcheck hits that with no headers)
 * requires this key. Fails closed: if it's unset, nothing but /health is
 * servable, same as the Zernio webhook secret's own "refuse rather than
 * accept unverifiable" rule in the sibling Convex app.
 */
const API_KEY = (process.env.RENDER_SERVICE_API_KEY ?? "").trim();
if (!API_KEY) {
  console.warn(
    "RENDER_SERVICE_API_KEY is not set -- every route but /health will reject all requests.",
  );
}

function isAuthorized(req) {
  if (!API_KEY) return false;
  const provided = Buffer.from(String(req.headers["x-render-key"] ?? ""));
  const expected = Buffer.from(API_KEY);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

/**
 * On top of the key, not instead of it: a leaked key or a runaway retry loop
 * on the Convex side shouldn't be able to spin up unlimited headless-Chrome
 * and ffmpeg jobs on paid Railway compute. One process, one deployment, so a
 * plain in-memory fixed-window counter is enough -- no need to share state
 * across instances the way a multi-node service would.
 */
const RATE_LIMIT_MAX = 30;
const RATE_LIMIT_WINDOW_MS = 60_000;
let rateLimitWindowStart = Date.now();
let rateLimitCount = 0;

function isRateLimited() {
  const now = Date.now();
  if (now - rateLimitWindowStart >= RATE_LIMIT_WINDOW_MS) {
    rateLimitWindowStart = now;
    rateLimitCount = 0;
  }
  rateLimitCount += 1;
  return rateLimitCount > RATE_LIMIT_MAX;
}

/** Drives the Chrome or Edge already installed rather than downloading ~170MB of Chromium. */
function resolveBrowser() {
  if (process.env.CHROME_BIN && existsSync(process.env.CHROME_BIN)) {
    return process.env.CHROME_BIN;
  }
  const pf = process.env["ProgramFiles"] || "C:\\Program Files";
  const pf86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  const local = process.env["LOCALAPPDATA"] || "";
  const candidates = [
    join(pf, "Google", "Chrome", "Application", "chrome.exe"),
    join(pf86, "Google", "Chrome", "Application", "chrome.exe"),
    local && join(local, "Google", "Chrome", "Application", "chrome.exe"),
    join(pf, "Microsoft", "Edge", "Application", "msedge.exe"),
    join(pf86, "Microsoft", "Edge", "Application", "msedge.exe"),
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  ].filter(Boolean);
  const found = candidates.find((p) => existsSync(p));
  if (!found) {
    throw new Error(
      "no Chrome or Edge found for rendering -- install Google Chrome, or set " +
        "CHROME_BIN to a Chrome/Edge executable path",
    );
  }
  return found;
}

// ---- one warm Chrome -----------------------------------------------------------
//
// Starting Chrome costs a second or two of CPU and a few hundred MB of memory
// spikes, and every render used to pay it -- a ten-slide export, a caption
// layer and a brand card each launched and closed their own. Now one browser
// is started on first use and shared: each render gets a fresh tab and closes
// it. The browser is closed again after BROWSER_IDLE_MS with nothing open, so
// an idle service holds no Chrome at all, and recycled every
// BROWSER_RECYCLE_AFTER tabs so a slow leak in Chrome can't grow forever.

const BROWSER_IDLE_MS = Number(process.env.BROWSER_IDLE_MS || 5 * 60_000);
const BROWSER_RECYCLE_AFTER = Number(process.env.BROWSER_RECYCLE_AFTER || 300);

let browserPromise = null;
let openTabs = 0;
let tabsServed = 0;
let idleTimer = null;

function launchBrowser() {
  const launching = puppeteer.launch({
    executablePath: resolveBrowser(),
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--font-render-hinting=none"],
  });
  launching
    .then((browser) =>
      browser.on("disconnected", () => {
        // A crash (or our own close) -- the next render starts a new one.
        if (browserPromise === launching) browserPromise = null;
      }),
    )
    .catch(() => {
      if (browserPromise === launching) browserPromise = null;
    });
  return launching;
}

async function getBrowser() {
  if (browserPromise) {
    const browser = await browserPromise.catch(() => null);
    if (browser?.connected) return browser;
    browserPromise = null;
  }
  browserPromise = launchBrowser();
  tabsServed = 0;
  return browserPromise;
}

async function closeBrowser() {
  const closing = browserPromise;
  browserPromise = null;
  tabsServed = 0;
  const browser = await closing?.catch(() => null);
  await browser?.close().catch(() => {});
}

function afterTab() {
  if (openTabs > 0) return;
  clearTimeout(idleTimer);
  if (tabsServed >= BROWSER_RECYCLE_AFTER) {
    void closeBrowser();
    return;
  }
  idleTimer = setTimeout(() => void closeBrowser(), BROWSER_IDLE_MS);
  idleTimer.unref?.();
}

/** Runs `fn` with a fresh tab in the shared browser, and always closes the tab. */
async function withPage(fn) {
  clearTimeout(idleTimer);
  openTabs += 1;
  try {
    const browser = await getBrowser();
    const page = await browser.newPage();
    try {
      return await fn(page);
    } finally {
      tabsServed += 1;
      await page.close().catch(() => {});
    }
  } finally {
    openTabs -= 1;
    afterTab();
  }
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    void closeBrowser().finally(() => process.exit(0));
  });
}

/**
 * CSS is INLINED rather than linked. The generated page then has no external
 * references at all, which sidesteps every origin quirk and leaves the HTML
 * independently openable when a template needs debugging.
 */
async function loadCss(templateId) {
  const base = await readFile(join(TEMPLATES_DIR, "_base.css"), "utf8");
  const tpl = await readFile(join(TEMPLATES_DIR, `${templateId}.css`), "utf8");
  return `${base}\n${tpl}`;
}

function buildHtml({ slides, templateId, dims, branding, footerLeft, css }) {
  const [w, h] = dims;
  const body = slides
    .map((slide, i) =>
      slideHtml({
        slide,
        index: i,
        total: slides.length,
        templateId,
        dims,
        branding,
        footerLeft,
      }),
    )
    .join("\n");

  return `<!doctype html><html><head><meta charset="utf-8"><style>
  ${css}
  /* Each slide renders at true size, stacked, with Chrome told to break pages
     exactly on slide boundaries -- so the PDF is one slide per page at the
     deck's real dimensions. */
  html, body { margin: 0; padding: 0; background: #fff; }
  .slide { display: flex; break-after: page; page-break-after: always; }
  .slide:last-child { break-after: auto; page-break-after: auto; }
  @page { size: ${w}px ${h}px; margin: 0; }
</style></head><body>\n${body}\n</body></html>`;
}

/** Renders a deck and returns every file as base64, for the caller to store. */
async function renderCarousel(payload) {
  const {
    slides = [],
    caption = "",
    hashtags = [],
    template = "bold-statement",
    aspectRatio = "4:5",
    branding,
    footerLeft,
  } = payload;

  if (!slides.length) throw new Error("deck has no slides to render");
  if (!existsSync(join(TEMPLATES_DIR, `${template}.css`))) {
    throw new Error(`template '${template}' has no stylesheet`);
  }

  const dims = dimsFor(aspectRatio);
  const css = await loadCss(template);
  const html = buildHtml({ slides, templateId: template, dims, branding, footerLeft, css });

  const files = [];
  await withPage(async (page) => {
    await page.setViewport({ width: dims[0], height: dims[1], deviceScaleFactor: 1 });
    await page.setContent(html, { waitUntil: "load" });
    await page.evaluateHandle("document.fonts.ready");

    const handles = await page.$$(".slide");
    if (handles.length !== slides.length) {
      throw new Error(
        `expected ${slides.length} slides in the page, found ${handles.length}`,
      );
    }

    for (let i = 0; i < handles.length; i += 1) {
      const name =
        `${slides[i].slide_id || `slide_${String(i + 1).padStart(3, "0")}`}.png`;
      const buf = await handles[i].screenshot({ type: "png" });
      files.push({ name, contentType: "image/png", base64: Buffer.from(buf).toString("base64") });
    }

    const pdf = await page.pdf({
      width: `${dims[0]}px`,
      height: `${dims[1]}px`,
      printBackground: true,
      pageRanges: `1-${slides.length}`,
      margin: { top: 0, right: 0, bottom: 0, left: 0 },
    });
    files.push({
      name: "carousel.pdf",
      contentType: "application/pdf",
      base64: Buffer.from(pdf).toString("base64"),
    });
  });

  const captionText =
    `${[caption, "", hashtags.map((t) => `#${t}`).join(" ")].join("\n").trim()}\n`;
  files.push({
    name: "caption.txt",
    contentType: "text/plain",
    base64: Buffer.from(captionText, "utf8").toString("base64"),
  });

  return { ok: true, template, slideCount: slides.length, dims, files };
}

/**
 * Draws a caption into a full-frame transparent PNG.
 *
 * Text goes through Chrome rather than ffmpeg's drawtext so it gets real
 * typography, wrapping that behaves, and no escaping minefield for arbitrary
 * user input -- and it reuses the browser this service already launches.
 */
async function renderCaptionLayer({ text, style, width, height, position, scale }) {
  return withPage(async (page) => {
    await page.setViewport({ width, height, deviceScaleFactor: 1 });
    await page.setContent(
      captionLayerHtml({ text, style, width, height, position, scale }),
      { waitUntil: "load" },
    );
    await page.evaluateHandle("document.fonts.ready");
    // omitBackground is what makes this an overlay rather than a black card.
    return Buffer.from(await page.screenshot({ type: "png", omitBackground: true }));
  });
}

/**
 * Draws a branded title card or end screen as a full-frame opaque PNG.
 *
 * Opaque, unlike a caption layer, because this becomes its own segment on the
 * timeline rather than an overlay on someone else's frame.
 *
 * A logo is inlined as a data URI rather than left as a remote `<img src>`:
 * Chrome's `load` event does not wait for a slow third-party fetch, and a
 * card that renders a beat before the logo arrives would ship without it.
 * Fetching it here means it is either embedded in the HTML before the page
 * exists, or it is not there at all.
 */
async function renderBrandCardImage({ kind, width, height, logoUrl, ...branding }) {
  let logoDataUri = null;
  if (logoUrl) {
    const res = await fetch(logoUrl);
    if (!res.ok) throw new Error(`failed to fetch the brand logo: ${res.status}`);
    const type = res.headers.get("content-type") || "image/png";
    logoDataUri = `data:${type};base64,${Buffer.from(await res.arrayBuffer()).toString("base64")}`;
  }

  return withPage(async (page) => {
    await page.setViewport({ width, height, deviceScaleFactor: 1 });
    await page.setContent(brandCardHtml({ ...branding, kind, width, height, logoDataUri }), {
      // The card pulls a Google Font over the network, so `load` alone can
      // fire with the fallback face still on screen.
      waitUntil: "networkidle0",
    });
    await page.evaluateHandle("document.fonts.ready");
    return Buffer.from(await page.screenshot({ type: "png" }));
  });
}

// video.mjs owns ffmpeg only; it cannot launch a browser itself, so the two
// renderers that need Chrome are handed to it once at startup.
setCaptionRenderer((opts) => renderCaptionLayer(opts));
setCardRenderer((opts) => renderBrandCardImage(opts));

/**
 * Slideshow: N generated stills, Ken Burns pan/zoom, a caption per slide,
 * then -- optionally -- uploaded bookend videos and branded cards wrapped
 * around the result.
 *
 * Two ffmpeg passes rather than one graph. The slideshow's own graph is
 * already N inputs of zoompan and crossfade arithmetic that assumes a
 * timeline starting at zero; splicing arbitrary uploads into it would mean
 * every caption's `enable=between(t,…)` window shifting by the start frame's
 * length. Wrapping afterwards leaves that arithmetic alone, and costs one
 * extra encode on a step that is free at the margin anyway.
 */
async function renderSlideshowFormat(payload) {
  const {
    images = [],
    captions = [],
    dimensions = "9:16",
    secondsPerImage = 3,
    captionStyle = "Classic",
    narration = [],
    voiceoverUrl = null,
    musicUrl = null,
    musicVolume,
    transition = "fade",
    transitionSeconds = 0.5,
    startVideoUrl = null,
    endVideoUrl = null,
    branding = null,
    uploadUrl,
  } = payload;

  const cut = await renderSlideshow({
    images,
    captions,
    dimensions,
    secondsPerImage,
    captionStyle,
    narration,
    voiceoverUrl,
    musicUrl,
    ...(musicVolume === undefined ? {} : { musicVolume }),
    transition,
    transitionSeconds,
  });

  // A no-op that returns the same buffer when there is nothing to wrap.
  const { buffer, width, height } = await wrapWithBookends({
    buffer: cut.buffer,
    width: cut.width,
    height: cut.height,
    startVideoUrl,
    endVideoUrl,
    branding,
  });

  // Uploaded straight to the caller's signed URL when given one: a 12-second
  // 1080x1920 cut is ~6 MiB, and as base64 it overran Convex's 5 MiB cap on
  // a Node action's arguments. Without one it still returns base64, so the
  // route stays curl-able on its own.
  return uploadResult(buffer, width, height, uploadUrl);
}

/**
 * Video Animation: N clips, each with optional dialogue audio and caption.
 *
 * A stitched output routinely exceeds Convex's 16MB function-argument limit
 * as base64, so this uploads the finished bytes directly to the signed URL
 * the caller generated -- the same pattern the browser's own UploadField
 * uses, just with this service standing in for a person. `uploadUrl` is
 * required in practice; the base64 fallback exists only so this endpoint
 * stays curl-able on its own for local testing.
 *
 * Also the join for Kling's chained segments and every narrated format, none
 * of which send the trailing fields: `musicUrl`, `startVideoUrl`,
 * `endVideoUrl` and `branding` are all optional and default to nothing, in
 * which case this is exactly the stitch it always was. The bookend wrap is a
 * second pass for the reason renderSlideshowFormat gives -- the stitch's own
 * graph assumes a timeline that starts at zero.
 */
async function renderVideoAnimationFormat(payload) {
  const {
    shots = [],
    dimensions = "16:9",
    captionStyle = "Classic",
    extendToAudio = false,
    voiceoverUrl = null,
    musicUrl = null,
    musicVolume,
    startVideoUrl = null,
    endVideoUrl = null,
    branding = null,
    uploadUrl,
  } = payload;
  const cut = await renderVideoAnimation({
    shots,
    dimensions,
    captionStyle,
    extendToAudio: extendToAudio === true,
    voiceoverUrl,
    musicUrl,
    ...(musicVolume === undefined ? {} : { musicVolume }),
  });
  // A no-op that returns the same buffer when there is nothing to wrap.
  const { buffer, width, height } = await wrapWithBookends({
    buffer: cut.buffer,
    width: cut.width,
    height: cut.height,
    startVideoUrl,
    endVideoUrl,
    branding,
  });
  return uploadResult(buffer, width, height, uploadUrl);
}

/**
 * Drama: filmed beats that keep their own lip-synced audio, narration laid
 * over where a beat has it, an optional score underneath. Same
 * direct-to-storage upload as Video Animation -- an episode is well past
 * Convex's 16MB argument ceiling as base64.
 */
async function renderDramaFormat(payload) {
  const {
    beats = [],
    dimensions = "9:16",
    captionStyle = "Classic",
    musicUrl = null,
    musicVolume,
    uploadUrl,
  } = payload;
  const { buffer, width, height } = await renderDrama({
    beats,
    dimensions,
    captionStyle,
    musicUrl,
    musicVolume,
  });
  return uploadResult(buffer, width, height, uploadUrl);
}

/**
 * Video Hook & Demo: a trending clip then a demo video, caption on the hook.
 * Same direct-to-storage upload as Video Animation's stitch -- a two-segment
 * video routinely clears Convex's 16MB function-argument limit as base64.
 */
async function renderVideoHookDemoFormat(payload) {
  const {
    hookUrl,
    demoUrl,
    dimensions = "9:16",
    captionText = "",
    captionStyle = "Outline",
    hookSeconds = 4,
    captionOver = "hook",
    audioUrl = null,
    keepOriginal = false,
    uploadUrl,
  } = payload;
  const { buffer, width, height } = await renderVideoHookDemo({
    hookUrl,
    demoUrl,
    dimensions,
    captionText,
    captionStyle,
    hookSeconds,
    captionOver,
    audioUrl,
    keepOriginal: Boolean(keepOriginal),
  });
  return uploadResult(buffer, width, height, uploadUrl);
}

/** Green Screen Meme: chroma-key a trending clip over the user's background. */
async function renderGreenScreenMemeFormat(payload) {
  // The studio's format: a background, a placed meme, and a text layer drawn
  // by the caller from the same style functions its editor previews with.
  if (payload.layerHtml) {
    const { layerHtml, backgroundUrl, memeUrl, meme, sound, seconds, uploadUrl } = payload;
    if (typeof layerHtml !== "string") throw new Error("layerHtml must be a string");
    const [w, h] = dimensionsFor("9:16");
    const layerPng = await renderLayerHtml(layerHtml, w, h);
    const out = await renderMemeComposite({ backgroundUrl, memeUrl, layerPng, meme, sound, seconds });
    return { ...(await uploadResult(out.buffer, out.width, out.height, uploadUrl)), durationSec: out.durationSec };
  }
  // Jobs from before the studio: a trending green-screen clip keyed over a still.
  const {
    clipUrl,
    backgroundUrl,
    dimensions = "9:16",
    captionText = "",
    captionStyle = "Classic",
    uploadUrl,
  } = payload;
  const { buffer, width, height } = await renderGreenScreenMeme({
    clipUrl,
    backgroundUrl,
    dimensions,
    captionText,
    captionStyle,
  });
  return uploadResult(buffer, width, height, uploadUrl);
}

/** Talking Head Green Screen: avatar keyed into a corner of a looping demo. */
async function renderPictureInPictureFormat(payload) {
  const {
    demoUrl,
    avatarUrl,
    dimensions = "9:16",
    pipScale,
    pipPosition,
    captionText = "",
    captionStyle = "Classic",
    uploadUrl,
  } = payload;
  const { buffer, width, height } = await renderPictureInPicture({
    demoUrl,
    avatarUrl,
    dimensions,
    pipScale,
    pipPosition,
    captionText,
    captionStyle,
  });
  return uploadResult(buffer, width, height, uploadUrl);
}

/** Shared by every endpoint whose output should go straight to storage. */
async function uploadResult(buffer, width, height, uploadUrl) {
  if (uploadUrl) {
    const uploadRes = await fetch(uploadUrl, {
      method: "POST",
      headers: { "Content-Type": "video/mp4" },
      body: buffer,
    });
    if (!uploadRes.ok) {
      throw new Error(`upload to storage failed: ${uploadRes.status} ${await uploadRes.text()}`);
    }
    const { storageId } = await uploadRes.json();
    return { ok: true, width, height, storageId, bytes: buffer.length, contentType: "video/mp4" };
  }
  return {
    ok: true,
    width,
    height,
    files: [{ name: "output.mp4", contentType: "video/mp4", base64: buffer.toString("base64") }],
  };
}

/**
 * Custom: an upload, framed to a target ratio, with optional text and
 * overlay. Also doubles as the caption-burn step for every avatar format --
 * "Custom" is already "any video, cover-fit and captioned", which is
 * precisely what a talking-head clip needs with no format-specific renderer
 * of its own.
 */
async function renderCustomFormat(payload) {
  const {
    source,
    sourceUrl = null,
    sourceIsVideo = true,
    dimensions = "9:16",
    fit = "contain",
    backgroundColor = null,
    textScale = 1,
    text = "",
    captionStyle = "Classic",
    captionPosition = "bottom",
    overlay = null,
    durationSec = 5,
    uploadUrl,
  } = payload;

  const [w, h] = dimensionsFor(dimensions);

  const captionPng = text.trim()
    ? await renderCaptionLayer({
        text,
        style: captionStyle,
        width: w,
        height: h,
        position: captionPosition,
        scale: textScale,
      })
    : null;

  const { buffer, width, height } = await renderCustom({
    source,
    sourceUrl,
    sourceIsVideo,
    dimensions,
    fit,
    backgroundColor,
    durationSec,
    captionPng,
    overlay,
  });

  return uploadResult(buffer, width, height, uploadUrl);
}

/**
 * Screenshots a full-frame page into a transparent PNG.
 *
 * Wall of Text's layer is built by the format engine from the same style
 * functions its studio previews with, so the page is taken as given rather
 * than re-described here -- a second copy of that styling in this repo is
 * exactly the drift the arrangement exists to prevent. It is only reachable
 * with the render key, like every other route that loads a caller's URLs.
 * Waits for the web font and every image to be ready: a frame screenshotted
 * a beat early ships in the fallback face, or without its overlay.
 */
async function renderLayerHtml(html, width, height) {
  return withPage(async (page) => {
    await page.setViewport({ width, height, deviceScaleFactor: 1 });
    await page.setContent(html, { waitUntil: "networkidle0", timeout: 45_000 });
    await page.evaluate(async () => {
      await document.fonts.ready;
      await Promise.all(
        [...document.images].map((img) => (img.complete ? null : img.decode().catch(() => null))),
      );
    });
    return Buffer.from(await page.screenshot({ type: "png", omitBackground: true }));
  });
}

async function renderWallOfTextFormat(payload) {
  const { layerHtml, videoUrl, audioUrl = null, maxDurationSec = 60, uploadUrl } = payload;
  if (typeof layerHtml !== "string" || !layerHtml) throw new Error("layerHtml is required");
  const [w, h] = dimensionsFor("9:16");
  const layerPng = await renderLayerHtml(layerHtml, w, h);
  const { buffer, width, height, durationSec } = await renderWallOfText({
    videoUrl,
    audioUrl,
    layerPng,
    maxDurationSec,
  });
  return { ...(await uploadResult(buffer, width, height, uploadUrl)), durationSec };
}

/**
 * Image Slideshow's export: one full-frame page per slide, each screenshotted
 * as an opaque image and uploaded straight to its own signed URL -- a deck of
 * ten 1080x1920 JPEGs would clear Convex's argument ceiling as base64.
 *
 * Like Wall of Text's layer, every page is built by the format engine from
 * the same style functions its editor previews with, and taken as given here.
 * One browser serves the whole deck; each page waits for its web fonts and
 * every image before it is shot, so nothing ships in a fallback face or
 * without its photo.
 */
const MAX_PAGES = 20;

async function renderImagePages(payload) {
  const { pages, width, height, format = "jpeg", uploadUrls } = payload;
  if (!Array.isArray(pages) || !pages.length) throw new Error("pages is required");
  if (pages.length > MAX_PAGES) throw new Error(`at most ${MAX_PAGES} pages`);
  if (!Array.isArray(uploadUrls) || uploadUrls.length !== pages.length) {
    throw new Error("uploadUrls must have one URL per page");
  }
  const w = Math.round(Number(width));
  const h = Math.round(Number(height));
  if (!(w > 0 && w <= 2160 && h > 0 && h <= 3840)) throw new Error("bad width/height");
  const type = format === "png" ? "png" : "jpeg";
  const contentType = `image/${type}`;

  const files = [];
  for (let i = 0; i < pages.length; i++) {
    if (typeof pages[i] !== "string" || !pages[i]) throw new Error(`page ${i + 1} is empty`);
    // A fresh tab per slide: re-using one for a second setContent can wait
    // on network idle forever once the first page's fonts are cached.
    const buffer = await withPage(async (page) => {
      await page.setViewport({ width: w, height: h, deviceScaleFactor: 1 });
      await page.setContent(pages[i], { waitUntil: "load", timeout: 60_000 });
      await page.evaluate(async () => {
        await document.fonts.ready;
        await Promise.all(
          [...document.images].map((img) => (img.complete ? null : img.decode().catch(() => null))),
        );
      });
      return Buffer.from(
        await page.screenshot({
          type,
          ...(type === "jpeg" ? { quality: 92 } : {}),
          clip: { x: 0, y: 0, width: w, height: h },
        }),
      );
    });
    const up = await fetch(uploadUrls[i], {
      method: "POST",
      headers: { "Content-Type": contentType },
      body: buffer,
    });
    if (!up.ok) throw new Error(`upload of slide ${i + 1} failed: ${up.status} ${await up.text()}`);
    const { storageId } = await up.json();
    files.push({ storageId, bytes: buffer.length, contentType });
  }
  return { ok: true, width: w, height: h, files };
}

// ---- HTTP -------------------------------------------------------------------

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

const server = createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    let ffmpegOk = false;
    try {
      await run(resolveFfmpeg(), ["-version"]);
      ffmpegOk = true;
    } catch {
      ffmpegOk = false;
    }
    return json(res, 200, {
      ok: true,
      browser: (() => {
        try { return resolveBrowser(); } catch { return null; }
      })(),
      ffmpeg: ffmpegOk,
      // Slideshow and Video Animation send one `voiceoverUrl` for the whole cut.
      // A service without this field would ignore it and render the video
      // silently, so the format engine checks for it before it spends anything.
      voiceover: true,
      // Whether a render right now would reuse the warm Chrome.
      browserWarm: Boolean(browserPromise),
      // POST /label/ai exists: the format engine checks before scheduling a
      // post that asks for a burned-in AI label.
      aiLabel: true,
    });
  }

  if (!isAuthorized(req)) {
    return json(res, 401, { ok: false, error: "unauthorized" });
  }

  if (isRateLimited()) {
    return json(res, 429, { ok: false, error: "rate limit exceeded" });
  }

  if (req.method === "POST" && req.url === "/render/carousel") {
    try {
      const payload = await readBody(req);
      const out = await renderCarousel(payload);
      return json(res, 200, out);
    } catch (err) {
      console.error(String(err?.stack || err));
      return json(res, 500, { ok: false, error: String(err?.message || err) });
    }
  }

  if (req.method === "POST" && req.url === "/render/wall-of-text") {
    try {
      const p = await readBody(req);
      // The current format: text laid over a phone clip, drawn by the caller.
      if (p.layerHtml) {
        return json(res, 200, await renderWallOfTextFormat(p));
      }
      // Jobs from before the clip existed: no upload, a generated ground, and
      // type large enough to be the subject rather than a caption on one.
      const out = await renderCustomFormat({
        ...p,
        source: null,
        backgroundColor: p.backgroundColor ?? "#111111",
        captionPosition: p.captionPosition ?? "center",
        textScale: p.textScale ?? 1.8,
      });
      return json(res, 200, out);
    } catch (err) {
      console.error(String(err?.stack || err));
      return json(res, 500, { ok: false, error: String(err?.message || err) });
    }
  }

  if (req.method === "POST" && req.url === "/render/image-pages") {
    try {
      const payload = await readBody(req);
      return json(res, 200, await renderImagePages(payload));
    } catch (err) {
      console.error(String(err?.stack || err));
      return json(res, 500, { ok: false, error: String(err?.message || err) });
    }
  }

  if (req.method === "POST" && req.url === "/render/slideshow") {
    try {
      const payload = await readBody(req);
      const out = await renderSlideshowFormat(payload);
      return json(res, 200, out);
    } catch (err) {
      console.error(String(err?.stack || err));
      return json(res, 500, { ok: false, error: String(err?.message || err) });
    }
  }

  if (req.method === "POST" && req.url === "/render/video-animation") {
    try {
      const payload = await readBody(req);
      const out = await renderVideoAnimationFormat(payload);
      return json(res, 200, out);
    } catch (err) {
      console.error(String(err?.stack || err));
      return json(res, 500, { ok: false, error: String(err?.message || err) });
    }
  }

  if (req.method === "POST" && req.url === "/render/drama") {
    try {
      const payload = await readBody(req);
      const out = await renderDramaFormat(payload);
      return json(res, 200, out);
    } catch (err) {
      console.error(String(err?.stack || err));
      return json(res, 500, { ok: false, error: String(err?.message || err) });
    }
  }

  if (req.method === "POST" && req.url === "/render/video-hook-demo") {
    try {
      const payload = await readBody(req);
      const out = await renderVideoHookDemoFormat(payload);
      return json(res, 200, out);
    } catch (err) {
      console.error(String(err?.stack || err));
      return json(res, 500, { ok: false, error: String(err?.message || err) });
    }
  }

  if (req.method === "POST" && req.url === "/render/green-screen-meme") {
    try {
      const payload = await readBody(req);
      const out = await renderGreenScreenMemeFormat(payload);
      return json(res, 200, out);
    } catch (err) {
      console.error(String(err?.stack || err));
      return json(res, 500, { ok: false, error: String(err?.message || err) });
    }
  }

  if (req.method === "POST" && req.url === "/render/picture-in-picture") {
    try {
      const payload = await readBody(req);
      const out = await renderPictureInPictureFormat(payload);
      return json(res, 200, out);
    } catch (err) {
      console.error(String(err?.stack || err));
      return json(res, 500, { ok: false, error: String(err?.message || err) });
    }
  }

  if (req.method === "POST" && req.url === "/render/custom") {
    try {
      const payload = await readBody(req);
      const out = await renderCustomFormat(payload);
      return json(res, 200, out);
    } catch (err) {
      console.error(String(err?.stack || err));
      return json(res, 500, { ok: false, error: String(err?.message || err) });
    }
  }

  // The AI-disclosure pass (label.mjs): a finished video or image with an
  // "AI-generated" badge burned in and/or an AI tag in its metadata, uploaded
  // straight to the caller's signed URL.
  if (req.method === "POST" && req.url === "/label/ai") {
    try {
      const { mediaUrl, kind, burn, metadata, text, uploadUrl } = await readBody(req);
      if (!uploadUrl) throw new Error("uploadUrl is required");
      const out = await labelMedia({
        mediaUrl,
        kind,
        burn: Boolean(burn),
        metadata: Boolean(metadata),
        text,
        renderLayer: renderLayerHtml,
      });
      const up = await fetch(uploadUrl, {
        method: "POST",
        headers: { "Content-Type": out.contentType },
        body: out.buffer,
      });
      if (!up.ok) throw new Error(`upload to storage failed: ${up.status} ${await up.text()}`);
      const { storageId } = await up.json();
      return json(res, 200, {
        ok: true,
        storageId,
        width: out.width,
        height: out.height,
        bytes: out.buffer.length,
        contentType: out.contentType,
      });
    } catch (err) {
      console.error(String(err?.stack || err));
      return json(res, 500, { ok: false, error: String(err?.message || err) });
    }
  }

  // ---- Character Swap's own small utilities ------------------------------
  // Small enough to return base64 directly -- a single frame or a short
  // audio track never approaches Convex's 16MB function-argument ceiling the
  // way a rendered video does, so none of these need the uploadUrl dance.

  if (req.method === "POST" && req.url === "/inspect/video") {
    try {
      const { videoUrl } = await readBody(req);
      const out = await inspectVideo(videoUrl);
      return json(res, 200, { ok: true, ...out });
    } catch (err) {
      console.error(String(err?.stack || err));
      return json(res, 500, { ok: false, error: String(err?.message || err) });
    }
  }

  if (req.method === "POST" && (req.url === "/frame/first" || req.url === "/frame/last")) {
    try {
      const { videoUrl } = await readBody(req);
      const buffer = await extractFrame(videoUrl, req.url === "/frame/last" ? "last" : "first");
      return json(res, 200, {
        ok: true,
        contentType: "image/png",
        base64: buffer.toString("base64"),
      });
    } catch (err) {
      console.error(String(err?.stack || err));
      return json(res, 500, { ok: false, error: String(err?.message || err) });
    }
  }

  if (req.method === "POST" && req.url === "/extract/audio") {
    try {
      const { videoUrl } = await readBody(req);
      const buffer = await extractAudioTrack(videoUrl);
      return json(res, 200, {
        ok: true,
        contentType: "audio/mpeg",
        base64: buffer.toString("base64"),
      });
    } catch (err) {
      console.error(String(err?.stack || err));
      return json(res, 500, { ok: false, error: String(err?.message || err) });
    }
  }

  // Influencer training's dataset packer -- 10-50 reference photos, so
  // always uploadUrl'd rather than returned as base64; unlike the frame/audio
  // utilities above, this one has no small-payload case worth keeping.
  if (req.method === "POST" && req.url === "/pack/images") {
    try {
      const { imageUrls, uploadUrl } = await readBody(req);
      const buffer = await packImages(imageUrls);
      if (!uploadUrl) {
        return json(res, 400, { ok: false, error: "uploadUrl is required" });
      }
      const uploadRes = await fetch(uploadUrl, {
        method: "POST",
        headers: { "Content-Type": "application/zip" },
        body: buffer,
      });
      if (!uploadRes.ok) {
        throw new Error(`upload to storage failed: ${uploadRes.status} ${await uploadRes.text()}`);
      }
      const { storageId } = await uploadRes.json();
      return json(res, 200, {
        ok: true,
        storageId,
        bytes: buffer.length,
        contentType: "application/zip",
      });
    } catch (err) {
      console.error(String(err?.stack || err));
      return json(res, 500, { ok: false, error: String(err?.message || err) });
    }
  }

  json(res, 404, { ok: false, error: "not found" });
});

server.listen(PORT, () => {
  console.log(`render service on http://localhost:${PORT}`);
});
