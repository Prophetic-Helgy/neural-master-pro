#!/usr/bin/env node
/**
 * check-i18n-parity.cjs — key parity + translation completeness for i18n.ts.
 *
 * Run: node scripts/check-i18n-parity.cjs
 *
 * Checks, per language (9 langs, EN is the source of truth):
 *   1. key set identical to EN (missing/extra)         -> hard fail
 *   2. no empty values                                 -> hard fail
 *   3. value identical to EN (len > 3) and not in TERMS
 *      -> "untranslated" report; non-empty list = fail.
 *
 * TERMS whitelists keys whose EN value is a brand or an established
 * audio/industry term that stays in English in every locale (added with
 * a one-line reason). Everything else must be a real translation.
 */
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'src', 'lib', 'i18n.ts');
const LANGS = ['en', 'ru', 'zh', 'it', 'fr', 'es', 'ja', 'ko', 'ar'];

// Brand names + established terms (kept in English in all locales).
const TERMS = new Set([
  'title',          // Neural Master Pro — product name
  'cpu', 'fps', 'bpm', 'lufs', 'rms', 'lra',           // metric abbreviations
  'truePeak',       // True Peak (dBTP) — standard term
  'dcOffset',       // DC Offset — signal term
  'presetSpotify', 'presetYouTube', 'presetTikTok', 'presetApple',  // brands
  'pexelsBg', 'searchPexels',  // Pexels — brand
  'modeLite', 'modePro',       // product mode names
  'stemMaster', 'stemBass', 'stemMid', 'stemSide',     // all-caps stem labels
  'haas',           // Haas effect — named after its inventor
  'autotune', 'chorus', 'delay', 'deess', 'reverb', 'phaser',  // established FX names (invented/brand words, kept in EN in localized audio UIs)
  'visCircle',      // Glitch — genre name
  'crest',          // Crest (factor) — standard audio term
  'peqGain',        // Gain — standard audio term
  'peqFreq',        // Freq — abbreviation, universal
  'srHold',         // SR Hold — DSP term (sample-rate hold)
  'flanger',        // Flanger — FX name (invented word, no native equivalent)
  'crush',          // Bitcrusher — established lo-fi term
  'stageDcEq',      // "DC & EQ…" — abbreviations only
  'llmBaseUrl',     // Base URL — API term
  'llmApiKey',      // API Key — API term
  'llmModel',       // Model — LLM API term
  'peqPeak', 'peqLowShelf', 'peqHighShelf',  // PEQ filter-type names — established terms, EN in every locale
  'gate', 'trans', 'air', 'widener',         // DSP module names — industry-standard EN labels (class of "Parametric EQ")
  'mono',         // Mono — standard Latin label in audio UIs
  'bit16', 'bit24', // 16/24-bit — universal bit-depth designations
]);

// Cognates / established loanwords, per language: the EN value IS the
// correct local word here (e.g. Italian "Volume", French "Format").
const PER_LANG_TERMS = {
  it: new Set(['volume', 'master', 'presetClub', 'presetRadio', 'presetPodcast',
    'profileStreaming', 'stageLoudness', 'tremolo', 'videoAuthor', 'mono',
    'bitrate',    // "bitrate" — italian word
    'batchStop']),// "Stop" — italian word
  fr: new Set(['format', 'monitoring', 'volume', 'master', 'presetClub', 'presetRadio',
    'presetPodcast', 'batchStop', 'peqType', 'mono', 'tremolo', 'source',
    'original', 'orientation', 'vertical', 'horizontal', 'profileStreaming',
    'stageTexture', 'stageLoudness']),
  es: new Set(['master', 'natural', 'presets', 'fundamental', 'format', 'original',
    'vertical', 'horizontal', 'presetClub', 'presetRadio', 'presetPodcast',
    'profileStreaming', 'stageLoudness', 'tremolo', 'mono', 'batchStop']),
};

const text = fs.readFileSync(FILE, 'utf8');

/** Extract the object body of a top-level language block by brace counting. */
function extractBlock(lang) {
  const head = new RegExp(`^\\s{2}${lang}:\\s*\\{`, 'm').exec(text);
  if (!head) return null;
  let i = head.index + head[0].length; // at the opening '{'
  let depth = 1;
  while (i < text.length && depth > 0) {
    const c = text[i];
    if (c === '{') depth += 1;
    else if (c === '}') depth -= 1;
    i += 1;
  }
  return text.slice(head.index + head[0].length, i - 1);
}

/** Parse `key: "value",` pairs (single-line values, both quote styles). */
function parsePairs(block) {
  const out = {};
  const re = /^[ \t]+([A-Za-z0-9_]+):\s*(["'])((?:\\.|(?!\2)[^\\])*)\2[ \t]*,?/gm;
  let m;
  while ((m = re.exec(block)) !== null) {
    const raw = m[3];
    const unesc = m[2] === '"'
      ? JSON.parse(`"${raw}"`)
      : raw.replace(/\\'/g, "'").replace(/\\\\/g, '\\');
    out[m[1]] = unesc;
  }
  return out;
}

const tables = {};
for (const l of LANGS) tables[l] = parsePairs(extractBlock(l));

let hardFail = 0;
const en = tables.en;
const enKeys = Object.keys(en);
console.log(`EN keys: ${enKeys.length}`);
if (enKeys.length < 200) {
  console.error('FATAL: EN block parsed too few keys — parser is broken, not the i18n file');
  process.exit(2);
}

const untranslated = {};
for (const l of LANGS) {
  if (l === 'en') continue;
  const t = tables[l];
  const keys = Object.keys(t);
  const missing = enKeys.filter((k) => !(k in t));
  const extra = keys.filter((k) => !(k in en));
  const empty = keys.filter((k) => t[k].trim() === '');
  if (missing.length || extra.length || empty.length) {
    hardFail += 1;
    console.log(`\n[${l}] HARD: missing=${JSON.stringify(missing)} extra=${JSON.stringify(extra)} empty=${JSON.stringify(empty)}`);
  }
  // value identical to EN (len > 3) and not an established term
  const localTerms = PER_LANG_TERMS[l] || new Set();
  const flags = keys.filter((k) =>
    en[k] !== undefined && t[k] === en[k] && en[k].length > 3
    && !TERMS.has(k) && !localTerms.has(k));
  if (flags.length) untranslated[l] = flags;
}

let totalFlags = 0;
for (const l of LANGS) {
  if (!untranslated[l]) continue;
  totalFlags += untranslated[l].length;
  console.log(`\n[${l}] ${untranslated[l].length} values identical to EN:`);
  for (const k of untranslated[l]) console.log(`  ${k} = "${en[k]}"`);
}

console.log(`\n${'='.repeat(60)}`);
if (hardFail) {
  console.log(`RESULT: FAIL — key parity/empty violations in ${hardFail} language(s)`);
  process.exit(1);
}
if (totalFlags) {
  console.log(`RESULT: FAIL — ${totalFlags} untranslated values (translate them or add to TERMS with a reason)`);
  process.exit(1);
}
console.log('RESULT: PASS — key parity OK, no empty values, no untranslated values');
