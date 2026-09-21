export const CHARACTER_BANK_TEST_FIXTURE_VERSION = '0.1.0';
export const TEST_BOOK = 'Nexus Test World - Character Banks';

export const CHARACTERS = Object.freeze({
    zareth: {
        key: 'zareth',
        name: 'Zareth Vale',
        sex: 'male',
        role: 'supporting',
        sceneAware: true,
        profile: {
            personality: 'Reserved and analytical. Speaks precisely, dislikes speculation, quietly protective of companions, and becomes dryly sarcastic when stressed.',
            appearance: 'Tall lean man with dark brown hair, grey eyes, a narrow scar through the left eyebrow, and long-fingered hands stained with graphite.',
            clothingArmor: 'Charcoal field coat over a slate shirt, black leather gloves, weathered boots, and a brass compass on a chain at his belt.',
        },
        tracking: { personality: true, relationships: true, status: true, goals: true, behavior: true },
    },
    mira: {
        key: 'mira',
        name: 'Mira Vey',
        sex: 'female',
        role: 'supporting',
        sceneAware: true,
        profile: {
            personality: 'Outspoken, playful, observant, and quick to challenge evasive answers. Uses humor to defuse tension but turns sharply practical during danger.',
            appearance: 'Athletic woman with auburn hair cut to the shoulders, green eyes, a small silver ear cuff on the right ear, and a pale freckle cluster across her nose.',
            clothingArmor: 'Blue travel jacket, cream shirt, dark trousers, red scarf, reinforced boots, and a compact field knife in a brown hip sheath.',
        },
        tracking: { personality: true, relationships: true, status: true, goals: true, behavior: true },
    },
});

// logicalId is stable test identity. The harness seeder resolves it to the real
// SillyTavern UID created in the isolated test lorebook at runtime.
export const LORE_ENTRIES = Object.freeze([
    {
        logicalId: 'zareth.identity',
        title: 'Zareth Vale - Identity & Personality',
        keys: ['Zareth Vale', 'Zareth personality', 'Zareth temperament'],
        nodePath: ['Characters', 'Zareth Vale'],
        content: 'Zareth Vale is a reserved, analytical field cartographer. He speaks precisely, dislikes unsupported guesses, quietly protects companions, and uses dry sarcasm under stress. He prefers observing a room before committing to action.'
    },
    {
        logicalId: 'zareth.appearance',
        title: 'Zareth Vale - Appearance',
        keys: ['Zareth appearance', 'Zareth scar', 'Zareth grey eyes'],
        nodePath: ['Characters', 'Zareth Vale'],
        content: 'Zareth is tall and lean with dark brown hair, grey eyes, a narrow scar through his left eyebrow, and long fingers often marked by graphite from map work.'
    },
    {
        logicalId: 'zareth.clothing',
        title: 'Zareth Vale - Clothing & Gear',
        keys: ['Zareth clothing', 'Zareth field coat', 'Zareth brass compass'],
        nodePath: ['Characters', 'Zareth Vale'],
        content: 'Zareth normally wears a charcoal field coat over a slate shirt, black leather gloves, and weathered boots. A brass compass hangs from a chain at his belt and is his most recognizable carried item.'
    },
    {
        logicalId: 'zareth.relationships',
        title: 'Zareth Vale - Relationships',
        keys: ['Zareth Mira', 'Zareth relationships', 'Mira Zareth'],
        nodePath: ['Characters', 'Zareth Vale'],
        content: 'Zareth trusts Mira Vey as a field partner. He finds her improvisational style reckless but relies on her instincts when his maps are incomplete. Their arguments are familiar rather than hostile.'
    },
    {
        logicalId: 'zareth.status',
        title: 'Zareth Vale - Current Status',
        keys: ['Zareth current status', 'Zareth injury', 'Zareth compass'],
        nodePath: ['Characters', 'Zareth Vale'],
        content: 'Baseline fixture state: Zareth is uninjured, his charcoal field coat is intact, and his brass compass is functional. He is investigating inconsistent road markers north of Lantern Tavern.'
    },
    {
        logicalId: 'mira.identity',
        title: 'Mira Vey - Identity & Personality',
        keys: ['Mira Vey', 'Mira personality', 'Mira temperament'],
        nodePath: ['Characters', 'Mira Vey'],
        content: 'Mira Vey is an outspoken and playful trail scout. She challenges evasive answers, notices social tension quickly, uses humor to defuse it, and becomes sharply practical when immediate danger appears.'
    },
    {
        logicalId: 'mira.appearance',
        title: 'Mira Vey - Appearance',
        keys: ['Mira appearance', 'Mira auburn hair', 'Mira green eyes', 'Mira ear cuff'],
        nodePath: ['Characters', 'Mira Vey'],
        content: 'Mira is athletic with shoulder-length auburn hair, green eyes, a small silver ear cuff on her right ear, and a pale cluster of freckles across her nose.'
    },
    {
        logicalId: 'mira.clothing',
        title: 'Mira Vey - Clothing & Gear',
        keys: ['Mira clothing', 'Mira red scarf', 'Mira field knife'],
        nodePath: ['Characters', 'Mira Vey'],
        content: 'Mira normally wears a blue travel jacket over a cream shirt, dark trousers, a red scarf, reinforced boots, and a compact field knife in a brown hip sheath.'
    },
    {
        logicalId: 'mira.relationships',
        title: 'Mira Vey - Relationships',
        keys: ['Mira Zareth', 'Mira relationships', 'Zareth Mira'],
        nodePath: ['Characters', 'Mira Vey'],
        content: 'Mira considers Zareth Vale her most reliable field partner. She deliberately provokes him out of over-analysis and trusts him to notice structural details she misses.'
    },
    {
        logicalId: 'mira.status',
        title: 'Mira Vey - Current Status',
        keys: ['Mira current status', 'Mira injury', 'Mira field knife'],
        nodePath: ['Characters', 'Mira Vey'],
        content: 'Baseline fixture state: Mira is uninjured, her red scarf and blue jacket are intact, and her field knife is secured. She is investigating the same road-marker problem as Zareth.'
    },
    {
        logicalId: 'location.lantern-tavern',
        title: 'Lantern Tavern - Common Room',
        keys: ['Lantern Tavern', 'tavern common room'],
        nodePath: ['Locations', 'Lantern Tavern'],
        content: 'Lantern Tavern is a busy roadside inn with a long hearth, six square tables, rain-dark windows, and a brass lantern over the front door. The common room is a stable social-scene fixture.'
    },
    {
        logicalId: 'location.north-market',
        title: 'North Market - Covered Arcade',
        keys: ['North Market', 'covered arcade'],
        nodePath: ['Locations', 'North Market'],
        content: 'North Market is a covered stone arcade of food stalls, cloth merchants, and repair benches. It is louder and more public than Lantern Tavern but still a non-combat location.'
    },
    {
        logicalId: 'location.watchtower',
        title: 'Ruined Watchtower - Upper Platform',
        keys: ['Ruined Watchtower', 'watchtower platform'],
        nodePath: ['Locations', 'Ruined Watchtower'],
        content: 'The Ruined Watchtower stands north of the road. Its upper platform is exposed to wind, the eastern stair is cracked, and old signal grooves are carved into the parapet. Entering it is a deliberate hard scene/location transition fixture.'
    },
    {
        logicalId: 'object.compass',
        title: "Zareth's Brass Compass - Hidden Marking",
        keys: ['brass compass', 'Zareth compass', 'hidden marking'],
        nodePath: ['Objects'],
        content: "Zareth's brass compass has a tiny seven-point star scratched beneath the lid. The marking is not visible unless the lid is opened fully. This is a controlled reveal fact for retrieval and Post-Turn tests."
    },
    {
        logicalId: 'object.knife',
        title: "Mira's Field Knife - Maker Mark",
        keys: ['Mira field knife', 'knife maker mark'],
        nodePath: ['Objects'],
        content: "Mira's field knife carries a crescent maker mark under the guard. It is mundane equipment; the mark exists only as a precise retrieval discriminator."
    },
    {
        logicalId: 'faction.wayfarers',
        title: 'Wayfarer Company - Field Team',
        keys: ['Wayfarer Company', 'field team'],
        nodePath: ['Factions'],
        content: 'The Wayfarer Company employs small survey teams. Zareth and Mira are assigned together but are not the only members. This generic lore should cooperate with Character Bank-linked lore rather than be excluded by it.'
    },
]);

export const TREE_PLAN = Object.freeze({
    label: 'Root',
    summary: 'Synthetic Nexus Character Bank acceptance tree.',
    children: [
        { label: 'Characters', children: [
            { label: 'Zareth Vale', logicalEntries: ['zareth.identity','zareth.appearance','zareth.clothing','zareth.relationships','zareth.status'] },
            { label: 'Mira Vey', logicalEntries: ['mira.identity','mira.appearance','mira.clothing','mira.relationships','mira.status'] },
        ]},
        { label: 'Locations', children: [
            { label: 'Lantern Tavern', logicalEntries: ['location.lantern-tavern'] },
            { label: 'North Market', logicalEntries: ['location.north-market'] },
            { label: 'Ruined Watchtower', logicalEntries: ['location.watchtower'] },
        ]},
        { label: 'Objects', logicalEntries: ['object.compass','object.knife'] },
        { label: 'Factions', logicalEntries: ['faction.wayfarers'] },
    ],
});

export const CHARACTER_BANK_SEEDS = Object.freeze([
    {
        fixtureCharacter: 'zareth',
        enabled: true,
        character: CHARACTERS.zareth.name,
        role: CHARACTERS.zareth.role,
        sceneAware: CHARACTERS.zareth.sceneAware,
        profile: CHARACTERS.zareth.profile,
        tracking: CHARACTERS.zareth.tracking,
        linkedLogicalRefs: ['zareth.identity','zareth.appearance','zareth.clothing','zareth.relationships','zareth.status'],
    },
    {
        fixtureCharacter: 'mira',
        enabled: true,
        character: CHARACTERS.mira.name,
        role: CHARACTERS.mira.role,
        sceneAware: CHARACTERS.mira.sceneAware,
        profile: CHARACTERS.mira.profile,
        tracking: CHARACTERS.mira.tracking,
        linkedLogicalRefs: ['mira.identity','mira.appearance','mira.clothing','mira.relationships','mira.status'],
    },
]);

export const SCENE_COMMANDS = Object.freeze([
    {
        id: 'baseline-empty',
        label: 'Baseline: neither present',
        text: 'Rain taps the windows of Lantern Tavern. The table is empty of both field scouts; neither Zareth Vale nor Mira Vey is currently in the room.',
        expected: { active: [], note: 'Names appear only in an explicit absence statement; acceptance must verify that participant logic does not mistake this for scene presence.' }
    },
    {
        id: 'zareth-arrives',
        label: 'Zareth enters scene',
        text: 'The tavern door opens and Zareth Vale steps into the common room, rain on his charcoal field coat. He removes one black glove, checks the brass compass at his belt, and joins the table.',
        expected: { active: ['Zareth Vale'], gate: 'MAJOR_CHANGE', warmCharacter: 'Zareth Vale' }
    },
    {
        id: 'mira-arrives',
        label: 'Mira enters scene',
        text: 'A moment later Mira Vey enters, red scarf damp from the rain. She drops into the chair beside Zareth and taps the sheath of her field knife against the table.',
        expected: { active: ['Zareth Vale','Mira Vey'], gate: 'MAJOR_CHANGE', warmCharacter: 'Mira Vey' }
    },
    {
        id: 'focus-mira',
        label: 'Shift focus to Mira',
        text: "The conversation narrows to Mira Vey. She leans forward, green eyes fixed on the road sketch, and explains why the marker pattern feels deliberately misleading while Zareth listens.",
        expected: { active: ['Zareth Vale','Mira Vey'], gate: 'MINOR_CHANGE', focus: 'Mira Vey' }
    },
    {
        id: 'mention-only-zareth',
        label: 'Mention Zareth while absent',
        text: 'Mira Vey sits alone in North Market and tells the merchant that Zareth Vale stayed behind at the tavern to recheck the maps.',
        expected: { active: ['Mira Vey'], absentMention: 'Zareth Vale' }
    },
    {
        id: 'zareth-leaves',
        label: 'Zareth leaves scene',
        text: 'Zareth Vale closes his compass, says he will inspect the north road alone, and walks out of Lantern Tavern. Mira Vey remains at the table after the door shuts behind him.',
        expected: { active: ['Mira Vey'], gate: 'MAJOR_CHANGE', departed: 'Zareth Vale' }
    },
    {
        id: 'move-watchtower',
        label: 'Move to Ruined Watchtower',
        text: 'Later, Mira Vey reaches the upper platform of the Ruined Watchtower. Wind pulls at her red scarf as she examines the cracked eastern stair and the grooves carved into the parapet.',
        expected: { active: ['Mira Vey'], gate: 'MAJOR_CHANGE', locationLogicalRef: 'location.watchtower' }
    },
    {
        id: 'mira-injury',
        label: 'Change Mira status',
        text: 'A loose stone gives way. Mira Vey catches herself but cuts her left palm on the parapet. She wraps the shallow bleeding cut with a strip torn from spare cloth; her field knife remains secured.',
        expected: { active: ['Mira Vey'], trackedChange: 'status', durableFact: 'Mira has a shallow bandaged cut on her left palm.' }
    },
    {
        id: 'zareth-clothing-change',
        label: 'Change Zareth clothing',
        text: 'When Zareth Vale returns, his soaked charcoal field coat is gone. He is wearing a borrowed tan canvas jacket, though the brass compass still hangs at his belt.',
        expected: { active: ['Zareth Vale','Mira Vey'], trackedChange: 'status', durableFact: 'Zareth is currently wearing a borrowed tan canvas jacket instead of his charcoal field coat.' }
    },
    {
        id: 'reveal-compass-mark',
        label: 'Reveal hidden compass fact',
        text: 'Zareth Vale opens the brass compass lid all the way. Mira notices the tiny seven-point star scratched beneath the lid for the first time.',
        expected: { active: ['Zareth Vale','Mira Vey'], retrievalLogicalRef: 'object.compass', durableFact: 'Mira has now seen the seven-point star hidden beneath the compass lid.' }
    },
]);

export function buildResolvedCharacterBankSeeds(uidByLogicalId, nodeByLogicalId = {}) {
    const titleById = new Map(LORE_ENTRIES.map(entry => [entry.logicalId, entry.title]));
    return CHARACTER_BANK_SEEDS.map(seed => ({
        enabled: seed.enabled,
        character: seed.character,
        role: seed.role,
        sceneAware: seed.sceneAware,
        profile: { ...seed.profile },
        tracking: { ...seed.tracking },
        linkedRefs: seed.linkedLogicalRefs.map(logicalId => ({
            book: TEST_BOOK,
            uid: Number(uidByLogicalId[logicalId]),
            title: titleById.get(logicalId) || logicalId,
            nodeId: nodeByLogicalId[logicalId]?.id || null,
            nodeLabel: nodeByLogicalId[logicalId]?.label || '',
            path: nodeByLogicalId[logicalId]?.path || [],
        })).filter(ref => Number.isFinite(ref.uid)),
        memoryIds: [],
    }));
}
