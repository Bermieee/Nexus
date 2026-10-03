import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function check(target) {
    return spawnSync(process.execPath, ['--experimental-vm-modules', path.join(root, 'tools/check-es-modules.mjs'), target], { encoding: 'utf8' });
}
test('the Memory entry module is valid browser ES module syntax', () => {
    const result = check(path.join(root, 'memory/store.js'));
    assert.equal(result.status, 0, result.stdout + result.stderr);
});
test('the smoke gate rejects invalid ES module syntax regardless of filename detection', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-module-smoke-'));
    try {
        const file = path.join(directory, 'invalid.js');
        fs.writeFileSync(file, 'export function broken(){try {return 1;}} catch(error) {}');
        const result = check(file);
        assert.equal(result.status, 1);
        assert.equal(JSON.parse(result.stdout)[0].pass, false);
        fs.writeFileSync(file, 'export function valid(){try {return 1;} catch(error) {return 0;}}');
        assert.equal(check(file).status, 0);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
