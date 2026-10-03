import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function modules(target) {
    if (fs.statSync(target).isFile()) return /\.(js|mjs)$/.test(target) ? [target] : [];
    return fs.readdirSync(target, { withFileTypes: true }).flatMap(entry => {
        if (entry.isSymbolicLink() || ['.git', 'node_modules', '.superpowers'].includes(entry.name)) return [];
        return modules(path.join(target, entry.name));
    });
}
if (typeof vm.SourceTextModule !== 'function') {
    throw new Error('Run the module smoke gate with --experimental-vm-modules.');
}
const syntax = modules(path.resolve(process.argv[2] || root)).sort().map(file => {
    try {
        new vm.SourceTextModule(fs.readFileSync(file, 'utf8'), { identifier: file });
        return { file: path.relative(root, file).split(path.sep).join('/'), pass: true };
    } catch (error) {
        return { file: path.relative(root, file).split(path.sep).join('/'), pass: false, error: error.message };
    }
});
process.stdout.write(JSON.stringify(syntax) + '\n');
process.exitCode = syntax.some(row => !row.pass) ? 1 : 0;
