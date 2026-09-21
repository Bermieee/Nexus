import { getWorldLoadPreset } from './world-load-presets.js';

const GIVEN = ['Aren','Bela','Caro','Dema','Eris','Fenn','Galen','Hale','Ilya','Joren','Kessa','Lio','Mara','Neris','Orin','Pella','Quin','Rhea','Soren','Tala','Una','Varek','Wren','Xara','Yoren','Zella'];
const FAMILY = ['Vale','Marrow','Kest','Rowan','Dain','Hearth','Vey','Corren','Sable','Nox','Tarin','Briar','Mere','Ash','Dorne','Voss','Rill','Kade','Thorn','Morn'];
const PLACE = ['Harbor','March','Spire','Crossing','Reach','Hollow','Ward','Basin','Gate','Cairn','Field','Watch','Quay','Ridge','Vault','Fen','Road','Keep'];
const ADJ = ['North','Ashen','Silver','Old','Low','High','Red','Grey','Outer','Inner','West','East','Quiet','Broken','Crownless','Lantern'];
const ROLES = ['cartographer','warden','healer','factor','scout','scribe','engineer','guide','captain','broker','smith','archivist'];
const FACTION = ['Company','Concord','Guild','Wardens','Archive','Compact','League','House','Circle','Assembly'];
const OBJECT = ['Compass','Ledger','Seal','Knife','Key','Lens','Map','Token','Bell','Lantern','Spear','Charm','Plate','Rod'];
const SYSTEM = ['Transit Law','Signal Code','Ward Protocol','Trade Rule','Survey Standard','Beacon Cycle','Archive Index','Watch Rotation'];

function mulberry32(seed) {
    return function() {
        let t = seed += 0x6D2B79F5;
        t = Math.imul(t ^ t >>> 15, t | 1);
        t ^= t + Math.imul(t ^ t >>> 7, t | 61);
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
}

function pick(list, rng) { return list[Math.floor(rng() * list.length) % list.length]; }
function pad(n, width = 4) { return String(n).padStart(width, '0'); }
function sentenceRepeat(sentence, count) { return Array.from({ length: count }, (_, i) => `${sentence} Detail ${i + 1} preserves chronology and source identity.`).join(' '); }

function characterName(i, rng) {
    return `${GIVEN[i % GIVEN.length]} ${FAMILY[(i * 7 + Math.floor(rng() * FAMILY.length)) % FAMILY.length]}`;
}

function buildEntities(preset, rng) {
    const chars = Array.from({ length: preset.entityPlan.characters }, (_, i) => ({ id: `char-${pad(i + 1)}`, name: characterName(i, rng) }));
    const locations = Array.from({ length: preset.entityPlan.locations }, (_, i) => ({ id: `loc-${pad(i + 1)}`, name: `${ADJ[i % ADJ.length]} ${PLACE[(i * 5 + 3) % PLACE.length]} ${i + 1}` }));
    const factions = Array.from({ length: preset.entityPlan.factions }, (_, i) => ({ id: `fac-${pad(i + 1)}`, name: `${ADJ[(i + 4) % ADJ.length]} ${FACTION[i % FACTION.length]} ${i + 1}` }));
    const objects = Array.from({ length: preset.entityPlan.objects }, (_, i) => ({ id: `obj-${pad(i + 1)}`, name: `${pick(OBJECT, rng)} ${pad(i + 1, 3)}` }));
    const systems = Array.from({ length: preset.entityPlan.systems }, (_, i) => ({ id: `sys-${pad(i + 1)}`, name: `${pick(SYSTEM, rng)} ${pad(i + 1, 2)}` }));
    return { chars, locations, factions, objects, systems };
}

function entry(logicalId, title, keys, content, domain, representedIds = [], extra = {}) {
    return { logicalId, title, keys, content, domain, representedIds, ...extra };
}

function paragraphsFor(preset, index) {
    if (preset.content.tinyEntryEvery && index % preset.content.tinyEntryEvery === 0) return 1;
    if (preset.content.longEntryEvery && index % preset.content.longEntryEvery === 0) return preset.content.baseParagraphs + 7;
    return preset.content.baseParagraphs;
}

function keysFor(preset, index, primary, alias) {
    if (preset.content.missingKeywordsEvery && index % preset.content.missingKeywordsEvery === 0) return [];
    const keys = [primary];
    if (alias && preset.content.aliasEvery && index % preset.content.aliasEvery === 0) keys.push(alias);
    return keys;
}

function makeCanonicalEntries(preset, entities, rng) {
    const rows = [];
    let idx = 1;
    for (const [i, c] of entities.chars.entries()) {
        const role = ROLES[i % ROLES.length];
        const loc = entities.locations[i % entities.locations.length];
        const faction = entities.factions[i % entities.factions.length];
        const object = entities.objects[i % entities.objects.length];
        const alias = c.name.split(' ')[0];
        rows.push(entry(`character.${c.id}.identity`, `${c.name} - Identity & Role`, keysFor(preset, idx, c.name, alias), sentenceRepeat(`${c.name} is a ${role} attached to ${faction.name}. ${c.name} usually works from ${loc.name} and is associated with ${object.name}.`, paragraphsFor(preset, idx)), 'character', [c.id, faction.id, loc.id, object.id], { anchor: i < 6 })); idx++;
        rows.push(entry(`character.${c.id}.appearance`, `${c.name} - Appearance`, keysFor(preset, idx, `${c.name} appearance`, `${alias} appearance`), sentenceRepeat(`${c.name} has a stable identifying appearance marker numbered ${i + 1}, deliberately unique within this synthetic world.`, paragraphsFor(preset, idx)), 'character', [c.id])); idx++;
        rows.push(entry(`character.${c.id}.relationships`, `${c.name} - Relationships`, keysFor(preset, idx, `${c.name} relationships`, alias), sentenceRepeat(`${c.name} regularly coordinates with ${entities.chars[(i + 1) % entities.chars.length].name} and reports through ${faction.name}.`, paragraphsFor(preset, idx)), 'character', [c.id, entities.chars[(i + 1) % entities.chars.length].id, faction.id])); idx++;
    }
    for (const [i, loc] of entities.locations.entries()) {
        const faction = entities.factions[i % entities.factions.length];
        rows.push(entry(`location.${loc.id}`, `${loc.name} - Setting`, keysFor(preset, idx, loc.name, PLACE[i % PLACE.length]), sentenceRepeat(`${loc.name} is controlled or serviced by ${faction.name}. Landmark code L-${pad(i + 1, 3)} distinguishes it from similar locations.`, paragraphsFor(preset, idx)), 'location', [loc.id, faction.id], { anchor: i < 6 })); idx++;
    }
    for (const [i, faction] of entities.factions.entries()) {
        const loc = entities.locations[(i * 3) % entities.locations.length];
        rows.push(entry(`faction.${faction.id}`, `${faction.name} - Charter`, keysFor(preset, idx, faction.name, FACTION[i % FACTION.length]), sentenceRepeat(`${faction.name} operates from ${loc.name}. Charter clause F-${pad(i + 1, 3)} is a deterministic retrieval anchor.`, paragraphsFor(preset, idx)), 'faction', [faction.id, loc.id], { anchor: i < 4 })); idx++;
    }
    for (const [i, obj] of entities.objects.entries()) {
        const c = entities.chars[i % entities.chars.length];
        rows.push(entry(`object.${obj.id}`, `${obj.name} - Provenance`, keysFor(preset, idx, obj.name, OBJECT[i % OBJECT.length]), sentenceRepeat(`${obj.name} is currently associated with ${c.name}. Provenance mark O-${pad(i + 1, 4)} exists only in this entry.`, paragraphsFor(preset, idx)), 'object', [obj.id, c.id], { anchor: i < 6 })); idx++;
    }
    for (const [i, sys] of entities.systems.entries()) {
        const faction = entities.factions[i % entities.factions.length];
        rows.push(entry(`system.${sys.id}`, `${sys.name} - Operating Rule`, keysFor(preset, idx, sys.name, SYSTEM[i % SYSTEM.length]), sentenceRepeat(`${sys.name} is administered by ${faction.name}. Rule code S-${pad(i + 1, 3)} is authoritative for the synthetic fixture.`, paragraphsFor(preset, idx)), 'system', [sys.id, faction.id])); idx++;
    }
    return rows;
}

function fillChronology(preset, entities, rows) {
    let i = rows.length + 1;
    while (rows.length < preset.targetEntries) {
        const c1 = entities.chars[(i * 3) % entities.chars.length];
        const c2 = entities.chars[(i * 5 + 1) % entities.chars.length];
        const loc = entities.locations[(i * 7 + 2) % entities.locations.length];
        const faction = entities.factions[(i * 11 + 3) % entities.factions.length];
        const obj = entities.objects[(i * 13 + 4) % entities.objects.length];
        let title = `Year ${1000 + Math.floor(i / 96)} - Event ${pad(i, 4)}`;
        if (preset.content.duplicateTitleEvery && i % preset.content.duplicateTitleEvery === 0) title = 'Field Report - Duplicate Title';
        let content = `${c1.name} and ${c2.name} met at ${loc.name} regarding ${obj.name} and ${faction.name}. Event marker E-${pad(i, 5)} is unique and should survive summaries, slicing, and Tree reconciliation.`;
        if (preset.content.nearDuplicateEvery && i % preset.content.nearDuplicateEvery === 0 && rows.length) {
            const source = rows[Math.max(0, rows.length - 3)];
            content = `${source.content} Near-duplicate variant N-${pad(i, 4)} changes only this final provenance marker.`;
        } else {
            content = sentenceRepeat(content, paragraphsFor(preset, i));
        }
        rows.push(entry(`timeline.event-${pad(i, 5)}`, title, keysFor(preset, i, `event ${i}`, c1.name), content, 'timeline', [c1.id, c2.id, loc.id, faction.id, obj.id], { anchor: i % 113 === 0 }));
        i++;
    }
    return rows.slice(0, preset.targetEntries);
}

export function generateWorld(presetId, { limit } = {}) {
    const preset = getWorldLoadPreset(presetId);
    const rng = mulberry32(preset.seed >>> 0);
    const entities = buildEntities(preset, rng);
    let entries = makeCanonicalEntries(preset, entities, rng);
    entries = fillChronology(preset, entities, entries);
    const requested = Number.isFinite(limit) ? Math.max(0, Math.min(entries.length, Number(limit))) : entries.length;
    entries = entries.slice(0, requested);
    const anchors = entries.filter(row => row.anchor).map(row => ({ logicalId: row.logicalId, title: row.title, representedIds: row.representedIds }));
    return {
        fixtureVersion: '0.1.0', presetId: preset.id, label: preset.label, bookName: preset.bookName, seed: preset.seed,
        targetEntries: preset.targetEntries, generatedEntries: entries.length, preset, entities, entries,
        oracle: { anchors, requiredDomains: ['character','location','faction','object','system','timeline'], exactLogicalIdsUnique: true, builderShouldCreateTree: true, foregroundMustRemainUsable: true },
    };
}

export function growthPhaseWorld(phaseIndex) {
    const preset = getWorldLoadPreset('growth');
    const idx = Math.max(0, Math.min(preset.growthPhases.length - 1, Number(phaseIndex) || 0));
    return generateWorld('growth', { limit: preset.growthPhases[idx] });
}

export function buildMutationPlan(world, { batchSize } = {}) {
    const entries = world.entries;
    const count = Math.max(1, Math.min(entries.length, Number(batchSize) || world.preset.workload.mutationBatch || 32));
    const edits = [], deletes = [], renames = [];
    for (let i = 0; i < count; i++) {
        const row = entries[(i * 17 + 7) % entries.length];
        if (i % 9 === 0) deletes.push({ logicalId: row.logicalId });
        else if (i % 5 === 0) renames.push({ logicalId: row.logicalId, newTitle: `${row.title} — Renamed R${i}` });
        else edits.push({ logicalId: row.logicalId, append: ` Mutation marker M-${pad(i + 1, 3)} changes represented content and must invalidate stale Builder assumptions.` });
    }
    return { edits, deletes, renames, total: edits.length + deletes.length + renames.length };
}
