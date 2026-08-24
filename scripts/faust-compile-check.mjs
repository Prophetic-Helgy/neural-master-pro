// Headless Faust compile smoke check: compiles src/dsp/mastering.dsp with the
// same faustwasm compiler the app uses in-browser. Catches .dsp syntax errors
// before the slow browser e2e run. Usage: node scripts/faust-compile-check.mjs
import * as fw from '../node_modules/@grame/faustwasm/dist/esm/index.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const { FaustCompiler, FaustMonoDspGenerator, LibFaust, instantiateFaustModuleFromFile } = fw;

try {
  const faustModule = await instantiateFaustModuleFromFile(
    path.resolve(root, 'node_modules/@grame/faustwasm/libfaust-wasm/libfaust-wasm.js'),
    path.resolve(root, 'node_modules/@grame/faustwasm/libfaust-wasm/libfaust-wasm.data'),
    path.resolve(root, 'node_modules/@grame/faustwasm/libfaust-wasm/libfaust-wasm.wasm')
  );
  const compiler = new FaustCompiler(new LibFaust(faustModule));
  const generator = new FaustMonoDspGenerator();
  const dspCode = fs.readFileSync(path.resolve(root, 'src/dsp/mastering.dsp'), 'utf8');
  const t0 = Date.now();
  await generator.compile(compiler, 'mastering', dspCode, '');
  console.log(`SUCCESS in ${Date.now() - t0} ms`);
} catch (e) {
  console.error('FAIL:', e.message || e);
  process.exit(1);
}
