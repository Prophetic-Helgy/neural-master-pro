/**
 * flicker-file-analyze.cjs — offline frame profile of an exported clip.
 * Reads frames via ffmpeg (fps=10, scale=24:14 to match the e2e top-left
 * sample), classifies against the M4.5b palette and prints a timeline:
 * K = black, R/G/B/Y = palette slot, ? = other color.
 * Usage: node scripts/flicker-file-analyze.cjs <file>
 */
const { spawn } = require('child_process');
const PALETTE = [[235, 40, 50], [235, 235, 235], [60, 90, 240], [40, 210, 110]];
const lum = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

const file = process.argv[2];
if (!file) { console.error('usage: node scripts/flicker-file-analyze.cjs <file>'); process.exit(2); }
const ff = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', file,
  '-vf', 'crop=iw*0.45:ih*0.45:0:0,scale=24:14', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
let buf = Buffer.alloc(0), frames = [], n = 0;
ff.stdout.on('data', (d) => {
  buf = Buffer.concat([buf, d]);
  while (buf.length >= 1008) {
    const px = buf.subarray(0, 1008); buf = buf.subarray(1008);
    let r = 0, g = 0, b = 0;
    for (let i = 0; i < 1008; i += 3) { r += px[i]; g += px[i + 1]; b += px[i + 2]; }
    const cnt = 336; r /= cnt; g /= cnt; b /= cnt;
    let best = 0, bd = 1e9;
    for (let i = 0; i < 4; i++) {
      const d2 = (PALETTE[i][0] - r) ** 2 + (PALETTE[i][1] - g) ** 2 + (PALETTE[i][2] - b) ** 2;
      if (d2 < bd) { bd = d2; best = i; }
    }
    const L = lum(r, g, b);
    frames.push({ t: +(n / 10).toFixed(2), L: Math.round(L), c: L < 30 ? -2 : (bd < 900 ? best : -1) });
    n += 1;
  }
});
ff.on('close', () => {
  const line = frames.map((f) => (f.c === -2 ? 'K' : f.c === -1 ? '?' : 'RGBY'[f.c])).join('');
  console.log('frames=' + frames.length + ' dur~' + (frames.length / 10).toFixed(1) + 's');
  for (let i = 0; i < line.length; i += 80) {
    console.log((i / 10).toFixed(1) + 's: ' + line.slice(i, i + 80));
  }
});
