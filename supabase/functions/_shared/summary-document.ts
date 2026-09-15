// A conversation summary as a file people can keep: a PDF (the default) or a
// Word document, rendered here so the phone and the browser hand out the same
// page. The browser used to open its print dialog for "PDF" and printed the
// whole app window; the owner's father wanted a file in his downloads
// folder (Sep 14 2026).
import fontkit from '@pdf-lib/fontkit';
import { PDFDocument, PDFFont, PDFPage, rgb, StandardFonts } from 'pdf-lib';
import { AlignmentType, Document, HeadingLevel, Packer, Paragraph, TextRun } from 'docx';

import { ApiError } from './errors.ts';

export interface SummaryDocumentInput {
  /** The AI's title, already clean of source tokens. */
  title: string;
  /** "Sep 14, 2026 · 2:49 PM – 3:44 PM", in the reader's language. */
  covers: string | null;
  /** "Kyle LEE, Woojin Lee" -- names only; the label is added here. */
  participants: string[];
  /** The numbered lines, one per entry, already clean. */
  lines: string[];
  /** The chat's name, shown small under the title. */
  conversationTitle: string;
  labels: { participants: string; generated: string };
}

export interface SummaryFonts {
  /** OpenType bytes; null falls back to the PDF standard fonts (Latin only). */
  regular: Uint8Array | null;
  bold: Uint8Array | null;
}

// Noto Sans KR carries Hangul, Latin (Spanish included) and the punctuation
// people type; the subset build is the Korean-scoped one, ~4.6 MB a face.
const FONT_URLS = {
  regular: 'https://github.com/notofonts/noto-cjk/raw/main/Sans/SubsetOTF/KR/NotoSansKR-Regular.otf',
  bold: 'https://github.com/notofonts/noto-cjk/raw/main/Sans/SubsetOTF/KR/NotoSansKR-Bold.otf',
};
const FONT_MAX_BYTES = 12_000_000;

let fontCache: Promise<SummaryFonts> | null = null;

/** Fetched once per isolate and kept; a failed fetch is retried on the next call. */
export function loadSummaryFonts(fetcher: typeof fetch = fetch): Promise<SummaryFonts> {
  if (!fontCache) {
    fontCache = (async () => {
      const load = async (url: string) => {
        const response = await fetcher(url, { redirect: 'follow' });
        if (!response.ok) throw new ApiError(503, 'dependency_unavailable', 'summary_font_unavailable', 30);
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.byteLength === 0 || bytes.byteLength > FONT_MAX_BYTES) {
          throw new ApiError(503, 'dependency_unavailable', 'summary_font_unavailable', 30);
        }
        return bytes;
      };
      const [regular, bold] = await Promise.all([load(FONT_URLS.regular), load(FONT_URLS.bold)]);
      return { regular, bold };
    })().catch((error) => {
      fontCache = null;
      throw error;
    });
  }
  return fontCache;
}

const PAGE = { width: 612, height: 792, margin: 56 };
const INK = rgb(0.07, 0.09, 0.09);
const MUTED = rgb(0.36, 0.39, 0.39);
const RULE = rgb(0.85, 0.87, 0.87);

interface Pen {
  document: PDFDocument;
  page: PDFPage;
  y: number;
  regular: PDFFont;
  bold: PDFFont;
}

/** Splits `text` into lines no wider than `width`; a word wider than the line breaks by character (Korean has no spaces to break at). */
export function wrapText(text: string, font: PDFFont, size: number, width: number): string[] {
  const lines: string[] = [];
  const measure = (value: string) => font.widthOfTextAtSize(value, size);
  for (const paragraph of text.split('\n')) {
    let line = '';
    for (const word of paragraph.split(/(?<=\s)/)) {
      if (measure(line + word) <= width || line === '') {
        if (measure(word) > width) {
          // Character by character for a run that never fits on its own.
          let run = line;
          for (const character of Array.from(word)) {
            if (measure(run + character) > width && run !== '') {
              lines.push(run.trimEnd());
              run = '';
            }
            run += character;
          }
          line = run;
        } else {
          line += word;
        }
      } else {
        lines.push(line.trimEnd());
        line = word;
      }
    }
    lines.push(line.trimEnd());
  }
  return lines.length ? lines : [''];
}

function newPage(pen: Pen) {
  pen.page = pen.document.addPage([PAGE.width, PAGE.height]);
  pen.y = PAGE.height - PAGE.margin;
}

function ensureRoom(pen: Pen, height: number) {
  if (pen.y - height < PAGE.margin) newPage(pen);
}

function drawParagraph(
  pen: Pen,
  text: string,
  options: { font: PDFFont; size: number; color?: ReturnType<typeof rgb>; indent?: number; hanging?: string; gapAfter?: number },
) {
  const lineHeight = options.size * 1.45;
  const indent = options.indent ?? 0;
  const width = PAGE.width - PAGE.margin * 2 - indent;
  const lines = wrapText(text, options.font, options.size, width);
  ensureRoom(pen, lineHeight);
  if (options.hanging) {
    pen.page.drawText(options.hanging, {
      x: PAGE.margin,
      y: pen.y - options.size,
      size: options.size,
      font: options.font,
      color: options.color ?? INK,
    });
  }
  for (const line of lines) {
    ensureRoom(pen, lineHeight);
    pen.page.drawText(line, {
      x: PAGE.margin + indent,
      y: pen.y - options.size,
      size: options.size,
      font: options.font,
      color: options.color ?? INK,
    });
    pen.y -= lineHeight;
  }
  pen.y -= options.gapAfter ?? 0;
}

const NUMBERED = /^(\d{1,3})[.)]\s+(.*)$/s;

/** The page: title, chat name, the days and hours covered, who took part, then the numbered lines with a hanging number column. */
export async function renderSummaryPdf(input: SummaryDocumentInput, fonts: SummaryFonts): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  document.setTitle(input.title);
  document.setProducer('Gist');
  document.setCreator('Gist');
  let regular: PDFFont;
  let bold: PDFFont;
  if (fonts.regular && fonts.bold) {
    document.registerFontkit(fontkit);
    [regular, bold] = await Promise.all([
      document.embedFont(fonts.regular, { subset: true }),
      document.embedFont(fonts.bold, { subset: true }),
    ]);
  } else {
    [regular, bold] = await Promise.all([
      document.embedFont(StandardFonts.Helvetica),
      document.embedFont(StandardFonts.HelveticaBold),
    ]);
  }
  const pen: Pen = { document, page: document.addPage([PAGE.width, PAGE.height]), y: PAGE.height - PAGE.margin, regular, bold };

  drawParagraph(pen, input.title, { font: bold, size: 20, gapAfter: 4 });
  if (input.conversationTitle.trim()) {
    drawParagraph(pen, input.conversationTitle.trim(), { font: regular, size: 11, color: MUTED });
  }
  if (input.covers) drawParagraph(pen, input.covers, { font: regular, size: 11, color: MUTED });
  if (input.participants.length) {
    drawParagraph(pen, `${input.labels.participants}: ${input.participants.join(', ')}`, { font: regular, size: 11, color: MUTED });
  }
  pen.y -= 6;
  ensureRoom(pen, 14);
  pen.page.drawLine({
    start: { x: PAGE.margin, y: pen.y },
    end: { x: PAGE.width - PAGE.margin, y: pen.y },
    thickness: 0.75,
    color: RULE,
  });
  pen.y -= 16;

  for (const line of input.lines) {
    const numbered = NUMBERED.exec(line);
    if (numbered) {
      drawParagraph(pen, numbered[2] ?? '', { font: regular, size: 12, indent: 26, hanging: `${numbered[1]}.`, gapAfter: 4 });
    } else {
      drawParagraph(pen, line, { font: regular, size: 12, gapAfter: 4 });
    }
  }

  pen.y -= 10;
  ensureRoom(pen, 12);
  pen.page.drawText(input.labels.generated, {
    x: PAGE.margin,
    y: pen.y - 9,
    size: 9,
    font: regular,
    color: MUTED,
  });
  return document.save();
}

/** The same page as a Word document; Word picks a Korean-capable face for Hangul on its own. */
export async function renderSummaryDocx(input: SummaryDocumentInput): Promise<Uint8Array> {
  const muted = { color: '5C6363', size: 20 };
  const meta = (text: string) => new Paragraph({ children: [new TextRun({ text, ...muted })], spacing: { after: 40 } });
  const children: Paragraph[] = [
    new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun({ text: input.title, bold: true, size: 40, color: '121717' })], spacing: { after: 80 } }),
  ];
  if (input.conversationTitle.trim()) children.push(meta(input.conversationTitle.trim()));
  if (input.covers) children.push(meta(input.covers));
  if (input.participants.length) children.push(meta(`${input.labels.participants}: ${input.participants.join(', ')}`));
  children.push(new Paragraph({ children: [], spacing: { after: 160 }, border: { bottom: { color: 'D9DEDE', space: 1, style: 'single', size: 6 } } }));
  for (const line of input.lines) {
    const numbered = NUMBERED.exec(line);
    children.push(new Paragraph({
      children: [new TextRun({ text: numbered ? `${numbered[1]}.  ${numbered[2] ?? ''}` : line, size: 24, color: '121717' })],
      spacing: { after: 100 },
      indent: numbered ? { left: 520, hanging: 520 } : undefined,
    }));
  }
  children.push(new Paragraph({ children: [new TextRun({ text: input.labels.generated, color: '5C6363', size: 18 })], spacing: { before: 240 }, alignment: AlignmentType.LEFT }));
  const document = new Document({
    creator: 'Gist',
    title: input.title,
    styles: { default: { document: { run: { font: 'Calibri' } } } },
    sections: [{ children }],
  });
  return new Uint8Array(await Packer.toBuffer(document));
}

export const SUMMARY_DOCUMENT_TYPES = {
  pdf: { contentType: 'application/pdf', extension: 'pdf' },
  docx: { contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', extension: 'docx' },
} as const;

export type SummaryDocumentFormat = keyof typeof SUMMARY_DOCUMENT_TYPES;

/** "Gist summary – Weekend plans – 2026-09-05.pdf", safe for every file system and HTTP header. */
export function summaryDocumentFileName(conversationTitle: string, date: Date, format: SummaryDocumentFormat): string {
  const safeTitle = conversationTitle
    .replace(/[\\/:*?"<>| -]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60)
    .trim() || 'Conversation';
  const day = date.toISOString().slice(0, 10);
  return `Gist summary - ${safeTitle} - ${day}.${SUMMARY_DOCUMENT_TYPES[format].extension}`;
}
