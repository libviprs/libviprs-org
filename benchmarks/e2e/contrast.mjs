// WCAG 2.x contrast, measured. Shared by the specs so every ratio they print is
// computed the same way: relative luminance per the spec, sRGB transfer curve.

/** [r, g, b] (0-255) from '#rgb', '#rrggbb', 'rgb(...)' or 'rgba(...)'. */
export function rgb(css) {
  const s = String(css).trim();
  let m = /^#([0-9a-f]{3})$/i.exec(s);
  if (m) return [...m[1]].map((h) => parseInt(h + h, 16));
  m = /^#([0-9a-f]{6})$/i.exec(s);
  if (m) return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
  m = /^rgba?\(\s*(\d+(?:\.\d+)?)[ ,]+(\d+(?:\.\d+)?)[ ,]+(\d+(?:\.\d+)?)/.exec(s);
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3])];
  throw new Error(`cannot read a colour from ${JSON.stringify(css)}`);
}

export function luminance([r, g, b]) {
  const lin = (c) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

export function ratio(a, b) {
  const [hi, lo] = [luminance(rgb(a)), luminance(rgb(b))].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** The colour tokens an SVG chart declares, per scheme. The charts carry their
 *  own palette as CSS variables and switch on prefers-color-scheme, so that is
 *  where the pairs have to be read from. */
export function chartTokens(svg) {
  const style = /<style>([\s\S]*?)<\/style>/.exec(svg)?.[1] ?? '';
  const vars = (block) => Object.fromEntries([...block.matchAll(/(--bc-[a-z-]+):\s*(#[0-9a-f]{3,6})/gi)].map((m) => [m[1], m[2]]));
  const dark = /@media \(prefers-color-scheme: dark\)\{[^{]*\{([^}]*)\}/.exec(style)?.[1] ?? '';
  const base = /^:root\{([^}]*)\}/.exec(style)?.[1] ?? '';
  return { light: vars(base), dark: { ...vars(base), ...vars(dark) } };
}

/** Every text colour in a chart, as the token it names or the literal it uses. */
export function chartTextFills(svg) {
  const fills = new Map();
  for (const m of svg.matchAll(/<text\b[^>]*\bfill="([^"]+)"/g)) fills.set(m[1], (fills.get(m[1]) ?? 0) + 1);
  return fills;
}

export function resolveFill(fill, tokens) {
  const v = /^var\((--[a-z-]+)\)$/.exec(fill);
  return v ? tokens[v[1]] : fill;
}
