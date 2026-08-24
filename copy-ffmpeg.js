import fs from 'fs';
import path from 'path';

// Копирует локальное ffmpeg-ядро (для AAC-экспорта) в public/ffmpeg/:
//   @ffmpeg/core@0.12.10   dist/esm/ffmpeg-core.js + ffmpeg-core.wasm (~30.7 MB)
//   @ffmpeg/ffmpeg@0.12.15 dist/esm/worker.js + const.js + errors.js
// Worker — module (type: "module"), импортирует ./const.js и ./errors.js
// относительными путями, поэтому все три файла должны лежать рядом.
// Ядро читается из public/ffmpeg/ на рантайме (браузер: fetch,
// packaged Electron: fs.readFileSync) — никакого CDN, 100% локально.

const coreDir = 'node_modules/@ffmpeg/core/dist/esm';
const glueDir = 'node_modules/@ffmpeg/ffmpeg/dist/esm';
const destDir = 'public/ffmpeg';

const files = [
    [path.join(coreDir, 'ffmpeg-core.js'), 'ffmpeg-core.js'],
    [path.join(coreDir, 'ffmpeg-core.wasm'), 'ffmpeg-core.wasm'],
    [path.join(glueDir, 'worker.js'), 'worker.js'],
    [path.join(glueDir, 'const.js'), 'const.js'],
    [path.join(glueDir, 'errors.js'), 'errors.js'],
];

for (const [srcPath] of files) {
    if (!fs.existsSync(srcPath)) {
        console.error('\n❌ ОШИБКА: Пакет @ffmpeg/core или @ffmpeg/ffmpeg не найден!');
        console.error(`   Ожидался файл: ${srcPath}`);
        console.error('👉 Выполните в терминале команду:\n\n    npm install\n\nа затем снова:\n\n    npm run dev');
        process.exit(1);
    }
}

if (!fs.existsSync(destDir)) {
    fs.mkdirSync(destDir, { recursive: true });
}

for (const [srcPath, name] of files) {
    fs.copyFileSync(srcPath, path.join(destDir, name));
    console.log(`✅ Скопирован: ffmpeg/${name}`);
}

console.log("🎉 FFmpeg-ядро (AAC) скопировано в public/ffmpeg/");
