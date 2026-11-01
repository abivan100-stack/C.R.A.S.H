/* jsPDF export adapters: city-wide and per-zone briefs, ported from report.js.
   Numbers come from reportData, so the PDF matches the on-screen figures. */

import { DOW, MON, SEV } from '../domain/constants.ts';
import type { CityReportData, ZoneReportData } from '../domain/reportData.ts';
import { ymRange } from '../domain/reportData.ts';
import { fmt, pad2, pct, sortedEntries } from '../lib/utils.ts';

type Doc = any;
type Rgb = [number, number, number];

const MARGIN = 40;
const C = {
  accent: [47, 92, 135] as Rgb,
  dark: [34, 31, 24] as Rgb,
  gray: [110, 103, 90] as Rgb,
  light: [244, 240, 231] as Rgb,
  calloutBg: [234, 240, 245] as Rgb,
  white: [255, 255, 255] as Rgb,
  rule: [214, 209, 193] as Rgb,
  head: [34, 31, 24] as Rgb,
  row: [246, 248, 251] as Rgb,
};

/** jsPDF's built-in fonts only encode Latin-1; map the typographic marks used
    in the copy to ASCII before they reach the document. */
export function asciiSafe(value: string): string {
  return String(value)
    .replace(/≈/g, '~')
    .replace(/[–—]/g, '-')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/×/g, 'x')
    .replace(/·/g, '-')
    .replace(/°/g, '')
    .replace(/[^\x00-\x7F]/g, '');
}

function newDoc(): Doc | null {
  const JS = (window as unknown as { jspdf?: { jsPDF?: new (opts: object) => Doc } }).jspdf?.jsPDF;
  if (!JS) return null;
  const doc = new JS({ unit: 'pt', format: 'a4' });
  if (typeof doc.autoTable !== 'function') return null;
  const text = doc.text.bind(doc);
  doc.text = (s: string | string[], ...rest: unknown[]) => text(Array.isArray(s) ? s.map(asciiSafe) : asciiSafe(s), ...rest);
  return doc;
}

const pageW = (doc: Doc): number => doc.internal.pageSize.getWidth();
const pageH = (doc: Doc): number => doc.internal.pageSize.getHeight();
const fill = (doc: Doc, c: Rgb): void => doc.setFillColor(c[0], c[1], c[2]);
const ink = (doc: Doc, c: Rgb): void => doc.setTextColor(c[0], c[1], c[2]);
const stroke = (doc: Doc, c: Rgb): void => doc.setDrawColor(c[0], c[1], c[2]);

function today(): string {
  const d = new Date();
  return `${pad2(d.getDate())} ${MON[d.getMonth()]} ${d.getFullYear()}`;
}

function todayFile(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function header(doc: Doc, title: string, subtitle: string, metaLines: string[]): number {
  let y = 46;
  fill(doc, C.accent);
  doc.roundedRect(MARGIN, y - 17, 27, 27, 5, 5, 'F');
  ink(doc, C.white);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(15);
  doc.text('C', MARGIN + 13.5, y + 2.5, { align: 'center' });
  ink(doc, C.dark);
  doc.setFontSize(16.5);
  doc.text(title, MARGIN + 38, y - 3);
  ink(doc, C.gray);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.text(subtitle, MARGIN + 38, y + 11);
  doc.setFontSize(8.5);
  metaLines.forEach((line, i) => doc.text(line, pageW(doc) - MARGIN, y - 9 + i * 11, { align: 'right' }));
  y += 28;
  stroke(doc, C.accent);
  doc.setLineWidth(1.4);
  doc.line(MARGIN, y, pageW(doc) - MARGIN, y);
  return y + 20;
}

function ensureSpace(doc: Doc, y: number, need: number): number {
  if (y + need > pageH(doc) - 46) {
    doc.addPage();
    return 54;
  }
  return y;
}

function sectionTitle(doc: Doc, y: number, label: string): number {
  const at = ensureSpace(doc, y, 72);
  ink(doc, C.dark);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.text(label, MARGIN, at);
  return at + 9;
}

function kpiRow(doc: Doc, y: number, items: Array<{ v: string; l: string }>): number {
  const gap = 9;
  const width = (pageW(doc) - 2 * MARGIN - gap * (items.length - 1)) / items.length;
  const h = 46;
  items.forEach((item, i) => {
    const x = MARGIN + i * (width + gap);
    fill(doc, C.light);
    doc.roundedRect(x, y, width, h, 5, 5, 'F');
    ink(doc, C.dark);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(15);
    doc.text(item.v, x + 10, y + 23);
    ink(doc, C.gray);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7);
    doc.text(item.l.toUpperCase(), x + 10, y + 37);
  });
  return y + h + 18;
}

function callout(doc: Doc, y: number, big: string, text: string): number {
  const width = pageW(doc) - 2 * MARGIN;
  const h = 46;
  fill(doc, C.calloutBg);
  doc.roundedRect(MARGIN, y, width, h, 6, 6, 'F');
  ink(doc, C.accent);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(23);
  doc.text(big, MARGIN + 15, y + 30);
  const bigWidth = doc.getTextWidth(big);
  ink(doc, C.dark);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10.5);
  const lines = doc.splitTextToSize(text, width - bigWidth - 44);
  doc.text(lines, MARGIN + 15 + bigWidth + 14, y + (h - (lines.length - 1) * 13) / 2 + 3);
  return y + h + 20;
}

function table(doc: Doc, head: string[], body: Array<Array<string | number>>, startY: number, columnStyles: Record<string, object> = {}): number {
  doc.autoTable({
    head: [head],
    body,
    startY,
    margin: { left: MARGIN, right: MARGIN },
    theme: 'grid',
    styles: { font: 'helvetica', fontSize: 9, cellPadding: 4.5, lineColor: C.rule, lineWidth: 0.5, textColor: [40, 50, 62], overflow: 'linebreak' },
    headStyles: { fillColor: C.head, textColor: C.white, fontStyle: 'bold', fontSize: 8.5 },
    alternateRowStyles: { fillColor: C.row },
    columnStyles,
    didParseCell: (data: { cell: { text: unknown } }) => {
      const t = data.cell.text;
      if (Array.isArray(t)) data.cell.text = t.map((v) => asciiSafe(String(v)));
      else if (t != null) data.cell.text = asciiSafe(String(t));
    },
  });
  return doc.lastAutoTable.finalY + 20;
}

function footer(doc: Doc): void {
  const pages = doc.internal.getNumberOfPages();
  for (let i = 1; i <= pages; i += 1) {
    doc.setPage(i);
    stroke(doc, C.rule);
    doc.setLineWidth(0.5);
    doc.line(MARGIN, pageH(doc) - 34, pageW(doc) - MARGIN, pageH(doc) - 34);
    ink(doc, C.gray);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.5);
    doc.text('CRASH - Simulated data for demonstration, not an official record. Impact figures are planning estimates.', MARGIN, pageH(doc) - 22);
    doc.text(`Page ${i} of ${pages}`, pageW(doc) - MARGIN, pageH(doc) - 22, { align: 'right' });
  }
}

export function exportCityPdf(data: CityReportData): boolean {
  const doc = newDoc();
  if (!doc) return false;
  const total = data.total || 1;
  let y = header(doc, 'Chennai Road Accident Safety Hub', 'City-wide safety report - Greater Chennai', [ymRange(data.range), `Generated ${today()}`]);
  y = kpiRow(doc, y, [
    { v: fmt(data.total), l: 'Incidents' },
    { v: fmt(data.sev.fatal), l: 'Fatalities' },
    { v: fmt(data.sev.fatal + data.sev.serious), l: 'Severe' },
    { v: fmt(data.highRisk), l: 'Risk zones' },
    { v: fmt(data.emerging.qualifyingCount), l: 'Emerging' },
    { v: fmt(Math.round(data.total / data.monthCount)), l: 'Per month' },
  ]);
  y = callout(doc, y, `${data.leveragePct}%`, `of the city's severe crashes occur in the top ${data.top.length} junction cells (${fmt(data.sevTop)} of ${fmt(data.sevCity)} fatal + serious).`);
  y = sectionTitle(doc, y, 'Top 10 ranked junctions');
  y = table(doc, ['#', 'Area', 'Incidents', 'Fatal', 'Serious', 'Risk /100'],
    data.top.map((c, i) => [i + 1, c.area, fmt(c.count), fmt(c.fatal), fmt(c.serious), String(c.norm ?? '')]), y,
    { 0: { cellWidth: 24, halign: 'center' }, 2: { halign: 'right' }, 3: { halign: 'right' }, 4: { halign: 'right' }, 5: { halign: 'right' } });
  y = sectionTitle(doc, y, 'Contributing causes');
  y = table(doc, ['Cause', 'Incidents', 'Share'], sortedEntries(data.cause).map(([name, count]) => [name, fmt(count), pct(count, total)]), y, { 1: { halign: 'right' }, 2: { halign: 'right' } });
  y = sectionTitle(doc, y, 'Vehicles involved');
  y = table(doc, ['Vehicle', 'Incidents', 'Share'], sortedEntries(data.veh).map(([name, count]) => [name, fmt(count), pct(count, total)]), y, { 1: { halign: 'right' }, 2: { halign: 'right' } });
  y = sectionTitle(doc, y, 'Emerging hotspots - recent 6 mo vs prior 18 mo');
  y = table(doc, ['Area', 'Recent', 'Prior', 'Rate lift', 'Increase'],
    data.emerging.length
      ? data.emerging.map((e) => [e.area, fmt(e.recent), fmt(e.baseline), `${e.lift.toFixed(2)}x`, `+${e.pct}%`])
      : [['- none surging -', '', '', '', '']], y,
    { 1: { halign: 'right' }, 2: { halign: 'right' }, 3: { halign: 'right' }, 4: { halign: 'right' } });
  y = sectionTitle(doc, y, 'Intervention priority - est. severe crashes preventable');
  table(doc, ['#', 'Area', 'Dominant cause', 'Recommended intervention', 'Cost', 'Prevent'],
    data.queue.map((row, i) => [i + 1, row.area, row.dom, row.iv.fix, row.iv.cost, `~ ${fmt(row.prevent)}`]), y,
    { 0: { cellWidth: 22, halign: 'center' }, 3: { cellWidth: 148 }, 5: { halign: 'right' } });
  footer(doc);
  doc.save('Complete Report.pdf');
  return true;
}

export interface ZoneMeta {
  rank?: number;
  area?: string;
  lat?: number;
  lng?: number;
  subtitle?: string;
}

export function exportZonePdf(data: ZoneReportData, meta: ZoneMeta = {}): boolean {
  const doc = newDoc();
  if (!doc) return false;
  const total = data.total || 1;
  const subtitle = meta.subtitle ?? `${meta.rank ? `Hotspot ${pad2(meta.rank)} - ` : ''}Zone safety report - 250 m cell`;
  const metaLines: string[] = [];
  if (meta.lat != null && meta.lng != null) metaLines.push(`${meta.lat.toFixed(4)} N - ${meta.lng.toFixed(4)} E`);
  metaLines.push(`Generated ${today()}`);
  let y = header(doc, meta.area ?? 'Zone report', subtitle, metaLines);
  y = kpiRow(doc, y, [
    { v: fmt(data.total), l: 'Incidents' },
    { v: fmt(data.sev.fatal), l: 'Fatal' },
    { v: fmt(data.sev.serious), l: 'Serious' },
    { v: fmt(data.sev.slight), l: 'Slight' },
    { v: pct(data.night, total), l: 'Night' },
    { v: `${pad2(data.peakHour)}:00`, l: 'Peak hour' },
  ]);
  y = sectionTitle(doc, y, 'Severity breakdown');
  y = table(doc, ['Severity', 'Incidents', 'Share'], [
    ['Fatal', fmt(data.sev.fatal), pct(data.sev.fatal, total)],
    ['Serious', fmt(data.sev.serious), pct(data.sev.serious, total)],
    ['Slight', fmt(data.sev.slight), pct(data.sev.slight, total)],
  ], y, { 1: { halign: 'right' }, 2: { halign: 'right' } });
  y = sectionTitle(doc, y, 'Top causes');
  y = table(doc, ['Cause', 'Incidents', 'Share'], sortedEntries(data.cause).slice(0, 6).map(([n, c]) => [n, fmt(c), pct(c, total)]), y, { 1: { halign: 'right' }, 2: { halign: 'right' } });
  y = sectionTitle(doc, y, 'Vehicles involved');
  y = table(doc, ['Vehicle', 'Incidents', 'Share'], sortedEntries(data.veh).slice(0, 6).map(([n, c]) => [n, fmt(c), pct(c, total)]), y, { 1: { halign: 'right' }, 2: { halign: 'right' } });
  y = sectionTitle(doc, y, `Weather at incident - peak day ${DOW[data.peakDow] ?? ''}`);
  y = table(doc, ['Condition', 'Incidents', 'Share'], [
    ['Clear', fmt(data.weather.clear), pct(data.weather.clear, total)],
    ['Rain', fmt(data.weather.rain), pct(data.weather.rain, total)],
    ['Fog', fmt(data.weather.fog), pct(data.weather.fog, total)],
  ], y, { 1: { halign: 'right' }, 2: { halign: 'right' } });

  y = ensureSpace(doc, y, 90);
  const width = pageW(doc) - 2 * MARGIN;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10.5);
  const lines = doc.splitTextToSize(`Dominant cause: ${data.domCause}.  ${data.iv.fix}.`, width - 26);
  const h = 22 + lines.length * 14 + 30;
  fill(doc, C.calloutBg);
  doc.roundedRect(MARGIN, y, width, h, 6, 6, 'F');
  ink(doc, C.dark);
  doc.text(lines, MARGIN + 13, y + 20);
  ink(doc, C.accent);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(13);
  doc.text(`~ ${fmt(data.preventable)} severe crashes preventable`, MARGIN + 13, y + 22 + lines.length * 14);
  ink(doc, C.gray);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.text(`Capital cost: ${data.iv.cost}   -   planning estimate over the record window`, MARGIN + 13, y + 37 + lines.length * 14);
  footer(doc);
  doc.save(`${String(meta.area ?? 'Zone').replace(/[\\/:*?"<>|]+/g, '').trim() || 'report'}.pdf`);
  return true;
}

export function exportDateStamp(): string {
  return todayFile();
}

export const SEVERITY_LABELS = SEV;
