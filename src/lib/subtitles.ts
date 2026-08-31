/**
 * subtitles.ts — karaoke/subtitle line math (pure, unit-tested in t28).
 *
 * Segments are seconds relative to the EXPORT REGION start (0 = region
 * start) — the same clock seam the Pexels cue math uses (bgGetTime).
 */

export interface WordSpan {
  text: string;
  start: number;
  end: number;
}

export interface SubtitleSegment {
  start: number;
  end: number;
  text: string;
  /** Whisper word timestamps when available (karaoke highlight); absent
   *  → wordSpans() interpolates proportionally to word character length. */
  words?: WordSpan[];
}

/** SRT time: HH:MM:SS,mmm */
export function srtTime(sec: number): string {
  const ms = Math.max(0, Math.round(sec * 1000));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const mm = ms % 1000;
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(h)}:${p(m)}:${p(s)},${p(mm, 3)}`;
}

export function segmentsToSrt(segs: SubtitleSegment[]): string {
  return segs
    .map((s, i) => `${i + 1}\n${srtTime(s.start)} --> ${srtTime(s.end)}\n${wrapLine(s.text).join('\n')}`)
    .join('\n\n') + '\n';
}

/** The segment covering t (inclusive), or null. */
export function pickActiveSegment(segs: SubtitleSegment[], t: number): SubtitleSegment | null {
  for (const s of segs) {
    if (t >= s.start && t <= s.end) return s;
  }
  return null;
}

/**
 * Word spans for karaoke highlighting: real Whisper word timestamps when
 * present; otherwise deterministic interpolation across the segment window,
 * each word's share proportional to its character length (spaces excluded).
 */
export function wordSpans(seg: SubtitleSegment): WordSpan[] {
  if (seg.words && seg.words.length > 0) return seg.words;
  const toks = seg.text.split(/\s+/).filter(Boolean);
  if (toks.length === 0) return [];
  const totalChars = toks.reduce((s, w) => s + w.length, 0) || 1;
  const dur = Math.max(0, seg.end - seg.start);
  const out: WordSpan[] = [];
  let acc = 0;
  for (const w of toks) {
    const start = seg.start + dur * (acc / totalChars);
    acc += w.length;
    const end = seg.start + dur * (acc / totalChars);
    out.push({ text: w, start, end });
  }
  return out;
}

/** Word index active at t (-1 when none), or -1 if t outside the segment. */
export function activeWordIndex(seg: SubtitleSegment, t: number): number {
  const spans = wordSpans(seg);
  for (let i = 0; i < spans.length; i += 1) {
    if (t >= spans[i].start && t < spans[i].end) return i;
  }
  // boundary tolerance: the very last word stays lit at the segment end
  if (spans.length && t >= spans[spans.length - 1].end - 0.001 && t <= seg.end + 0.001) return spans.length - 1;
  return -1;
}

/**
 * Wrap a line for burn-in/SRT: at most `maxChars` per line, up to 2 lines.
 * A third overflow line is dropped (better than running off the frame).
 */
export function wrapLine(text: string, maxChars = 42): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    if (!cur.length) cur = w;
    else if ((cur + ' ' + w).length <= maxChars) cur += ' ' + w;
    else { lines.push(cur); cur = w; }
  }
  if (cur.length) lines.push(cur);
  if (lines.length > 2) {
    // Merge the tail into line 2 — truncation keeps the last word short.
    const tail = lines.slice(1).join(' ');
    lines.length = 0;
    lines.push(...wrapTwo(tail, maxChars));
  }
  return lines.slice(0, 2);
}

function wrapTwo(text: string, maxChars: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines = ['', ''];
  let li = 0;
  for (const w of words) {
    if (!lines[li].length) lines[li] = w;
    else if ((lines[li] + ' ' + w).length <= maxChars) lines[li] += ' ' + w;
    else if (li === 0) { li = 1; lines[li] = w; }
    // second line overflow: append anyway (single long word, rare)
    else lines[li] += ' ' + w;
  }
  return lines.filter(Boolean);
}

/**
 * Group Whisper word chunks into readable segments: break on a pause
 * (gap > 0.9 s) or once the accumulated text passes ~42 chars.
 */
export function groupWordsIntoSegments(
  words: Array<{ text: string; start: number | null; end: number | null }>,
): SubtitleSegment[] {
  const segs: SubtitleSegment[] = [];
  let cur: WordSpan[] = [];
  const flush = () => {
    if (!cur.length) return;
    segs.push({
      start: cur[0].start,
      end: cur[cur.length - 1].end,
      text: cur.map((w) => w.text).join(' ').trim(),
      words: cur.slice(),
    });
    cur = [];
  };
  for (const w of words) {
    if (w.start == null || w.end == null) continue;
    const span: WordSpan = { text: (w.text || '').trim(), start: w.start, end: w.end };
    if (!span.text) continue;
    const prev = cur[cur.length - 1];
    const gap = prev ? span.start - prev.end : 0;
    const len = cur.reduce((s, x) => s + x.text.length + 1, 0);
    if (cur.length && (gap > 0.9 || len + span.text.length > 42)) flush();
    cur.push(span);
  }
  flush();
  return segs;
}
