import fs from 'fs';
import path from 'path';

const possiblePaths = [
    'node_modules/@grame/faustwasm/libfaust-wasm',
    'node_modules/@grame/faustwasm'
];

let srcDir = null;
for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
        // verify it contains the actual WASM file
        const files = fs.readdirSync(p);
        if (files.includes('libfaust-wasm.wasm') || files.includes('libfaust-wasm.data')) {
            srcDir = p;
            break;
        }
    }
}

if (!srcDir) {
    console.error('\n❌ ОШИБКА: Пакет @grame/faustwasm не найден или пуст!');
    console.error('👉 Скорее всего, вы скачали новый ZIP-архив и забыли установить зависимости.');
    console.error('👉 Выполните в терминале команду:\n\n    npm install\n\nа затем снова:\n\n    npm run build:exe\n');
    process.exit(1);
}

const destDir = 'public/faust';

if (!fs.existsSync(destDir)) {
    fs.mkdirSync(destDir, { recursive: true });
}

console.log("🔍 Ищем файлы Faust в:", srcDir);

fs.readdirSync(srcDir).forEach(file => {
    const srcPath = path.join(srcDir, file);
    const destPath = path.join(destDir, file);

    // Копируем только нужные файлы Faust
    if (file.includes('libfaust-wasm') || 
        file.endsWith('.wasm') || 
        file.endsWith('.data') || 
        file.endsWith('.js')) {
        
        if (fs.statSync(srcPath).isFile()) {
            fs.copyFileSync(srcPath, destPath);
            console.log(`✅ Скопирован: ${file}`);
        }
    }
});

console.log("🎉 Faust файлы успешно скопированы в public/faust/");
