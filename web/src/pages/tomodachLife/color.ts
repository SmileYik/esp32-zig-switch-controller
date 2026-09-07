export type RGBColor = { r: number; g: number; b: number };
export type PixelData = RGBColor | null;
export type TomodachiHSV = {
  hTicks: number;
  sTicks: number;
  vTicks: number;
};
export const TOMODACHI_HSV_H_TICKS = 201;
export const TOMODACHI_HSV_S_TICKS = 212;
export const TOMODACHI_HSV_V_TICKS = 111;

export const rgbToHex = (c: RGBColor) =>
  '#' + [c.r, c.g, c.b].map((x) => x.toString(16).padStart(2, '0')).join('');

export const hexToRgb = (hex: string): RGBColor => {
  const num = parseInt(hex.replace('#', ''), 16);
  return {
    r: (num >> 16) & 255,
    g: (num >> 8) & 255,
    b: num & 255,
  };
};

// RGB 转 Tomodachi HSV
export const rgbToTomodachiHSV = (r: number, g: number, b: number): TomodachiHSV => {
  const rf = r / 255, gf = g / 255, bf = b / 255;
  const max = Math.max(rf, gf, bf), min = Math.min(rf, gf, bf);
  const delta = max - min;

  let h = 0;
  if (delta !== 0) {
    if (max === rf) h = ((gf - bf) / delta) % 6;
    else if (max === gf) h = (bf - rf) / delta + 2;
    else h = (rf - gf) / delta + 4;
    h = Math.round(h * 60);
    if (h < 0) h += 360;
  }

  const s = max === 0 ? 0 : delta / max;
  const v = max;

  const hTicks = Math.floor((((360 - h) % 360) / 360) * 201);
  const sTicks = Math.round(s * 212);
  const vTicks = Math.round((1 - v) * 111);

  return { hTicks, sTicks, vTicks };
};

// Tomodachi HSV 刻度转 RGB
export const tomodachiHSVToRgb = (hTicks: number, sTicks: number, vTicks: number): RGBColor => {
  let h = (360 - (hTicks / 201) * 360) % 360;
  if (h < 0) h += 360;
  const s = Math.min(1, Math.max(0, sTicks / 212));
  const v = Math.min(1, Math.max(0, 1 - vTicks / 111));

  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;

  let r = 0, g = 0, b = 0;
  if (h >= 0 && h < 60) { r = c; g = x; b = 0; }
  else if (h >= 60 && h < 120) { r = x; g = c; b = 0; }
  else if (h >= 120 && h < 180) { r = 0; g = c; b = x; }
  else if (h >= 180 && h < 240) { r = 0; g = x; b = c; }
  else if (h >= 240 && h < 300) { r = x; g = 0; b = c; }
  else { r = c; g = 0; b = x; }

  return {
    r: Math.round((r + m) * 255),
    g: Math.round((g + m) * 255),
    b: Math.round((b + m) * 255),
  };
};

