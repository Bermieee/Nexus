import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.argv[2] || '.');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');
const exists = rel => fs.existsSync(path.join(root, rel));
const failures = [];
const requireFile = rel => { if (!exists(rel)) failures.push(`missing ${rel}`); };
const requireMatch = (rel, re, message) => {
    if (!exists(rel)) return failures.push(`missing ${rel}`);
    if (!re.test(read(rel))) failures.push(`${rel}: ${message}`);
};

for (const rel of [
    'postturn/reconstructible-backlog.js',
    'nexus/import-recovery-journal.js',
    'tests/nexus-postturn-reconstructible-backlog-regression.mjs',
    'tests/nexus-backup-import-crash-recovery-regression.mjs',
]) requireFile(rel);

requireMatch('postturn/pipeline.js', /reconstructible-backlog\.js/, 'reconstructible backlog module is not imported');
requireMatch('postturn/pipeline.js', /materializeRecoveredPendingMessageIds/, 'recovered pending turns are not materialized before work planning/drain');
requireMatch('postturn/pipeline.js', /consumePostTurnRange/, 'durable processed fence is not advanced during final backlog consumption');
requireMatch('postturn/pipeline.js', /commitCanonicalNexusMutation/, 'final backlog consumption lost canonical mutation ownership');
requireMatch('postturn/pipeline.js', /type\s*:\s*['"]metadata\.set['"]/, 'final backlog mutation is not metadata.set');

const migrationCandidates = ['migration.js', 'migration/index.js', 'core/migration.js'].filter(exists);
if (!migrationCandidates.length) failures.push('no known migration/import owner found');
for (const rel of migrationCandidates) {
    const src = read(rel);
    if (/import-recovery-journal\.js/.test(src)) {
        if (!/executeCrashSafeImport/.test(src)) failures.push(`${rel}: import recovery module imported but executeCrashSafeImport not used`);
        if (!/stripImportRecoveryJournalFromPayload/.test(src)) failures.push(`${rel}: imported payload can still own recovery key`);
        if (!/preserveImportRecoveryJournal/.test(src)) failures.push(`${rel}: settings replace/merge does not preserve live recovery key`);
    }
}
if (migrationCandidates.length && !migrationCandidates.some(rel => /import-recovery-journal\.js/.test(read(rel)))) {
    failures.push('backup import owner does not import nexus/import-recovery-journal.js');
}

const startupCandidates = ['index.js', 'bootstrap.js'].filter(exists);
if (!startupCandidates.some(rel => /reconcileImportRecovery/.test(read(rel)))) failures.push('startup does not invoke import recovery reconciliation');

const packageFile = path.join(root, 'package.json');
if (fs.existsSync(packageFile)) {
    const pkg = fs.readFileSync(packageFile, 'utf8');
    if (!pkg.includes('nexus-postturn-reconstructible-backlog-regression.mjs')) failures.push('package.json test chain missing Post-turn continuation regression');
    if (!pkg.includes('nexus-backup-import-crash-recovery-regression.mjs')) failures.push('package.json test chain missing import continuation regression');
}

if (failures.length) {
    console.error('Launch continuation merge verification: FAIL');
    for (const failure of failures) console.error(`- ${failure}`);
    process.exitCode = 1;
} else {
    console.log('Launch continuation merge verification: PASS');
}
