/**
 * fetch-whisper-model.mjs — download the bundled Whisper ASR model.
 *
 * Run:  node scripts/fetch-whisper-model.mjs   (or: npm run fetch:models)
 *
 * The model (Xenova/whisper-base, multilingual, int8-quantized ONNX) is NOT
 * in git (public/models/ is .gitignore'd). It IS shipped inside the EXE:
 * run this BEFORE `npm run build:exe` — vite copies public/ → dist/, and
 * electron-builder packages dist/. At runtime the app never touches the
 * network for ASR (env.allowRemoteModels = false).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'public', 'models', 'whisper-base');
const BASE = 'https://huggingface.co/Xenova/whisper-base/resolve/main';

// Exact file list (repo listing 2026-08): tokenizer/preprocessor bits + the
// two quantized ONNX graphs transformers.js loads for Whisper. The MERGED
// decoder (past-keyvalues folded in) is what @huggingface/transformers v4
// requests for `dtype:'q8'` — a missing merged file is a hard load error
// (local_files_only), not a fallback to the split pair, so it is required.
// It also replaces decoder_model(+with_past) at ~54 MB vs ~99 MB for the
// split pair, so we ship only the merged graph.
const FILES = [
  'config.json',
  'generation_config.json',
  'preprocessor_config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'vocab.json',
  'merges.txt',
  'normalizer.json',
  'added_tokens.json',
  'special_tokens_map.json',
  'onnx/encoder_model_quantized.onnx',
  'onnx/decoder_model_merged_quantized.onnx',
];

async function fetchOne(rel) {
  const dest = path.join(OUT, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (fs.existsSync(dest) && fs.statSync(dest).size > 100) {
    console.log(`  skip (cached): ${rel}`);
    return;
  }
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      process.stdout.write(`  get: ${rel} (attempt ${attempt}) ... `);
      const res = await fetch(`${BASE}/${rel}`, { redirect: 'follow' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 100) throw new Error(`suspiciously small: ${buf.length} B`);
      fs.writeFileSync(dest, buf);
      console.log(`${(buf.length / 1024 / 1024).toFixed(2)} MB`);
      return;
    } catch (e) {
      console.log(`FAILED (${e.message})`);
      if (attempt === 3) throw new Error(`download failed: ${rel}: ${e.message}`);
    }
  }
}

console.log(`Whisper model → ${OUT}`);
for (const f of FILES) await fetchOne(f);
const total = FILES.reduce((s, f) => s + fs.statSync(path.join(OUT, f)).size, 0);
console.log(`DONE: ${FILES.length} files, ${(total / 1024 / 1024).toFixed(1)} MB total`);
