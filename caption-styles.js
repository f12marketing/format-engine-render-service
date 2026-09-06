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
}) {
  const css = STYLE_CSS[style] ?? STYLE_CSS.Classic;
  const align =
    position === "top" ? "flex-start" : position === "center" ? "center" : "flex-end";

  return `<!doctype html><html><head><meta charset="utf-8"><style>
  html, body { margin: 0; padding: 0; background: transparent; }
  .frame {
    width: ${width}px; height: ${height}px;
    display: flex; align-items: ${align}; justify-content: center;
    /* 8% inset all round: the platform-safe area for vertical video. */
    padding: ${Math.round(height * 0.08)}px ${Math.round(width * 0.08)}px;
    box-sizing: border-box;
    font-size: ${(width / 22).toFixed(2)}px;
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
