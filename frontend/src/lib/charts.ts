/* Thin Chart.js adapter: one canvas, one instance, theme-aware palette. */

export interface Palette {
  text: string;
  text2: string;
  border: string;
  grid: string;
  accent: string;
  day: string;
  night: string;
  panel: string;
}

export function readPalette(): Palette {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string): string => css.getPropertyValue(name).trim();
  return {
    text: v('--text'),
    text2: v('--text-2'),
    border: v('--border'),
    grid: v('--track'),
    accent: v('--accent'),
    day: v('--chart-day'),
    night: v('--chart-night'),
    panel: v('--panel'),
  };
}

export function themeChartDefaults(pal: Palette): void {
  Chart.defaults.font.family = "'Roboto', sans-serif";
  Chart.defaults.font.size = 11;
  Chart.defaults.color = pal.text2;
  Chart.defaults.borderColor = pal.grid;
  const legend = Chart.defaults.plugins.legend;
  legend.labels.color = pal.text2;
  legend.labels.boxWidth = 10;
  legend.labels.boxHeight = 10;
  legend.labels.font = { family: "'IBM Plex Mono', monospace", size: 10 };
  const tooltip = Chart.defaults.plugins.tooltip;
  tooltip.backgroundColor = pal.panel;
  tooltip.titleColor = pal.text;
  tooltip.bodyColor = pal.text2;
  tooltip.borderColor = pal.border;
  tooltip.borderWidth = 1;
  tooltip.padding = 10;
  tooltip.displayColors = true;
  tooltip.boxPadding = 4;
  tooltip.titleFont = { family: "'Roboto', sans-serif", weight: '600', size: 12 };
  tooltip.bodyFont = { family: "'IBM Plex Mono', monospace", size: 11 };
}

export function catAxis(pal: Palette, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    grid: { display: false },
    border: { color: pal.border },
    ticks: { color: pal.text2, font: { family: "'IBM Plex Mono', monospace", size: 10 } },
    ...extra,
  };
}

export function valAxis(pal: Palette, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    grid: { color: pal.grid, drawTicks: false },
    border: { display: false },
    ticks: { color: pal.text2, font: { family: "'IBM Plex Mono', monospace", size: 10 }, precision: 0 },
    ...extra,
  };
}

export const BASE_OPTIONS = { responsive: true, maintainAspectRatio: false, animation: { duration: 400 } };
