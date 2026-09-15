import { assertEquals } from './assert.ts';
import {
  renderSummaryDocx,
  renderSummaryPdf,
  SUMMARY_DOCUMENT_TYPES,
  summaryDocumentFileName,
  wrapText,
} from '../_shared/summary-document.ts';
import { safeTimeZone, summaryCoversLabel } from '../newone-read/handler.ts';
import { PDFDocument, StandardFonts } from 'pdf-lib';

const document = {
  title: 'Summary and chat interface improvements',
  covers: 'Sep 14, 2026 · 2:49 PM – 3:44 PM',
  participants: ['Kyle LEE', 'Woojin Lee'],
  lines: [
    '1. Kyle: drag-and-drop for screenshots instead of the attach button',
    '2. Kyle: unread badge and typing indicator improvements requested',
    '3. Woojin: test accounts need an email address until the store release',
    '4. ' + 'A very long line that has to wrap onto the next line because it keeps going and going well past the width of a Letter page with these margins.',
  ],
  conversationTitle: 'Kyle LEE',
  labels: { participants: 'Participants', generated: 'Summary written by AI in Gist' },
};

Deno.test('the PDF is a real PDF with the title as its document title', async () => {
  const bytes = await renderSummaryPdf(document, { regular: null, bold: null });
  assertEquals(new TextDecoder().decode(bytes.slice(0, 5)), '%PDF-');
  const parsed = await PDFDocument.load(bytes);
  assertEquals(parsed.getTitle(), 'Summary and chat interface improvements');
  assertEquals(parsed.getPageCount(), 1);
});

Deno.test('many lines run onto a second page instead of off the bottom', async () => {
  const long = { ...document, lines: Array.from({ length: 80 }, (_, index) => `${index + 1}. Kyle: point number ${index + 1} of a long meeting`) };
  const parsed = await PDFDocument.load(await renderSummaryPdf(long, { regular: null, bold: null }));
  assertEquals(parsed.getPageCount() >= 2, true);
});

Deno.test('text wraps at the page width, and a run without spaces breaks by character', async () => {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const lines = wrapText('one two three four five six seven eight nine ten eleven twelve', font, 12, 120);
  assertEquals(lines.length > 1, true);
  assertEquals(lines.every((line) => font.widthOfTextAtSize(line, 12) <= 120), true);
  const run = wrapText('abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz', font, 12, 60);
  assertEquals(run.length > 1, true);
  assertEquals(run.join(''), 'abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz');
  assertEquals(wrapText('', font, 12, 100), ['']);
});

Deno.test('the Word file is a zip package whose type is the docx media type', async () => {
  const bytes = await renderSummaryDocx(document);
  assertEquals(bytes[0], 0x50);
  assertEquals(bytes[1], 0x4b);
  assertEquals(SUMMARY_DOCUMENT_TYPES.docx.contentType, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
});

Deno.test('file names are dated and safe for headers and file systems', () => {
  assertEquals(
    summaryDocumentFileName('Kyle: "plans" <draft>', new Date('2026-09-14T22:41:00Z'), 'pdf'),
    'Gist summary - Kyle plans draft - 2026-09-14.pdf',
  );
  assertEquals(summaryDocumentFileName('   ', new Date('2026-09-14T22:41:00Z'), 'docx'), 'Gist summary - Conversation - 2026-09-14.docx');
});

Deno.test('the covered span reads as one date with both hours, or two dated ends, in the reader\'s zone', () => {
  const from = new Date('2026-09-14T21:49:00Z');
  const until = new Date('2026-09-14T22:44:00Z');
  assertEquals(summaryCoversLabel(from, until, 'en', 'America/Los_Angeles'), 'Sep 14, 2026 · 2:49 PM – 3:44 PM');
  assertEquals(summaryCoversLabel(new Date('2026-09-10T16:05:00Z'), until, 'en', 'America/Los_Angeles'), 'Sep 10, 2026 9:05 AM – Sep 14, 2026 3:44 PM');
  assertEquals(summaryCoversLabel(from, until, 'ko', 'Asia/Seoul')?.includes('2026'), true);
  assertEquals(summaryCoversLabel(null, until, 'en', 'UTC'), null);
  assertEquals(safeTimeZone('America/Los_Angeles'), 'America/Los_Angeles');
  assertEquals(safeTimeZone('Mars/Olympus'), 'UTC');
  assertEquals(safeTimeZone(42), 'UTC');
  assertEquals(safeTimeZone('a'.repeat(80)), 'UTC');
});
