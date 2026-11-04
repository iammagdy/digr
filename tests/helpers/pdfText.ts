import { inflateSync } from "node:zlib";

/**
 * THE TEXT A PDF DRAWS, read back out of its bytes (for tests of the methodology PDF). It reads what pdfkit writes: Type0 fonts with a ToUnicode map, and text shown by `Tj` / `TJ` with 2-byte hex glyph ids. The result is one string per text-showing operation, IN THE ORDER THE GLYPHS ARE DRAWN
 * (left to right on the page): a number that reads correctly on the page reads correctly here, and a right-to-left line comes out as drawn (words from the right edge). Written for this test only; it is not a general PDF reader.
 */
function cmapOf(body: string): Map<number, string> {
  const map = new Map<number, string>();
  const unicode = (hex: string): string => { let out = ""; for (let i = 0; i + 4 <= hex.length; i += 4) out += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16)); return out; };
  for (const m of body.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) for (const p of m[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) map.set(parseInt(p[1], 16), unicode(p[2]));
  for (const m of body.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    // pdfkit writes ONE range whose destinations are an array: «<0000> <0074> [<0041> <0628 0631> ...]» (a glyph that stands for several characters has them in one pair of brackets)
    const arrays = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*\[([^\]]*)\]/g;
    for (const p of m[1].matchAll(arrays)) {
      const from = parseInt(p[1], 16);
      [...p[3].matchAll(/<([0-9A-Fa-f\s]+)>/g)].forEach((d, k) => map.set(from + k, unicode(d[1].replace(/\s+/g, ""))));
    }
    for (const p of m[1].replace(arrays, "").matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      const from = parseInt(p[1], 16); const to = parseInt(p[2], 16); const start = unicode(p[3]);
      for (let g = from; g <= to; g += 1) map.set(g, String.fromCharCode(start.charCodeAt(0) + (g - from)));
    }
  }
  return map;
}

function parsePdf(pdf: Buffer): { fontMaps: Map<number, Map<number, string>>; nameToFont: Map<string, number>; streams: string[] } {
  const raw = pdf.toString("latin1");
  const objects = new Map<number, { dict: string; stream: string | null }>();
  for (const m of raw.matchAll(/(\d+) 0 obj([\s\S]*?)endobj/g)) {
    const body = m[2];
    const at = body.indexOf("stream");
    let stream: string | null = null;
    let dict = body;
    if (at >= 0) {
      dict = body.slice(0, at);
      const start = body.indexOf("\n", at) + 1;
      const end = body.lastIndexOf("endstream");
      const bytes = Buffer.from(body.slice(start, end).replace(/\r?\n$/, ""), "latin1");
      stream = /FlateDecode/.test(dict) ? (() => { try { return inflateSync(bytes).toString("latin1"); } catch { return null; } })() : bytes.toString("latin1");
    }
    objects.set(Number(m[1]), { dict, stream });
  }
  const fontMaps = new Map<number, Map<number, string>>();
  for (const [id, o] of objects) {
    const t = /\/ToUnicode (\d+) 0 R/.exec(o.dict);
    if (t && objects.get(Number(t[1]))?.stream) fontMaps.set(id, cmapOf(objects.get(Number(t[1]))!.stream!));
  }
  const nameToFont = new Map<string, number>();
  for (const o of objects.values()) for (const m of o.dict.matchAll(/\/(F\d+) (\d+) 0 R/g)) nameToFont.set(m[1], Number(m[2]));
  return { fontMaps, nameToFont, streams: [...objects.values()].map((o) => o.stream).filter((x): x is string => x !== null) };
}

/** How many DIFFERENT glyphs the file uses for each character: a font engine that shapes Arabic uses the initial, medial, final and isolated forms of a letter (several glyphs), a writer that does not uses one. */
export function pdfGlyphVariants(pdf: Buffer): Map<string, number> {
  const { fontMaps } = parsePdf(pdf);
  const out = new Map<string, Set<string>>();
  for (const [fontId, map] of fontMaps) for (const [gid, ch] of map) { if (ch.length === 1) { const set = out.get(ch) ?? new Set<string>(); set.add(`${fontId}:${gid}`); out.set(ch, set); } }
  return new Map([...out].map(([k, v]) => [k, v.size] as const));
}

export function pdfDrawnText(pdf: Buffer): string[] {
  const { fontMaps, nameToFont, streams } = parsePdf(pdf);
  const lines: string[] = [];
  for (const stream of streams) {
    // one `BT ... ET` block is one `doc.text` call: a number the font engine drew in two runs («٨» then «٧») is one string here
    for (const block of stream.matchAll(/BT([\s\S]*?)ET/g)) {
      let current: Map<number, string> | undefined;
      let text = "";
      for (const op of block[1].matchAll(/\/(F\d+) [\d.]+ Tf|\[((?:[^\]]*))\]\s*TJ|<([0-9A-Fa-f]+)>\s*Tj/g)) {
        if (op[1]) { current = fontMaps.get(nameToFont.get(op[1]) ?? -1); continue; }
        if (!current) continue;
        // pdfkit writes a space between words as a wide gap inside the TJ array («<..> -336 <..>»), never as a glyph; a small number is a kerning pair
        const parts: Array<{ hex: string; gap?: undefined } | { gap: number; hex?: undefined }> = op[2] !== undefined ? [...op[2].matchAll(/<([0-9A-Fa-f]+)>|(-?[\d.]+)/g)].map((x) => (x[1] !== undefined ? { hex: x[1] } : { gap: Number(x[2]) })) : [{ hex: op[3] }];
        for (const part of parts) {
          if (part.gap !== undefined) { if (part.gap <= -200) text += " "; continue; }
          const hex = part.hex ?? "";
          for (let i = 0; i + 4 <= hex.length; i += 4) text += current.get(parseInt(hex.slice(i, i + 4), 16)) ?? " ";
        }
      }
      if (text !== "") lines.push(text);
    }
  }
  return lines;
}
