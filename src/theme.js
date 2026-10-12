// The sky: the backdrop the world is drawn against. It is a preference, not
// part of the world — the body gradient and the ground grid are the only things
// it touches, so an exported world never carries the look of the machine it was
// made on.

export const DEFAULT_BG = '#18202a';

// The backdrop is a radial gradient: the chosen colour at the centre, a darker
// rim behind it. The stock pair (#18202a -> #0a0d12) is exactly this ratio, so
// any colour picked keeps the same falloff.
const RIM = 0.42;

// Ground hairlines are drawn in the sky's opposite: white on a dark backdrop,
// black on a light one, or they would not be there at all.
const INK_ON_DARK = { minor: 'rgba(255,255,255,0.075)', major: 'rgba(255,255,255,0.175)' };
const INK_ON_LIGHT = { minor: 'rgba(0,0,0,0.11)', major: 'rgba(0,0,0,0.24)' };

let ink = INK_ON_DARK;

/** Hairline colours for the ground grid, for the sky now in use. */
export function gridInk() { return ink; }

function hex2rgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function rgb2hex(r, g, b) {
  return '#' + [r, g, b].map((c) => Math.round(c).toString(16).padStart(2, '0')).join('');
}

/**
 * Repaint the backdrop from one colour: sets the two gradient stops and the
 * grid ink, and returns the colour it settled on (the default if the argument
 * is not a hex colour), so callers can echo it back into the picker.
 */
export function applyBackground(hex) {
  const rgb = hex2rgb(hex) || hex2rgb(DEFAULT_BG);
  const style = document.documentElement.style;
  style.setProperty('--bg1', rgb2hex(rgb.r, rgb.g, rgb.b));
  style.setProperty('--bg2', rgb2hex(rgb.r * RIM, rgb.g * RIM, rgb.b * RIM));
  // Rec. 601 luma: it only has to answer "would a white hairline show up here".
  ink = (0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b) / 255 > 0.5 ? INK_ON_LIGHT : INK_ON_DARK;
  return rgb2hex(rgb.r, rgb.g, rgb.b);
}
