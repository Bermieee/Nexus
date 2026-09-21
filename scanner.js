function clean(value) { return String(value ?? '').replace(/\r/g, '').trim(); }
function escRe(value) { return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function explicitSection(text, labels = []) {
    const source = clean(text);
    if (!source) return '';
    for (const label of labels) {
        const name = escRe(label);
        const line = new RegExp(`(?:^|\\n)\\s*(?:\\[?${name}\\]?|\\*\\*${name}\\*\\*)\\s*[:\\-]\\s*([^\\n]+)`, 'i').exec(source);
        if (line?.[1]) return clean(line[1]);
    }
    return '';
}

export function scanCharacterCardDeterministically(card = {}) {
    const description = clean(card.description);
    const proposals = {
        character: clean(card.name),
        profile: {
            personality: clean(card.personality),
            appearance: explicitSection(description, ['appearance', 'physical appearance', 'looks']),
            clothingArmor: explicitSection(description, ['clothing', 'attire', 'armor', 'equipment', 'gear']),
        },
    };
    const provenance = {
        character: proposals.character ? ['name'] : [],
        'profile.personality': proposals.profile.personality ? ['personality'] : [],
        'profile.appearance': proposals.profile.appearance ? ['description:explicit appearance label'] : [],
        'profile.clothingArmor': proposals.profile.clothingArmor ? ['description:explicit clothing/equipment label'] : [],
    };
    const excludedInstructionFields = ['systemPrompt', 'postHistoryInstructions'].filter(key => clean(card[key]));
    return {
        card,
        proposals,
        provenance,
        excludedInstructionFields,
        unmappedContext: {
            description,
            scenario: clean(card.scenario),
            creatorNotes: clean(card.creatorNotes),
        },
    };
}

export function buildCardBinding(card = {}, now = Date.now(), previous = null) {
    const avatar = clean(card.avatar);
    if (!avatar) throw new Error('The SillyTavern character has no stable avatar identity to bind.');
    const stamp = Number(now) || Date.now();
    const sameCard = clean(previous?.avatar) === avatar;
    return {
        source: 'sillytavern', avatar,
        name: clean(card.name),
        fingerprint: clean(card.fingerprint),
        boundAt: sameCard && Number(previous?.boundAt) ? Number(previous.boundAt) : stamp,
        lastScannedAt: stamp,
    };
}
