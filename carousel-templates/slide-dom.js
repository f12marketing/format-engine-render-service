// The single definition of a carousel slide's markup and geometry.
//
// Imported by BOTH consumers, which is the whole point:
//   - public/project.html   (live picker + preview, via dynamic import)
//   - worker/export_carousel.mjs (headless-Chrome PNG/PDF export)
//
// The architectural promise of carousel mode is that the preview cannot drift
// from the export. Shared CSS alone does not buy that -- two hand-written copies
// of the DOM would still diverge the moment either side gained a field. So the
// DOM lives here, once, and neither consumer is allowed its own copy.
//
// Plain ESM with no imports of its own, so Node and the browser can both load
// it unchanged (the app is "type": "module").

export const SLIDE_DIMS = {
  '4:5': [1080, 1350], '1:1': [1080, 1080], '9:16': [1080, 1920],
  '16:9': [1920, 1080], '4:3': [1440, 1080], '3:4': [1080, 1440],
};

export function dimsFor(aspectRatio) {
  return SLIDE_DIMS[aspectRatio] || SLIDE_DIMS['4:5'];
}

export function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"]/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
  ));
}

const INK = '#14161a';
const INK_LUMINANCE = 0.0075;   // relative luminance of INK, precomputed

function relativeLuminance(hex) {
  const channels = [1, 3, 5].map((o) => parseInt(hex.substr(o, 2), 16) / 255);
  const lin = (c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  return 0.2126 * lin(channels[0]) + 0.7152 * lin(channels[1]) + 0.0722 * lin(channels[2]);
}

const contrastRatio = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);

// Brand custom properties for a slide.
//
// --ct-on-accent is COMPUTED rather than configured: several templates flood
// the accent colour across the whole slide and need text that stays readable on
// top of it.
//
// It picks whichever of white/ink actually CONTRASTS better, rather than
// thresholding luminance. An earlier version used `luminance > 0.45 ? ink :
// white`, which chose white for every mid-tone accent -- including the app's own
// default #6ea8fe, where white scores 2.42:1 (failing WCAG AA even for large
// text) while ink scores 7.55:1. Rendering real decks is what surfaced it: the
// Bold Statement template floods the accent edge to edge, so the whole slide was
// low-contrast.
export function brandVars(branding = {}) {
  const accent = /^#[0-9a-f]{6}$/i.test(branding.accent_color || '')
    ? branding.accent_color : '#6ea8fe';
  const L = relativeLuminance(accent);
  const onAccent = contrastRatio(L, 1) >= contrastRatio(L, INK_LUMINANCE) ? '#ffffff' : INK;
  const font = (branding.font_family || '').trim();
  return `--ct-accent:${accent};--ct-on-accent:${onAccent}`
       + (font ? `;--ct-font:${font}, ui-sans-serif, system-ui, sans-serif` : '');
}

// One slide, laid out at TRUE pixel size. The preview scales this down with a
// CSS transform; the exporter screenshots it as-is. font-size is set from the
// width (16px at 1080) so every template can express type and spacing in `em`
// and render correctly at any aspect ratio without a media query.
export function slideHtml({ slide, index, total, templateId, dims, branding, footerLeft }) {
  const [w, h] = dims;
  return `<div class="slide" data-template="${escapeHtml(templateId)}" `
    + `data-role="${escapeHtml(slide.role || '')}" data-index="${index + 1}" `
    + `style="width:${w}px;height:${h}px;font-size:${w / 67.5}px;${brandVars(branding)}">`
    + '<div class="slide-inner">'
    + `<div class="slide-kicker">${escapeHtml(slide.kicker || '')}</div>`
    + `<div class="slide-headline">${escapeHtml(slide.headline || '')}</div>`
    + `<div class="slide-body">${escapeHtml(slide.body || '')}</div>`
    + `<div class="slide-cue">${escapeHtml(slide.swipe_cue || '')}</div>`
    + '</div>'
    + '<div class="slide-meta">'
    + `<span>${escapeHtml(footerLeft || '')}</span>`
    + `<span>${index + 1}/${total}</span>`
    + '</div></div>';
}
