/**
 * The five caption styles, as one component.
 *
 * Five formats declare `field.captionStyle()` -- Speaking Hook & Demo, Talking
 * Head UGC, Product Spokesperson, Claymation, Skeleton -- and Custom draws its
 * text with the same system. Written once here rather than per format, which is
 * the actual deliverable of the render-service phase.
 *
 * Text is drawn by headless Chrome into a transparent PNG and then composited
 * by ffmpeg, rather than through ffmpeg's own `drawtext`. Three reasons: real
 * typography and web fonts, wrapping that behaves, and no escaping minefield
 * for arbitrary user text. It also reuses the browser this service already
 * drives for carousels.
 */

export const CAPTION_STYLES = [
  "Classic",
  "Outline",
  "Yellow Pop",
  "Comic",
  "Headline",
];

/**
 * Sizes are in `em` against a font-size of width/22, so a caption occupies the
 * same proportion of the frame at 1080x1920 as at any other size.
 */
const STYLE_CSS = {
  Classic: `
    color: #fff;
    font-family: "Inter", "Segoe UI", system-ui, sans-serif;
    font-weight: 700;
    text-shadow: 0 0.06em 0.18em rgba(0,0,0,.65);
  `,
  Outline: `
    color: #fff;
    font-family: "Inter", "Segoe UI", system-ui, sans-serif;
    font-weight: 800;
    -webkit-text-stroke: 0.055em #000;
    paint-order: stroke fill;
  `,
  "Yellow Pop": `
    color: #ffd400;
    font-family: "Inter", "Segoe UI", system-ui, sans-serif;
    font-weight: 900;
    text-transform: uppercase;
    letter-spacing: -0.01em;
    -webkit-text-stroke: 0.045em #000;
    paint-order: stroke fill;
    text-shadow: 0 0.05em 0 #000;
  `,
  Comic: `
    color: #fff;
    font-family: "Comic Sans MS", "Chalkboard SE", cursive, sans-serif;
    font-weight: 700;
    -webkit-text-stroke: 0.05em #1b1b1b;
    paint-order: stroke fill;
    text-shadow: 0.03em 0.05em 0 #ff4d6d;
  `,
  Headline: `
    color: #fff;
    font-family: Georgia, "Times New Roman", serif;
    font-weight: 700;
    background: rgba(0,0,0,.62);
    padding: 0.35em 0.5em;
    border-radius: 0.12em;
    box-decoration-break: clone;
    -webkit-box-decoration-break: clone;
  `,
};

/**
 * A full-frame transparent page with the caption positioned in it.
 *
 * `position` is where the text sits vertically; the safe inset keeps it clear
 * of platform UI, which crops the bottom of a vertical video more than you
 * expect.
 */
export function captionLayerHtml({
  text,
  style = "Classic",
  width,
  height,
  position = "bottom",
  /**
   * Multiplier on the base type size. A caption sits under the action at 1;
   * Wall of Text *is* the action, so it runs around 1.8 and fills the frame.
   * One layer renderer either way -- the difference is a number, not a second
   * code path.
   */
  scale = 1,
  background = null,
}) {
  const css = STYLE_CSS[style] ?? STYLE_CSS.Classic;
  const align =
    position === "top" ? "flex-start" : position === "center" ? "center" : "flex-end";

  return `<!doctype html><html><head><meta charset="utf-8"><style>
  html, body { margin: 0; padding: 0; background: ${background ?? "transparent"}; }
  .frame {
    width: ${width}px; height: ${height}px;
    display: flex; align-items: ${align}; justify-content: center;
    /* 8% inset all round: the platform-safe area for vertical video. */
    padding: ${Math.round(height * 0.08)}px ${Math.round(width * 0.08)}px;
    box-sizing: border-box;
    font-size: ${((width / 22) * scale).toFixed(2)}px;
  }
  .caption {
    max-width: 100%;
    text-align: center;
    line-height: 1.18;
    text-wrap: balance;
    ${css}
  }
</style></head><body>
  <div class="frame"><div class="caption">${escapeHtml(text)}</div></div>
</body></html>`;
}

/**
 * A branded title card or end screen, as a full-frame opaque page.
 *
 * The old app rendered these in Remotion, which meant a second renderer, a
 * Node toolchain on the render box and a logo placed on disk by hand. They
 * are the same thing the caption layers already are -- typography Chrome
 * draws and ffmpeg composites -- so they are drawn here instead. The only
 * differences from a caption layer: these are opaque, and they become their
 * own segment on the timeline rather than an overlay on someone else's.
 *
 * `kind` is "title" or "end". The title card leads with the brand name; the
 * end screen leads with the closing message and falls back to the name when
 * there isn't one, so a blank closing message still produces a real card
 * rather than an empty one.
 */
export function brandCardHtml({
  kind = "title",
  width,
  height,
  name = "",
  tagline = "",
  closingMessage = "",
  primaryColor = "#111827",
  accentColor = "#e11d48",
  textColor = "#ffffff",
  fontFamily = "Montserrat",
  logoDataUri = null,
}) {
  const isEnd = kind === "end";
  const headline = isEnd ? closingMessage || name : name;
  const sub = isEnd ? (closingMessage ? name : tagline) : tagline;
  // Same base as a caption layer -- width/22 -- so a card is typographically
  // the same size relative to its frame at every aspect ratio.
  const base = width / 22;
  const fontHref =
    `https://fonts.googleapis.com/css2?family=${encodeURIComponent(fontFamily)}` +
    ":wght@400;700;900&display=swap";

  return `<!doctype html><html><head><meta charset="utf-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="${escapeHtml(fontHref)}" rel="stylesheet">
<style>
  html, body { margin: 0; padding: 0; }
  .card {
    width: ${width}px; height: ${height}px;
    display: flex; flex-direction: column;
    align-items: center; justify-content: center;
    gap: ${(base * 0.45).toFixed(1)}px;
    padding: ${Math.round(height * 0.1)}px ${Math.round(width * 0.1)}px;
    box-sizing: border-box;
    text-align: center;
    background: ${primaryColor};
    font-family: "${fontFamily}", "Segoe UI", system-ui, sans-serif;
    color: ${textColor};
    position: relative;
    overflow: hidden;
  }
  /* A wash of the accent behind the type, so the card reads as branded
     rather than as a flat colour with words on it. */
  .card::after {
    content: ""; position: absolute; inset: 0;
    background: radial-gradient(circle at 50% 18%, ${accentColor}33, transparent 62%);
  }
  .card > * { position: relative; z-index: 1; }
  .logo {
    max-width: ${Math.round(width * 0.42)}px;
    max-height: ${Math.round(height * 0.2)}px;
    object-fit: contain;
    margin-bottom: ${(base * 0.3).toFixed(1)}px;
  }
  .headline {
    font-size: ${(base * 1.45).toFixed(1)}px; font-weight: 900;
    line-height: 1.12; text-wrap: balance; margin: 0;
  }
  .sub {
    font-size: ${(base * 0.6).toFixed(1)}px; font-weight: 400;
    line-height: 1.35; opacity: .82; text-wrap: balance; margin: 0;
  }
  .rule {
    width: ${(base * 2.2).toFixed(1)}px;
    height: ${Math.max(3, base * 0.1).toFixed(1)}px;
    background: ${accentColor}; border-radius: 999px;
  }
</style></head><body>
  <div class="card">
    ${logoDataUri ? `<img class="logo" src="${logoDataUri}" alt="">` : ""}
    ${headline ? `<h1 class="headline">${escapeHtml(headline)}</h1>` : ""}
    <div class="rule"></div>
    ${sub ? `<p class="sub">${escapeHtml(sub)}</p>` : ""}
  </div>
</body></html>`;
}

export function escapeHtml(str) {
  return String(str ?? "").replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
  );
}

/** Target pixel dimensions per aspect ratio. 1080 on the short edge throughout. */
export const DIMENSIONS = {
  "9:16": [1080, 1920],
  "1:1": [1080, 1080],
  "4:5": [1080, 1350],
  "16:9": [1920, 1080],
  "4:3": [1440, 1080],
  "3:4": [1080, 1440],
};

export function dimensionsFor(ratio) {
  return DIMENSIONS[ratio] ?? DIMENSIONS["9:16"];
}
