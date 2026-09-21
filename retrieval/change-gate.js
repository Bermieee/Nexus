import { logEvent } from '../observability/telemetry.js';

export const RETRIEVAL_CHANGE = Object.freeze({
    NO_CHANGE: 'NO_CHANGE',
    MINOR_CHANGE: 'MINOR_CHANGE',
    MAJOR_CHANGE: 'MAJOR_CHANGE',
});

function uniqueStrings(values = []) {
    return [...new Set((Array.isArray(values) ? values : []).map(value => String(value ?? '').trim()).filter(Boolean))];
}

function cloneWorkPlanValue(value) {
    if (value == null) return value;
    try { return structuredClone(value); } catch {
        try { return JSON.parse(JSON.stringify(value)); } catch { return null; }
    }
}

/**
 * Aggregate execution/reuse evidence *after* semantic classification.
 *
 * Change Gate owns the NO/MINOR/MAJOR label, but it does not invent context
 * authority. Every entry in ownerPlans must already have been produced by the
 * subsystem that owns those refs/domains (Retrieval, Memory, Smart Context,
 * etc.). This helper only gives the Director/diagnostics one bounded view of
 * how much authorized work remains.
 */
export function buildChangeWorkPlan({
    gate = null,
    hasValidatedContext = false,
    ownerPlans = {},
    executionPlan = null,
} = {}) {
    const plans = Object.entries(ownerPlans && typeof ownerPlans === 'object' ? ownerPlans : {})
        .filter(([, plan]) => plan && typeof plan === 'object');
    const preservedDomains = [];
    const refreshDomains = [];
    const fullRefreshDomains = [];
    const targetedRefreshDomains = [];
    let weightedReuse = 0;
    let weightedTotal = 0;
    let estimatedWorkUnits = 0;

    const sanitizedOwners = {};
    for (const [owner, raw] of plans) {
        const plan = cloneWorkPlanValue(raw) || {};
        sanitizedOwners[String(owner)] = plan;
        preservedDomains.push(...uniqueStrings(plan.preserveDomains));
        refreshDomains.push(...uniqueStrings(plan.dirtyDomains));
        const total = Math.max(0, Number(plan.previousRefCount) || Number(plan.totalUnits) || 0);
        const ratio = Number(plan.reuseRatio);
        if (total > 0 && Number.isFinite(ratio)) {
            weightedReuse += Math.max(0, Math.min(1, ratio)) * total;
            weightedTotal += total;
        }
        estimatedWorkUnits += Math.max(0, Number(plan.estimatedWorkUnits ?? plan.estimatedDirtyUnits) || 0);
        if (plan.fullRegionalRequired === true) {
            fullRefreshDomains.push('regional-routing');
        }
        if (plan.escalateFullRefresh === true) {
            fullRefreshDomains.push(...uniqueStrings(plan.dirtyDomains));
        } else {
            targetedRefreshDomains.push(...uniqueStrings(plan.dirtyDomains));
        }
    }

    const executionMode = String(executionPlan?.mode || '').trim() || null;
    const workRequired = executionMode ? executionMode !== 'REUSE' : !hasValidatedContext || String(gate?.mode || '') !== RETRIEVAL_CHANGE.NO_CHANGE;
    return {
        semanticClass: String(gate?.mode || '') || null,
        validatedContextAvailable: hasValidatedContext === true,
        continuityObservations: cloneWorkPlanValue(gate?.sceneDelta || null),
        overallReuseRatio: weightedTotal > 0 ? Number((weightedReuse / weightedTotal).toFixed(4)) : null,
        preserveDomains: uniqueStrings(preservedDomains),
        refreshDomains: uniqueStrings(refreshDomains),
        fullRefreshRequiredDomains: uniqueStrings(fullRefreshDomains),
        targetedRefreshDomains: uniqueStrings(targetedRefreshDomains),
        estimatedWorkUnits,
        executionMode,
        workRequired,
        ownerPlans: sanitizedOwners,
        authoritySource: 'owner-supplied',
    };
}

// The foreground gate must answer one narrow question: can the prior Tree
// region set still be trusted?  Hard scene-boundary signals are evaluated
// before lexical overlap.  A low-overlap turn is not automatically a scene
// change, and a lore/topic mention (for example "Floor 18" or "Neith") is not
// automatically a scene change either.
const EXPLICIT_SCENE_PATTERN = /^(?:\s*[*_~-]*\s*)?\[(?:system|scene|timeskip|time\s*skip|transition|travel|dive|surface|camp|ooc)\b/i;
const TIME_SHIFT_PATTERN = /(?:^|[.!?]\s+)(?:\s*)(?:(?:(?:\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|several|a\s+few|half\s+an?)\s+(?:seconds?|minutes?|hours?|days?|weeks?|months?|years?)\s+later\b)|(?:(?:moments?|seconds?|minutes?|hours?|days?|weeks?|months?|years?)\s+later\b)|(?:(?:shortly|soon|not\s+long)\s+after(?:ward|wards)?\b)|(?:later\s+(?:that|the\s+same)\s+(?:morning|afternoon|evening|night|day)\b)|(?:(?:the\s+)?(?:next|following)\s+(?:morning|afternoon|evening|night|day|week|month|year)\b)|(?:(?:after)\s+(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|half\s+an?|a)\s+(?:seconds?|minutes?|hours?|days?|weeks?|months?|years?)\b)|(?:(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|half\s+an?|a|several|a\s+few)\s+(?:seconds?|minutes?|hours?|days?|weeks?|months?|years?)\s+(?:(?:have|has|had)\s+)?(?:pass|passes|passed|elapse|elapses|elapsed|gone\s+by)\b)|(?:(?:after|before)\s+(?:breakfast|lunch|dinner|supper|dawn|sunrise|sunset|midnight|the\s+meeting|the\s+fight|the\s+battle|the\s+dive|the\s+expedition)\s*[,.:—-])|(?:(?:on\s+)?(?:year\s+\d+\s*,?\s*)?(?:month\s+\d+\s*,?\s*)?day\s+\d+\s*[,.:—-]))/i;
const SCENE_RESET_PATTERN = /(?:^|[.!?]\s+)(?:\s*)(?:meanwhile\b|elsewhere\b|cut\s+to\b|the\s+scene\s+(?:cuts?|shifts?|moves?)\s+to\b|we\s+are\s+now\s+(?:at|in|inside|outside)\b)/i;
const CJK_TIME_SHIFT_PATTERN = /(?:翌朝|翌日|翌晩|次の朝|次の日|数(?:秒|分|時間|日|週間|か月|ヶ月|年)後|[一二三四五六七八九十百千万萬〇零0-9]+(?:秒|分|時間|日|週間|週|か月|ヶ月|月|年)後|その(?:朝|午後|夕方|夜)|第二天(?:早上|上午|下午|晚上)?|次日|幾(?:秒|分鐘|小時|天|週|月|年)後|几(?:秒|分钟|小时|天|周|月|年)后|[一二三四五六七八九十百千万萬〇零0-9]+(?:秒|分钟|分鐘|小时|小時|天|周|週|月|年)(?:后|後)|当晚|當晚)/u;
const CJK_SCENE_RESET_PATTERN = /(?:一方で|その頃|別の場所では|与此同时|與此同時|另一边|另一邊|别处|別處)/u;
const CJK_PARTICIPANT_BOUNDARY_PATTERN = /(?:(?:[\p{L}][\p{L}0-9_'’-]{0,31})(?:が|は)(?:隊列|パーティー|チーム|グループ|会議|会話)(?:に(?:加わった|合流した|参加した)|から(?:離脱した|退出した|抜けた|離れた))|(?:加入|参加|參加|会合|會合|退出|离开|離開)(?:了)?(?:队伍|隊伍|团队|團隊|小组|小組|会议|會議|对话|對話|队列|隊列))/u;
const CJK_STRUCTURAL_DESTINATION_PATTERN = /(?:ダンジョン|地下城|迷宮|ギルド|公会|公會|都市|城市|町|村|病院|医院|醫院|学校|學校|大学|大學|空港|机场|機場|駅|车站|車站|港|神殿|寺院|教会|教會|市場|市场|城|砦|要塞|第?[一二三四五六七八九十百千万萬0-9]+(?:階|层|層))/u;
const CJK_RELOCATION_VERB_PATTERN = /(?:到着(?:した|する)?|到達(?:した|する)?|着いた|向かった|移動した|出発した|降りた|上がった|抵达|抵達|到达|到達|进入|進入|前往|赶到|趕到|返回|回到|离开|離開)/u;
const SPANISH_TIME_SHIFT_PATTERN = /(?:^|[.!?]\s+)(?:\s*)(?:(?:\d+|una?|dos|tres|cuatro|cinco|seis|varias?|unas?\s+cuantas?)\s+(?:minutos?|horas?|d[ií]as?|semanas?)\s+(?:despu[eé]s|m[aá]s\s+tarde)\b|(?:momentos?|minutos?|horas?|d[ií]as?|semanas?)\s+despu[eé]s\b|(?:a\s+la\s+)?(?:ma[nñ]ana|tarde|noche)\s+siguiente\b|(?:al\s+)?d[ií]a\s+siguiente\b|(?:despu[eé]s|antes)\s+de\s+(?:desayuno|almuerzo|comida|cena|amanecer|anochecer|medianoche|la\s+reuni[oó]n|la\s+pelea|la\s+batalla|la\s+expedici[oó]n)\s*[,.:—-])/iu;
const SPANISH_STRUCTURAL_DESTINATION_PATTERN = /\b(?:mazmorra|gremio|ciudad|pueblo|aldea|hospital|cl[ií]nica|escuela|universidad|aeropuerto|estaci[oó]n|puerto|templo|iglesia|mercado|castillo|fortaleza|campamento|mans[ií]on|distrito|pa[ií]s|parque|playa|hotel|restaurante|caf[eé]|tienda|centro\s+comercial|edificio)\b/iu;
const SPANISH_RELOCATION_VERB_PATTERN = /\b(?:lleg(?:a|an|ó|aron)|entr(?:a|an|ó|aron)|sal(?:e|en|ió|ieron)|regres(?:a|an|ó|aron)|volv(?:i[oó]|ieron|er)|fue|fueron|va|van|viaj(?:a|an|ó|aron)|descend(?:i[oó]|ieron|e|en)|ascend(?:i[oó]|ieron|e|en)|se\s+dirigi[oó]|se\s+dirigieron|se\s+traslad(?:ó|aron))\b/iu;
const PROGRESSION_PATTERN = /\b(?:skip(?:s|ped|ping)?|progress(?:es|ed|ing)?)\s+(?:to|through)\b|\b(?:dive(?:s|d|ing)?|dove|surface(?:s|d|ing)?)\s+(?:to|from)\b/i;
const MOTION_VERB_PATTERN = /\b(?:arriv(?:e|es|ed|ing)|enter(?:s|ed|ing)?|depart(?:s|ed|ing)?|leave(?:s|d|ing)?|left|return(?:s|ed|ing)?|come(?:s|ing)?|came|descend(?:s|ed|ing)?|ascend(?:s|ed|ing)?|travel(?:s|ed|ing)?|drive(?:s|d|ing)?|drove|fly|flies|flew|flying|sail(?:s|ed|ing)?|commut(?:e|es|ed|ing)|hike(?:s|d|ing)?|head(?:s|ed|ing)?|walk(?:s|ed|ing)?|step(?:s|ped|ping)?|move(?:s|d|ing)?|go(?:es|ing)?|went|cross(?:es|ed|ing)?|pass(?:es|ed|ing)?|run(?:s|ning)?|ran|ride(?:s|d|ing)?|rode|climb(?:s|ed|ing)?|follow(?:s|ed|ing)?|accompan(?:y|ies|ied|ying)|escort(?:s|ed|ing)?|lead(?:s|ing)?|led|take(?:s|n|ing)?|took|bring(?:s|ing)?|brought|make(?:s|d|ing)?\s+(?:his|her|their|our|my)?\s*way|teleport(?:s|ed|ing)?|warp(?:s|ed|ing)?|blink(?:s|ed|ing)?|materializ(?:e|es|ed|ing))\b/ig;
const SPATIAL_PREPOSITION_PATTERN = /\b(to|into|inside|outside|through|across|toward|towards|out\s+of|at)\b\s*([^.!?\n]{0,80})/i;
const STRUCTURAL_DESTINATION_PATTERN = /\b(?:police\s+station|fire\s+station|floor\s+\d+|level\s+\d+)\b/i;
const LOCAL_DESTINATION_HEADS = new Set([
    'room','bedroom','hallway','hall','corridor','doorway','door','bed','table','desk','chair','window','counter','couch','sofa','kitchen','bathroom','restroom','stairs','staircase','corner','wall','shelf','printer','whiteboard','podium','aisle','lobby','porch','balcony','yard','garden','closet','cabinet','sink','shower','elevator','lift','landing','foyer','office','lounge','basement','attic','garage','workshop','library','gym','laboratory','lab','phone','gate','upstairs','downstairs','indoors','outdoors',
]);
const STRUCTURAL_DESTINATION_HEADS = new Set([
    'home','house','apartment','building','campus','school','university','college','hospital','clinic','station','airport','terminal','restaurant','cafe','café','bar','pub','hotel','motel','store','shop','mall','courthouse','court','jail','prison','city','town','village','district','country','state','province','street','road','highway','bridge','headquarters','hq','base','camp','battlefield','dungeon','guild','manor','work','park','beach','church','temple','mosque','synagogue','museum','theater','theatre','cinema','market','pharmacy','bank','warehouse','factory','farm','ranch','port','harbor','harbour','dock','arena','stadium',
]);
const AMBIGUOUS_FACILITY_HEADS = new Set(['library','gym','laboratory','lab','office','workshop']);
const CONTAINER_DESTINATION_HEADS = new Set(['home','house','apartment','building','campus','school','university','college','hospital','clinic','airport','terminal','hotel','motel','mall','courthouse','jail','prison','headquarters','hq','base','camp','dungeon','guild','manor']);
const STRONG_RELOCATION_VERB_PATTERN = /^(?:arriv|enter|depart|travel|descend|ascend|head|go|went|ride|rode|climb|follow|accompan|escort|leave|left|return|come|came|drive|drove|fly|flew|sail|commut|hike|walk|step|move|cross|pass|run|ran|teleport|warp|blink|materializ)/i;
const ACTIVITY_BOUNDARY_PATTERN = /\b(?:(?:the\s+)?(?:meeting|call|class|session|interview|hearing|trial|ceremony|fight|battle|combat|operation|procedure|game|match|practice|training|shift|meal|breakfast|lunch|dinner|party|event|conversation|discussion)\s+(?:begins?|starts?|commences?|kicks?\s+off|gets?\s+underway|ends?|finishes|concludes|wraps?\s+up|adjourns?|completes?|is\s+over)|(?:begins?|starts?|commences?|resumes?)\s+(?:fighting|combat|training|practice|the\s+meeting|the\s+call|the\s+interview|the\s+session|the\s+conversation|the\s+discussion)|(?:hangs?\s+up|ends?\s+the\s+call|wraps?\s+up\s+the\s+call|adjourns?\s+the\s+meeting)|(?:argument|conversation|discussion|meeting|training|practice|routine|procedure|operation|meal|event)\s+(?:turns?|turned|shifts?|shifted|becomes?|became)\s+(?:into|to)\s+(?:an?\s+)?(?:fight|battle|combat|emergency|evacuation|chase|arrest|interrogation|procedure|operation|meeting|call|meal|training|practice))\b/i;
const FOCUS_SHIFT_PATTERN = /\b(?:let'?s\s+(?:talk|discuss)\s+about|speaking\s+of|switch(?:ing)?\s+(?:topics?|subjects?)|change\s+the\s+subject|as\s+for|on\s+another\s+note|turn(?:ing)?\s+to|instead\b|(?:discussion|conversation|topic|subject)\s+(?:turns?|turned|shifts?|shifted|moves?|moved)\s+(?:to|toward|towards)|(?:asks?|tells?|talks?|speaks?|argues?|jokes?)\b[^.!?]{0,48}\babout\b)\b/i;
const STRONG_DURABLE_STATE_BOUNDARY_PATTERN = /\b(?:confess(?:es|ed|ing)?\s+(?:his|her|their|my|our)?\s*(?:love|feelings)|break(?:s|ing)?\s+up\s+with|broke\s+up\s+with|ends?\s+(?:their|our|the)\s+relationship|start(?:s|ed|ing)?\s+dating|begin(?:s|ning|began)?\s+dating|become(?:s|became)?\s+(?:his|her|their|my|our)\s+(?:boyfriend|girlfriend|partner)|get(?:s|ting)?\s+back\s+together|got\s+back\s+together|reconcil(?:e|es|ed|ing)|become(?:s|became)?\s+engaged|get(?:s|ting)?\s+engaged|got\s+engaged|propos(?:e|es|ed|ing)\s+to|accepts?\s+(?:the|his|her|their)\s+proposal|rejects?\s+(?:the|his|her|their)\s+proposal|gets?\s+married|marries|married\s+him|married\s+her|divorc(?:e|es|ed|ing)|passes?\s+away|is\s+killed|was\s+killed)\b/i;
const DEATH_WORD_PATTERN = /\b(?:dies|died)\b/i;
// Bare death vocabulary is too ambiguous to be a hard topology boundary.
// Require affirmative literal-death evidence instead of maintaining an endless
// list of colloquial carve-outs.  Near-death language is intentionally not a
// death-state transition; other activity/injury signals may still move the gate.
const LITERAL_DEATH_STATE_PATTERN = /\b(?:(?:is|was|were)\s+(?:pronounced|declared)\s+dead|(?:is|was|were)\s+found\s+dead|(?:is|was|were)\s+dead\b|found\s+(?:him|her|them|[A-Z][A-Za-z'-]{1,31})\s+dead)\b/i;
const LITERAL_DEATH_CAUSE_PATTERN = /\b(?:dies|died)\s+(?:from|of)\s+(?:(?:his|her|their|the|a|an)\s+)?(?:injur(?:y|ies)|wounds?|blood\s+loss|bleeding|poison(?:ing)?|disease|illness|infection|cancer|stroke|heart\s+attack|cardiac\s+arrest|organ\s+failure|burns?|smoke\s+inhalation|gunshot|stab\s+wounds?|trauma|exposure|starvation|dehydration|overdose)\b/i;
const LITERAL_DEATH_EVENT_PATTERN = /\b(?:dies|died)\s+(?:during|after|in)\s+(?:(?:the|a|an)\s+)?(?:crash|accident|attack|battle|fight|combat|surgery|operation|hospital|clinic|fire|explosion|shooting|collapse|disaster|wreck)\b/i;
const LITERAL_DEATH_RECOVERY_PATTERN = /\b(?:dies|died)\b[^.!?]{0,64}\b(?:reviv(?:e|es|ed|ing)|resurrect(?:s|ed|ing)?|came\s+back\s+to\s+life|returned\s+to\s+life)\b/i;
const THIRD_PERSON_BARE_DEATH_PATTERN = /(?:^|[.!?]\s+)\s*(?:(?:[A-Z][a-z][A-Za-z'-]{1,31})|he|she|they|someone|somebody|(?:my|his|her|their|our)\s+[a-z][A-Za-z'-]{1,31})\s+(?:dies|died)\s*(?:suddenly|instantly|immediately|peacefully|overnight|last\s+(?:night|week|month|year)|this\s+(?:morning|afternoon|evening|night))?\s*[.!?]?\s*$/i;
const ACKNOWLEDGEMENT_PATTERN = /^(?:[\s*_~`-]*)(?:ok(?:ay)?|yeah|yep|yes|no|sure|right|fine|thanks?|thank\s+you|mm+hmm|uh-huh|i\s+(?:nod|shrug|smile|agree)|go\s+on|continue)(?:[\s.!?…*_~`-]*)$/i;
const PRONOUN_CONTINUATION_PATTERN = /^(?:[\s*_~`-]*)(?:i|we|you|he|she|they|it)\b/i;
// Long-form RP commonly prefixes a stable continuation with the speaking/acting
// character name (for example `*Enoch says quietly* ...`).  Treat that form
// like a pronoun-led continuation after hard/soft scene signals have already
// been ruled out. This closes a NO_CHANGE starvation gap without weakening
// participant/location/activity boundaries.
const NAMED_RP_CONTINUATION_PATTERN = /^(?:[\s*_~`-]*)(?:\*+\s*)?(?:[A-Z][A-Za-z'-]{1,31})(?:\s+[A-Z][A-Za-z'-]{1,31}){0,2}\s+(?:says?|replies?|answers?|whispers?|murmurs?|mutters?|smiles?|nods?|shrugs?|laughs?|grins?|sighs?|looks?|watches?|leans?|rests?|holds?|keeps?|continues?|adds?|admits?|states?|remarks?|teases?|jokes?|chuckles?)\b/i;
const EXPLICIT_STABILITY_PATTERN = /\b(?:same\s+(?:room|place|location|scene|table|participants?|people|group|conversation|discussion|topic|plan)|still\s+(?:here|there|seated|standing|talking|discussing|waiting|watching)|remain(?:s|ed|ing)?\b|stay(?:s|ed|ing)?\b|keep(?:s|ing)?\s+(?:talking|discussing|watching|waiting|studying|reading|holding|sitting)|continue(?:s|d|ing)?\b|without\s+(?:changing|leaving|moving)|nothing\s+(?:about\s+)?(?:the\s+)?(?:room|scene|location|participants?)\s+changes?)\b/i;
const QUOTED_DIALOGUE_PATTERN = /^(?:[\s*_~`-]*)(?:\*+[^*]{0,80}\*+\s*)?(?:[A-Z][A-Za-z'-]{1,31}(?:\s+[A-Z][A-Za-z'-]{1,31}){0,2}\s+)?(?:says?|replies?|answers?|asks?|whispers?|murmurs?|mutters?|adds?|continues?)?\s*[,.:—-]?\s*["“]/i;
const EXPLICIT_FOCUS_DELTA_PATTERN = /\b(?:conversation|discussion|focus|attention|topic|subject)\s+(?:narrows?|centers?|centres?|focuses?|shifts?|turns?|moves?)\s+(?:on|onto|to|toward|towards)\b|\b(?:becomes?|gets?)\s+more\s+specific\b|\bmaterially\s+changes?\s+(?:which|what|where|how)\b/i;
const NAMED_PARTICIPANT_EXIT_PATTERN = /(?:^|[.!?]\s+)\s*([A-Z][A-Za-z'-]{1,31}(?:\s+[A-Z][A-Za-z'-]{1,31}){0,2})\s+(?:departs?|leaves?|left|exits?|walks?\s+out|steps?\s+out|heads?\s+out)\b(?:(?:\s+(?:quietly|silently|alone|first|early|abruptly|suddenly|without\s+a\s+word)){0,2}\s*[.!?,;:]|[^.!?]{0,72}(?:\bout\s+of\b|\bfrom\b|\bthe\s+door\b|\bscene\b))/i;
const PURPOSE_INFINITIVES = new Set([
    'understand','explain','ask','tell','say','discuss','argue','think','consider','remember','decide','plan','try','help','learn','figure','prove','show','check','confirm','make','keep','let','give','get','have','be','do','file','submit','send','meet','eat','rest','sleep','work','shop','visit','talk','speak','wait','pick','drop',
]);
const DISCOURSE_LOCATIONS = new Set([
    'least','first','fact','turn','response','silence','general','particular','that point','this point','the end','the moment','that moment','this moment','the meantime','conclusion','result','outcome','answer','point',
]);
// Motion verbs are highly polysemous in RP prose ("go over the notes",
// "walk her through the plan", "left his cup").  Treat abstract/discourse
// objects as non-spatial destinations so movement requires positive place
// evidence instead of a verb alone.
const NON_SPATIAL_DESTINATION_HEADS = new Set([
    'topic','subject','plan','plans','note','notes','number','numbers','reasoning','logic','idea','ideas','thought','thoughts','question','questions','answer','answers','explanation','discussion','conversation','argument','story','stories','detail','details','issue','issues','matter','matters','example','examples','step','steps','process','method','methods','approach','approaches','point','points','off','on','over',
]);
const EXPLICIT_PARTICIPANT_JOIN_PATTERN = /\b(?:join(?:s|ed|ing)?|rejoin(?:s|ed|ing)?)\s+(?:us|them|him|her|me|the\s+(?:call|meeting|conversation|group|party|team|session|interview|class))\b/i;
const EXPLICIT_PARTICIPANT_LEAVE_PATTERN = /\b(?:leave(?:s|d|ing)?|left|exit(?:s|ed|ing)?|depart(?:s|ed|ing)?)\s+(?:from\s+)?(?:the\s+)?(?:call|meeting|conversation|group|party|team|session|interview|class)\b/i;
const NAMED_PARTICIPANT_ENTRY_PATTERN = /(?:^|[.!?]\s+)\s*([\p{Lu}][\p{L}\p{M}'’-]{0,31}(?:\s+[\p{Lu}][\p{L}\p{M}'’-]{0,31}){0,2})\s+(arriv(?:e|es|ed|ing)|return(?:s|ed|ing)?|enter(?:s|ed|ing)?|join(?:s|ed|ing)?|rejoin(?:s|ed|ing)?|steps?\s+(?:in|into)|walks?\s+(?:in|into)|comes?\s+(?:in|into)|appears?\s+(?:in|at)|shows?\s+up)\b/iu;
const BARE_PARTICIPANT_EXIT_PATTERN = /(?:^|[.!?]\s+)\s*(?:(?:[A-Z][a-z][A-Za-z'-]{1,31})|he|she|they)\s+(?:leave(?:s|d)?|left|exit(?:s|ed)?|depart(?:s|ed)?|steps?\s+out|heads?\s+out)\b(?:\s+(?:quietly|silently|alone|first|early|abruptly|suddenly|without\s+a\s+word)){0,2}\s*(?:[.!?,;:]|$)/i;
const PRONOUN_SCENE_ENTRY_PATTERN = /(?:^|[.!?]\s+)\s*(?:he|she|they)\s+(?:arriv(?:e|es|ed|ing)|steps?\s+in|walks?\s+in|comes?\s+in|returns?)\s*(?:[.!?,;:]|$)/i;
const GENERIC_PARTICIPANT_ENTRY_PATTERN = /(?:^|[.!?]\s+)\s*(?:(?:someone|somebody|a\s+(?:stranger|man|woman|boy|girl|guard|soldier|messenger|visitor|guest|worker|doctor|nurse|student|adventurer|dwarf|elf|god|goddess))\s+)(?:arriv(?:e|es|ed|ing)|return(?:s|ed|ing)?|enter(?:s|ed|ing)?|steps?\s+in|walks?\s+in|comes?\s+in|appears?|shows?\s+up)\b/i;

const IGNORED_NAMES = new Set([
    'The','This','That','These','Those','There','Then','Here','What','Why','When','Where','Who','How',
    'Okay','Yeah','Yes','No','And','But','So','Now','Well','Just','Can','Could','Would','Should','Will','I','Yesterday','Tomorrow','Today','Meanwhile','Elsewhere','Later',
]);

function normalize(text) { return String(text || '').replace(/\s+/g, ' ').trim(); }
function words(text) {
    const value=normalize(text).toLowerCase();
    const raw=value.match(/[\p{L}\p{N}][\p{L}\p{N}'_-]*/gu)||[];
    const tokens=[];
    for(const token of raw){
        if(/^[a-z0-9'_-]+$/.test(token)){if(token.length>2)tokens.push(token);continue;}
        const chars=[...token].filter(ch=>/[\p{L}\p{N}]/u.test(ch));
        if(chars.length<=4){if(chars.length)tokens.push(chars.join(''));continue;}
        for(let i=0;i<=chars.length-3&&i<96;i++)tokens.push(chars.slice(i,i+3).join(''));
    }
    return new Set(tokens);
}
function jaccard(a, b) {
    if (!a.size && !b.size) return 0;
    let hit = 0;
    for (const item of a) if (b.has(item)) hit += 1;
    return hit / Math.max(1, a.size + b.size - hit);
}

// Dialogue often contains plans or recalled locations ("we'll go to the Guild",
// "Floor 18 was bad") that must not be mistaken for a completed scene move.
// Hard transition detection therefore reasons over narrative text first.  The
// original text is still used for lexical continuity and explicit [SCENE]-style
// controls.
function stripQuotedSpeech(text) {
    return String(text || '')
        .replace(/"[^"\n]*(?:"|$)/g, ' ')
        .replace(/“[^”\n]*(?:”|$)/g, ' ')
        .replace(/「[^」\n]*(?:」|$)/g, ' ')
        .replace(/『[^』\n]*(?:』|$)/g, ' ')
        .replace(/‘[^’\n]*(?:’|$)/g, ' ')
        .replace(/(^|[\s([{—-])'[^'\n]{2,}'(?=$|[\s).,!?:;\]}—-])/g, '$1 ')
        .replace(/\s+/g, ' ')
        .trim();
}

const NON_ACTUAL_ENGLISH = /\b(?:if|unless|imagine|suppose|what\s+if|might|may|could|would|should|will|shall|(?:i|we|you|he|she|they)[’']ll|won[’']t|wouldn[’']t|couldn[’']t|shouldn[’']t|can[’']t|cannot|didn[’']t|doesn[’']t|do\s+not|does\s+not|did\s+not|not|never|almost|nearly|tr(?:y|ies|ied)\s+to|attempt(?:s|ed)?\s+to|refus(?:e|es|ed)\s+to|declin(?:e|es|ed)\s+to|going\s+to|about\s+to|plans?\s+to|intends?\s+to|hopes?\s+to|wants?\s+to|wanted\s+to|tomorrow|yesterday|last\s+(?:night|week|month|year)|previously|earlier\s+that\s+day|used\s+to|remember(?:ed)?\s+when|recall(?:ed)?\s+when|reported\s+that|said\s+that|told\s+us\s+that|when\b[^.!?]{0,48}\b(?:starts?|begins?|ends?|finishes|concludes))\b/i;
const NON_ACTUAL_CJK = /(?:もし|仮に|なら|たら|予定|つもり|明日|昨日|先週|以前|もしも|如果|假如|倘若|将会|將會|打算|计划|計劃|明天|昨天|上周|以前)/u;
function actualNarrativeOnly(text) {
    return String(text || '').split(/(?<=[.!?。！？])\s*/u).map(sentence=>{
        const trimmed=sentence.trim();
        if(!trimmed)return '';
        if(/[?？]\s*$/.test(trimmed))return '';
        if(NON_ACTUAL_ENGLISH.test(trimmed)||NON_ACTUAL_CJK.test(trimmed))return '';
        return trimmed;
    }).filter(Boolean).join(' ');
}
function durableActualNarrative(text){
    const source=String(text||'');
    return source.split(/(?<=[.!?。！？])\s*/u).map(sentence=>{
        const trimmed=sentence.trim();
        if(!trimmed||/[?？]\s*$/.test(trimmed))return '';
        if(/\b(?:if|unless|imagine|suppose|what\s+if|might|may|could|would|should|will|shall|(?:i|we|you|he|she|they)[’']ll|going\s+to|about\s+to|plans?\s+to|intends?\s+to|hopes?\s+to|tomorrow|almost|nearly|tr(?:y|ies|ied)\s+to|attempt(?:s|ed)?\s+to)\b/i.test(trimmed)||/(?:もし|仮に|なら|たら|予定|つもり|明日|如果|假如|倘若|将会|將會|打算|计划|計劃|明天)/u.test(trimmed))return '';
        if(/(?:\b(?:not|never|refus(?:e|es|ed|ing)|declin(?:e|es|ed|ing)|didn['’]?t|doesn['’]?t|won['’]?t|wouldn['’]?t)\b|(?:ない|なかった|拒否|拒絶|不|没有|沒有|拒绝|拒絕))/iu.test(trimmed))return '';
        const historical=/\b(?:yesterday|last\s+(?:night|week|month|year)|previously|used\s+to|remember(?:ed)?\s+when|recall(?:ed)?\s+when|reported\s+that|said\s+that)\b/i.test(trimmed);
        const literalDeath=/\b(?:dies|died|dead|killed|passes?\s+away)\b/i.test(trimmed);
        if(historical&&!literalDeath)return '';
        return trimmed;
    }).filter(Boolean).join(' ');
}

function destinationCore(destination) {
    let compact = normalize(destination).replace(/[,;:—-].*$/, '').trim();
    // Stop a destination before ordinary same-scene continuation predicates
    // ("into the kitchen and keeps talking"). Preserve chained relocation
    // prepositions such as "out of X and into Y" for the movement analyzer.
    compact=compact.replace(/\s+and\s+(?!(?:to|into|inside|outside|toward|towards|at)\b)(?:keeps?|continues?|starts?|begins?|says?|speaks?|talks?|looks?|smiles?|nods?|waits?|sits?|stands?|turns?|opens?|closes?)\b.*$/i,'').trim();
    if (!compact) return '';
    // Drop a trailing purpose clause from a destination ("to the Guild to file
    // the report") so the semantic head remains the place, not the purpose.
    const purpose = compact.match(/\s+to\s+([a-z][a-z'-]*)\b/i);
    if (purpose && PURPOSE_INFINITIVES.has(String(purpose[1] || '').toLowerCase())) {
        compact = compact.slice(0, purpose.index).trim();
    }
    return compact;
}

function destinationHead(destination) {
    const core = destinationCore(destination)
        .replace(/^(?:the|a|an|this|that|his|her|their|our|my)\s+/i, '')
        .trim();
    const tokens = core.toLowerCase().match(/[a-z0-9][a-z0-9'-]*/g) || [];
    return tokens.at(-1) || '';
}

function localDestinationDetected(destination) {
    const head = destinationHead(destination);
    return Boolean(head && LOCAL_DESTINATION_HEADS.has(head));
}

function novelNamedDestinationDetected(destination, recentText = '') {
    const core = destinationCore(destination);
    const names = [...core.matchAll(/\b[A-Z][A-Za-z0-9'-]{2,}\b/g)].map(match => match[0]);
    if (!names.length) return false;
    const recent = String(recentText || '').toLowerCase();
    // If every named component is already part of the current scene evidence,
    // treat it as an existing local anchor rather than a novel venue by name.
    return !names.every(name => recent.includes(name.toLowerCase()));
}

function knownContainerParentDetected(destination, recentText = '') {
    const core = destinationCore(destination)
        .replace(/^(?:the|a|an|this|that|his|her|their|our|my)\s+/i, '')
        .trim();
    const tokens = core.toLowerCase().match(/[a-z0-9][a-z0-9'-]*/g) || [];
    if (tokens.length < 2) return false;
    const parentTokens = tokens.slice(0, -1);
    const parentHead = parentTokens.at(-1) || '';
    if (!CONTAINER_DESTINATION_HEADS.has(parentHead)) return false;
    const parentPhrase = parentTokens.join(' ');
    return String(recentText || '').toLowerCase().includes(parentPhrase);
}

function structuralDestinationDetected(destination, verb = '', recentText = '') {
    const compact = destinationCore(destination);
    if (!compact) return false;
    const head = destinationHead(compact);
    // A local semantic head usually wins over a venue modifier: "hospital
    // bed", "school hallway", "hotel lobby", and "dungeon corridor" are
    // local choreography. Ambiguous facility heads such as "library" become
    // structural only when their proper/named venue is novel to the scene.
    if (head && LOCAL_DESTINATION_HEADS.has(head)) {
        if (AMBIGUOUS_FACILITY_HEADS.has(head)) {
            if (knownContainerParentDetected(compact, recentText)) return false;
            if (novelNamedDestinationDetected(compact, recentText)) return true;
            const recent = String(recentText || '').toLowerCase();
            // Facility nouns such as "office", "library", and "lab" can be
            // either a room inside the current venue or a new venue. If the
            // facility (or an explicit container parent such as "Hearth Manor")
            // is already part of recent scene evidence, keep it local; otherwise
            // an explicit locomotion verb is enough to treat it as structural.
            if (verb && !recent.includes(head)) return true;
        }
        return false;
    }
    if (STRUCTURAL_DESTINATION_PATTERN.test(compact)) return true;
    if (head && STRUCTURAL_DESTINATION_HEADS.has(head)) return true;
    // A novel proper destination is a plausible venue/domain boundary. If that
    // same name already exists in current scene evidence it may be a person or
    // local anchor, so do not promote it on capitalization alone.
    if (novelNamedDestinationDetected(compact, recentText)) return true;
    // Strong relocation verbs may identify an unfamiliar venue that is not in
    // any fixed vocabulary ("head to the meadow", "follow them to the bunker").
    if (STRONG_RELOCATION_VERB_PATTERN.test(String(verb || '').trim())) {
        const nounish = compact.toLowerCase()
            .replace(/^(?:the|a|an|this|that|his|her|their|our|my)\s+/, '')
            .match(/^([a-z][a-z0-9'-]{2,})/)?.[1] || '';
        if (nounish && !PURPOSE_INFINITIVES.has(nounish) && !DISCOURSE_LOCATIONS.has(nounish)) return true;
    }
    return false;
}

function destinationLooksSpatial(destination, verb = '', recentText = '', preposition = '') {
    const compact = destinationCore(destination);
    if (!compact) return false;
    const head = destinationHead(compact);
    if (!head) return false;
    if (DISCOURSE_LOCATIONS.has(head) || NON_SPATIAL_DESTINATION_HEADS.has(head)) return false;

    const lower = compact.toLowerCase()
        .replace(/^(?:the|a|an|this|that|his|her|their|our|my)\s+/, '')
        .trim();
    const tokens = lower.match(/[a-z0-9][a-z0-9'-]*/g) || [];
    const first = tokens[0] || '';
    if (NON_SPATIAL_DESTINATION_HEADS.has(first) || DISCOURSE_LOCATIONS.has(first)) return false;

    // Positive place evidence always wins before we inspect whether the phrase
    // merely *looks* noun-like. This keeps real locations such as "dining room"
    // legal even though their first token resembles a gerund.
    const explicitPlace = LOCAL_DESTINATION_HEADS.has(head)
        || STRUCTURAL_DESTINATION_HEADS.has(head)
        || STRUCTURAL_DESTINATION_PATTERN.test(compact)
        || novelNamedDestinationDetected(compact, recentText)
        || knownContainerParentDetected(compact, recentText);

    // HOTFIX28: RP prose regularly places an adverbial/participial clause after
    // locomotion ("Beta stepped inside still wearing the maid uniform") or a
    // purpose clause after "to" ("her gaze crossed to rearrange itself").
    // Those clauses are not destinations and must never manufacture a scene move.
    const continuationClause = /^(?:still|already|just|while|as|now|then)\b/i.test(lower)
        || (/^[a-z][a-z'-]*ing\b/i.test(lower) && !explicitPlace)
        || (String(preposition).toLowerCase() === 'to' && (
            PURPOSE_INFINITIVES.has(first)
            || /^[a-z][a-z'-]*\s+(?:myself|yourself|yourselves|himself|herself|itself|ourselves|themselves|me|him|her|us|them)\b/i.test(lower)
            || /^(?:rearrange|reorganize|rewrite|reframe|reconsider|review|compare|assess|evaluate|examine|inspect|analy[sz]e|adjust|change|respond|reply|answer|continue|resume|finish|complete|prepare|pack|unpack|dress|undress|wear|hold|carry)\b/i.test(lower)
        ));
    if (continuationClause && !explicitPlace) return false;

    // Direct-object motion is only spatial when the object itself looks like a
    // place. This rejects placement/transitive senses such as "left his cup"
    // and "walk her through the plan" while retaining "left the room",
    // "go upstairs", and named/known venues.
    if (String(preposition) === 'direct') {
        if (/^(?:him|her|them|me|us|you)\b/i.test(compact)) return false;
        const directTokens = lower.match(/[a-z0-9][a-z0-9'-]*/g) || [];
        if (/^(?:through|over|on|off|back)\b/i.test(lower)) {
            const semantic = directTokens.find(token => !['through','over','on','off','back','the','a','an','again','one','more','time'].includes(token)) || '';
            if (!semantic || NON_SPATIAL_DESTINATION_HEADS.has(semantic) || DISCOURSE_LOCATIONS.has(semantic)) return false;
        }
        if (explicitPlace) return true;
        if (/^(?:upstairs|downstairs|indoors|outdoors|home|work)$/i.test(lower)) return true;
        return false;
    }

    if (explicitPlace) return true;

    // For explicit spatial prepositions, an ordinary noun phrase can be a
    // previously unseen place ("to the meadow", "through the courtyard").
    // Require a locomotion predicate plus a compact noun-like destination, and
    // reject abstract/discourse/continuation clauses above.
    if (/^(?:to|into|inside|outside|through|across|toward|towards|out of|at)$/i.test(String(preposition || ''))
        && /^(?:arriv|enter|depart|leave|left|return|come|came|descend|ascend|travel|drive|drove|fly|flew|sail|commut|hike|head|walk|step|move|go|went|cross|pass|run|ran|ride|rode|climb|follow|accompan|escort|lead|led|take|took|bring|brought|make)/i.test(String(verb || '').trim())
        && tokens.length > 0 && tokens.length <= 8) {
        return true;
    }
    return false;
}

function analyzeSpatialMovement(text, recentText = '') {
    const narrative = String(text || '');
    MOTION_VERB_PATTERN.lastIndex = 0;
    let match;
    let local = null;
    while ((match = MOTION_VERB_PATTERN.exec(narrative))) {
        const sentenceStart = Math.max(narrative.lastIndexOf('.', match.index), narrative.lastIndexOf('!', match.index), narrative.lastIndexOf('?', match.index), narrative.lastIndexOf('\n', match.index)) + 1;
        const leadRaw = narrative.slice(sentenceStart, match.index);
        const lead = leadRaw.toLowerCase();
        const verbText = String(match[0] || '').trim();
        // Negated/non-occurring locomotion is not a completed scene move.
        const immediateLead = narrative.slice(Math.max(sentenceStart, match.index - 28), match.index).toLowerCase();
        if (/(?:\bwithout|\bnot|\bnever)\s+$/.test(immediateLead)) continue;
        // Bare "head" is also a body-part noun. Accept it as locomotion only
        // when it is grammatically acting as the predicate ("we head to..."),
        // not in phrases such as "from head to toe" or "turns his head to...".
        if (verbText.toLowerCase() === 'head') {
            const actorLead = leadRaw.trim();
            const pronounPredicate = /(?:^|\s)(?:i|we|you|he|she|they)$/.test(actorLead.toLowerCase());
            const namedPredicate = /(?:^|\s)[A-Z][a-z][A-Za-z'-]{1,31}$/.test(actorLead);
            if (!pronounPredicate && !namedPredicate) continue;
        }
        // Future plans are not completed scene transitions. Explicit later/next
        // scene setters are handled independently by TIME_SHIFT_PATTERN.
        if (/\b(?:will|would|should|could|might|may)\s*$/.test(lead)
            || /\b(?:plan(?:s|ned)?|want(?:s|ed)?|need(?:s|ed)?|intend(?:s|ed)?|hope(?:s|d)?)\s+to\s*$/.test(lead)
            || /\btomorrow\b/.test(lead)) continue;
        const tail = narrative.slice(match.index + match[0].length, match.index + match[0].length + 180);
        const directCapable = /^(?:enter|leave|left|exit|return|go|went|come|came|drive|drove|ride|rode|walk|run|ran|fly|flew|travel)/i.test(verbText);
        const immediatePrep = tail.match(/^\s*(to|into|inside|outside|through|across|toward|towards|out\s+of|at)\b\s*([^.!?\n]{0,80})/i);
        let prep = immediatePrep;
        let preposition = '';
        let destination = '';

        // Prefer a direct destination when the verb supports it and no spatial
        // preposition begins the phrase. This handles "leave home" and "go
        // upstairs to keep talking" without stealing a later purpose clause.
        if (!immediatePrep && directCapable) {
            const direct = tail.match(/^\s+(?:the\s+|a\s+|an\s+|his\s+|her\s+|their\s+|our\s+|my\s+)?([^.!?,;:]{1,80}?)(?=\s+(?:and|while|then|before|after|where|who|that)\b|[.!?,;:]|$)/i);
            if (direct) {
                preposition = 'direct';
                destination = String(direct[1] || '').trim();
            }
        }

        // Transitive movement such as "take Maya to the hospital" or "follow
        // Jordan to the station" may have an object before the destination, so
        // search later in the clause only when no direct destination was found.
        if (!destination) {
            prep ||= tail.match(SPATIAL_PREPOSITION_PATTERN);
            if (!prep) continue;
            const between = tail.slice(0, prep.index || 0);
            // Do not let a second sentence donate a destination to a movement verb
            // from the previous sentence.
            if (/[.!?\n]/.test(between)) continue;
            preposition = String(prep[1] || '').toLowerCase().replace(/\s+/g, ' ');
            destination = String(prep[2] || '').trim();
        }
        const discourseDestination = destinationCore(destination).toLowerCase();
        const verbLower = verbText.toLowerCase();
        // Discourse idioms and transitive possession are not completed travel.
        // Examples: "Go on.", "go over the notes", "head back to the topic",
        // and "left his cup". Require positive destination evidence instead.
        if (/^go(?:es|ing)?$|^went$/.test(verbLower) && /^(?:on|over\b|back\s+to\s+(?:the\s+)?(?:topic|subject|notes?|plan|issue|question|point|discussion|conversation)\b)/i.test(discourseDestination)) continue;
        if (/^head(?:s|ed|ing)?$/.test(verbLower) && /^back\s+to\s+(?:the\s+)?(?:topic|subject|notes?|plan|issue|question|point|discussion|conversation)\b/i.test(discourseDestination)) continue;
        if (/^(?:leave|leaves|leaving|left)$/.test(verbLower) && preposition === 'direct' && /^\s*(?:his|her|their|our|my)\b/i.test(tail)) continue;

        if (preposition === 'to') {
            const core = destinationCore(destination);
            const first = core.toLowerCase().match(/^([a-z][a-z'-]*)/)?.[1] || '';
            const tokenCount = core.toLowerCase().match(/[a-z0-9][a-z0-9'-]*/g)?.length || 0;
            // "follow Neith to understand her reasoning" is purpose, not travel.
            // A single destination noun such as "work" remains legal even when
            // that word can also be a verb.
            if (PURPOSE_INFINITIVES.has(first) && tokenCount > 1) continue;
            if (!destination) continue;
        }
        if (!destinationLooksSpatial(destination, verbText, recentText, preposition)) continue;
        const detail = { verb: verbText, preposition, destination };
        const chained=destination.match(/\band\s+(?:then\s+)?(?:to|into|inside|outside|toward|towards|at)\s+([^.!?,;:]{1,80})/i);
        if(chained&&structuralDestinationDetected(chained[1],detail.verb,recentText))return {detected:true,structural:true,...detail,destination:String(chained[1]).trim(),chained:true};
        if (structuralDestinationDetected(destination, detail.verb, recentText)) return { detected: true, structural: true, ...detail };
        local ||= { detected: true, structural: false, ...detail };
    }
    return local || { detected: false, structural: false, verb: '', preposition: '', destination: '' };
}

function analyzeSceneSetter(text, recentText = '') {
    const narrative = String(text || '').trim();
    const recent = String(recentText || '').toLowerCase();
    const explicitCut=narrative.match(/^(?:\*+\s*)?(?:cut\s+to|the\s+scene\s+(?:cuts?|shifts?|moves?)\s+to)\s+(?:the\s+)?([^,.;:—]{1,64})(?:\s*[,.;:—]|$)/i);
    const nowAt=narrative.match(/^(?:\*+\s*)?we\s+are\s+now\s+(?:at|in|inside|outside)\s+(?:the\s+)?([^,.;:—]{1,64})(?:\s*[,.;:—]|$)/i);
    const match = narrative.match(/^(?:\*+\s*)?(?:(meanwhile|elsewhere)\s*,?\s*)?(?:(back|now)\s+)?(at|in|inside|outside|within)\s+(?:the\s+)?([^,.;:—]{1,64})\s*[,.;:—]/i);
    if (!match&&!explicitCut&&!nowAt) return { detected: false, structural: false, phrase: '' };
    const phraseRaw = normalize(explicitCut?.[1]||nowAt?.[1]||match?.[4]);
    const phrase = phraseRaw.toLowerCase();
    if (!phrase || DISCOURSE_LOCATIONS.has(phrase)) return { detected: false, structural: false, phrase: phraseRaw };
    if ([...DISCOURSE_LOCATIONS].some(item => phrase.startsWith(`${item} `))) return { detected: false, structural: false, phrase: phraseRaw };
    // Explicit `now/back` reanchors are structural authority even when the
    // location name appeared topically in recent context. A plain restatement
    // without a reanchor remains continuity.
    const perspectiveCut = Boolean(explicitCut||match?.[1]);
    const backOrNow = Boolean(nowAt||match?.[2]);
    if (recent.includes(phrase) && !perspectiveCut && !backOrNow) return { detected: false, structural: false, phrase: phraseRaw, restated: true };
    // "Meanwhile" / "elsewhere" explicitly changes scene perspective even if
    // the named place is local. Otherwise local room/area setters are MINOR,
    // while named/venue/domain setters are MAJOR.
    const namedPlace = novelNamedDestinationDetected(phraseRaw, recentText) && !localDestinationDetected(phraseRaw);
    const structural = perspectiveCut || backOrNow || structuralDestinationDetected(phraseRaw, '', recentText) || namedPlace;
    return { detected: true, structural, phrase: phraseRaw, perspectiveCut, backOrNow };
}

function durableStateBoundaryDetected(text) {
    const narrative = durableActualNarrative(text);
    if (!narrative) return false;
    if(/\b(?:nearly|almost)\s+died\b|\bdied\s+(?:laughing|inside|a\s+little|a\s+bit)\b|\bdied\s+of\s+(?:embarrassment|laughter|shame)\b/i.test(narrative))return false;
    if (STRONG_DURABLE_STATE_BOUNDARY_PATTERN.test(narrative)) return true;
    if (LITERAL_DEATH_STATE_PATTERN.test(narrative)) return true;
    if (!DEATH_WORD_PATTERN.test(narrative)) return false;
    if (LITERAL_DEATH_CAUSE_PATTERN.test(narrative)||LITERAL_DEATH_EVENT_PATTERN.test(narrative)||LITERAL_DEATH_RECOVERY_PATTERN.test(narrative)||THIRD_PERSON_BARE_DEATH_PATTERN.test(narrative)) return true;
    // Literal named/pronoun death may occur after another clause in the same
    // sentence ("Ais collapses ... and dies"). Keep object failures out by
    // requiring a person-like subject rather than a generic noun phrase.
    const personDeath=narrative.match(/(?:^|[.!?]\s+)([A-Z][a-z][A-Za-z'’-]{1,31}|he|she|they)\b[^.!?]{0,96}\b(?:dies|died)\b/i);
    if(!personDeath)return false;
    const subject=String(personDeath[1]||'');
    return /^(?:he|she|they)$/i.test(subject)||!IGNORED_NAMES.has(subject);
}

function participantBoundaryDetected(text, recentText = '') {
    const narrative = actualNarrativeOnly(text);
    if(!narrative)return false;
    if (EXPLICIT_PARTICIPANT_JOIN_PATTERN.test(narrative) || EXPLICIT_PARTICIPANT_LEAVE_PATTERN.test(narrative)) return true;
    if (BARE_PARTICIPANT_EXIT_PATTERN.test(narrative) || PRONOUN_SCENE_ENTRY_PATTERN.test(narrative) || GENERIC_PARTICIPANT_ENTRY_PATTERN.test(narrative)) return true;

    const namedExit = narrative.match(NAMED_PARTICIPANT_EXIT_PATTERN);
    if (namedExit) {
        const departing = String(namedExit[1] || '').toLowerCase();
        if (departing && String(recentText || '').toLowerCase().includes(departing)) return true;
    }

    const named = narrative.match(NAMED_PARTICIPANT_ENTRY_PATTERN);
    if (!named) return false;
    const name = String(named[1] || '');
    const verb = String(named[2] || '').toLowerCase();
    const recent = String(recentText || '').toLowerCase();

    // A named person explicitly joining/arriving into the current beat is a
    // topology change when they were not already part of recent scene evidence.
    // If the same named actor is already active, local movement such as
    // "Maya enters the kitchen" is choreography and is handled by the spatial
    // classifier instead of being promoted to MAJOR merely because "enters"
    // appeared in the sentence. Bare arrival idioms remain structural.
    if (/^(?:join|rejoin|arriv|return|shows?\s+up|appears?)/i.test(verb)) return true;
    if (/^(?:steps?\s+into|walks?\s+into|comes?\s+into)/i.test(verb)) {
        // Destination-bearing entry is participant arrival only when the named
        // actor was not already active in the recent scene. Existing actors
        // crossing a room boundary remain local choreography.
        return !recent.includes(name.toLowerCase());
    }
    if (/^(?:arriv|steps?\s+in|walks?\s+in|comes?\s+in)/i.test(verb)) {
        if (!recent.includes(name.toLowerCase())) return true;
        return /(?:[.!?,;:]|$)/.test(narrative.slice((named.index || 0) + named[0].length).trim());
    }
    return !recent.includes(name.toLowerCase());
}

function detectRetrievalSignalProfile({ currentText = '', recentText = '' } = {}) {
    const current = normalize(currentText);
    const narrative = stripQuotedSpeech(current);
    const actualNarrative = actualNarrativeOnly(narrative);
    const hardSignals = [];
    const softSignals = [];
    const details = {};
    if (EXPLICIT_SCENE_PATTERN.test(narrative)) hardSignals.push('explicit-scene-boundary');
    if (TIME_SHIFT_PATTERN.test(actualNarrative) || CJK_TIME_SHIFT_PATTERN.test(actualNarrative) || SPANISH_TIME_SHIFT_PATTERN.test(actualNarrative)) hardSignals.push('time-shift');
    if (SCENE_RESET_PATTERN.test(actualNarrative) || CJK_SCENE_RESET_PATTERN.test(actualNarrative)) hardSignals.push('location-reset');
    if (CJK_RELOCATION_VERB_PATTERN.test(actualNarrative) && CJK_STRUCTURAL_DESTINATION_PATTERN.test(actualNarrative)) hardSignals.push('structural-relocation');
    if (SPANISH_RELOCATION_VERB_PATTERN.test(actualNarrative) && SPANISH_STRUCTURAL_DESTINATION_PATTERN.test(actualNarrative)) hardSignals.push('structural-relocation');
    if (CJK_PARTICIPANT_BOUNDARY_PATTERN.test(actualNarrative)) hardSignals.push('participant-boundary');
    const sceneSetter = analyzeSceneSetter(actualNarrative, recentText);
    if (sceneSetter.detected) {
        details.sceneSetter = sceneSetter;
        if (sceneSetter.structural) hardSignals.push('location-reset');
        else softSignals.push('local-location-shift');
    }
    const movement = analyzeSpatialMovement(actualNarrative, recentText);
    if (movement.detected) {
        details.spatial = movement;
        if (movement.structural) {
            // Keep the historical structural-relocation diagnostic while also
            // emitting the stable scene-hinge name consumed by Test Mode and
            // acceptance evidence. A completed structural relocation is still
            // spatial movement; the extra label is an alias, not a second gate.
            hardSignals.push('structural-relocation', 'spatial-movement');
        } else softSignals.push('spatial-movement');
    }
    if (participantBoundaryDetected(actualNarrative, recentText)) hardSignals.push('participant-boundary');
    if (PROGRESSION_PATTERN.test(actualNarrative)) hardSignals.push('progression-boundary');
    if (ACTIVITY_BOUNDARY_PATTERN.test(actualNarrative)) hardSignals.push('activity-boundary');
    if (durableStateBoundaryDetected(narrative)) hardSignals.push('durable-state-boundary');
    if (FOCUS_SHIFT_PATTERN.test(narrative) || EXPLICIT_FOCUS_DELTA_PATTERN.test(narrative)) softSignals.push('focus-shift');
    return {
        hardSignals: [...new Set(hardSignals)],
        softSignals: [...new Set(softSignals)],
        details,
    };
}

export function detectRetrievalTransitionSignals({ currentText = '', recentText = '' } = {}) {
    const profile = detectRetrievalSignalProfile({ currentText, recentText });
    return [...new Set([...profile.hardSignals, ...profile.softSignals])];
}

export function extractLikelyNamedTokens(text) {
    const found = new Set();
    const add = token => { if (token && !IGNORED_NAMES.has(token)) found.add(token); };
    const narrative = stripQuotedSpeech(text);
    // Preserve the scene-bearing grammar of the original detector while making
    // the actual proper-name capture Unicode-aware. Generic sentence-initial
    // capitalized words remain excluded.
    for (const match of narrative.matchAll(/(?:^|[.!?]\s+)\s*([\p{Lu}][\p{Ll}\p{M}]{2,}(?:[’'-][\p{Lu}]?[\p{Ll}\p{M}]+)*)\s*,/gu)) add(match[1]);
    for (const match of narrative.matchAll(/(?:^|[^\p{L}\p{M}])(?:asks?|tells?|calls?|joins?|follows?|greets?|meets?|approaches?|escorts?|accompanies?)\s+([\p{Lu}][\p{Ll}\p{M}]{2,}(?:[’'-][\p{Lu}]?[\p{Ll}\p{M}]+)*)(?=$|[^\p{L}\p{M}])/gu)) add(match[1]);
    return [...found];
}

export function classifyRetrievalChange({ currentText = '', recentText = '', hasReusableInjection = false, hasSceneContext = false, disabled = false } = {}) {
    const current = normalize(currentText);
    const recent = normalize(recentText);

    // Change Gate owns narrative semantics only. Cache/injection availability is
    // never authority to manufacture NO/MINOR/MAJOR. A cold bootstrap therefore
    // means "no observed narrative transition yet" (NO_CHANGE); the Retrieval
    // planner independently chooses INITIAL_FULL when no validated injection exists.
    // Reusable injection is accepted here only as a legacy indication that a
    // prior scene baseline exists for direct classifier callers. It does not
    // influence the selected mode. Production callers supply hasSceneContext.
    const hasBaselineContext = hasSceneContext === true || hasReusableInjection === true;
    const coldStart = !hasBaselineContext;
    const baselineMeta = {
        coldStart,
        hydratedScene: hasSceneContext === true,
    };
    if (disabled) {
        return {
            mode: RETRIEVAL_CHANGE.NO_CHANGE,
            reason: 'change gate disabled; semantic classification bypassed',
            confidence: 1,
            signals: ['change-gate-disabled'],
            classificationDisabled: true,
            ...baselineMeta,
        };
    }
    if (coldStart) {
        return {
            mode: RETRIEVAL_CHANGE.NO_CHANGE,
            reason: 'cold scene baseline; no narrative transition can be established yet',
            confidence: 1,
            signals: ['cold-scene-baseline'],
            ...baselineMeta,
        };
    }
    if (!current) {
        return {
            mode: RETRIEVAL_CHANGE.MINOR_CHANGE,
            reason: 'hydrated scene exists but latest narrative beat is unresolved; targeted safety refresh',
            confidence: 0.7,
            ...baselineMeta,
        };
    }
    if (hasSceneContext === true && !recent) {
        return {
            mode: RETRIEVAL_CHANGE.NO_CHANGE,
            reason: 'initial hydrated scene baseline; no prior narrative transition to classify',
            confidence: 1,
            signals: ['initial-scene-baseline'],
            ...baselineMeta,
        };
    }

    const profile = detectRetrievalSignalProfile({ currentText: current, recentText: recent });
    const hardSignals = profile.hardSignals;
    const softSignals = profile.softSignals;
    const signals = [...hardSignals, ...softSignals];
    if (hardSignals.length) {
        return {
            mode: RETRIEVAL_CHANGE.MAJOR_CHANGE,
            reason: `scene topology transition detected (${hardSignals.join(', ')})`,
            confidence: 0.95,
            signals,
            hardSignals,
            softSignals,
            signalDetails: profile.details,
            ...baselineMeta,
        };
    }

    const overlap = jaccard(words(current), words(recent));
    const recentLower = recent.toLowerCase();
    const newNames = extractLikelyNamedTokens(current).filter(name => !recentLower.includes(name.toLowerCase()));
    if (newNames.length) {
        profile.details.namedFocus = { names: newNames.slice(0, 4) };
        const directVocative = /^\s*(?:\*+\s*)?[\p{Lu}][\p{L}\p{M}’'-]{1,31}(?:\s+[\p{Lu}][\p{L}\p{M}’'-]{1,31}){0,2}\s*,/u.test(current);
        // A direct, newly addressed actor on a very-low-overlap turn is a real
        // foreground participant/focus boundary even when the text omits an
        // explicit "joins the scene" verb. This is intentionally narrower than
        // ordinary name/topic mentions such as "about Rowan's report".
        if (directVocative && overlap < 0.08) {
            const promotedSignals = [...new Set([...signals, 'active-participant-shift'])];
            return {
                mode: RETRIEVAL_CHANGE.MAJOR_CHANGE,
                reason: 'active participant shifted on a low-overlap scene beat',
                confidence: 0.9,
                signals: promotedSignals,
                hardSignals: [...new Set([...hardSignals, 'active-participant-shift'])],
                softSignals,
                signalDetails: profile.details,
                ...baselineMeta,
            };
        }
        // Otherwise a newly addressed/named person is evidence that focus may
        // have moved, but not proof that participant topology changed.
        softSignals.push('participant-focus-shift');
        signals.push('participant-focus-shift');
    }

    const hasMetaBracket = /^\s*\[[^\]]+\]/.test(current);
    const isQuestion = current.includes('?');
    const isLargeTurn = current.length > 360;
    // Length and punctuation are weak stylistic evidence, never authority to
    // deny reuse. Hard/soft scene signals above decide whether topology/focus
    // changed; an otherwise stable question or long continuation may reuse.
    const stableContinuation = !hasMetaBracket;

    // A near-identical stable continuation can contain incidental focus wording
    // ("asks Zareth about Rowan's report") without changing what the current
    // scene needs. Do not let that single weak signal starve NO_CHANGE. Real
    // questions, longer developments, participant shifts, movement and other
    // soft signals remain MINOR or MAJOR as appropriate.
    const focusOnlyStableContinuation = stableContinuation
        && !EXPLICIT_FOCUS_DELTA_PATTERN.test(current)
        && overlap >= 0.6
        && softSignals.length === 1
        && softSignals[0] === 'focus-shift';

    // Local choreography/environment movement changes scene focus without
    // invalidating the prior region topology. Treat it as a targeted MINOR
    // refresh, never a full regional reroute by itself.
    if (softSignals.length && !focusOnlyStableContinuation) {
        return {
            mode: RETRIEVAL_CHANGE.MINOR_CHANGE,
            reason: `same scene topology with local focus/environment delta (${softSignals.join(', ')})`,
            confidence: 0.82,
            signals,
            hardSignals,
            softSignals,
            signalDetails: profile.details,
            ...baselineMeta,
        };
    }

    const acknowledgement = ACKNOWLEDGEMENT_PATTERN.test(current);
    const pronounContinuation = PRONOUN_CONTINUATION_PATTERN.test(current);
    const namedRpContinuation = NAMED_RP_CONTINUATION_PATTERN.test(current);
    const quotedDialogue = QUOTED_DIALOGUE_PATTERN.test(current) || /^\s*["“]/.test(current);
    const explicitStability = EXPLICIT_STABILITY_PATTERN.test(current);

    // NO_CHANGE is a retrieval-stability decision, not a prose-shape decision.
    // Questions and long turns are therefore eligible when the existing scene
    // evidence remains strong enough. Length lowers confidence when continuity
    // evidence is weak, but it is never a categorical exclusion.
    let continuityScore = 0;
    if (overlap >= 0.35) continuityScore += 3;
    else if (overlap >= 0.18) continuityScore += 2;
    else if (overlap >= 0.10) continuityScore += 1;
    if (acknowledgement) continuityScore += 4;
    if (explicitStability) continuityScore += 2;
    if (pronounContinuation) continuityScore += 1;
    if (namedRpContinuation) continuityScore += 2;
    if (quotedDialogue) continuityScore += 1;
    if (quotedDialogue && !isQuestion && current.length <= 220) continuityScore += 1;
    if (isQuestion && overlap >= 0.18) continuityScore += 1;
    if (isLargeTurn && !explicitStability && overlap < 0.3) continuityScore -= 1;

    if (!hasMetaBracket && continuityScore >= 2) {
        const form = isQuestion ? 'question' : isLargeTurn ? 'long continuation' : quotedDialogue ? 'dialogue continuation' : 'continuation';
        const reason = `stable ${form}; scene continuity preserved (lexical overlap ${overlap.toFixed(2)}, continuity ${continuityScore})`;
        return {
            mode: RETRIEVAL_CHANGE.NO_CHANGE,
            reason,
            confidence: Math.min(0.95, 0.74 + Math.max(0, continuityScore) * 0.04),
            ...baselineMeta,
        };
    }
    return {
        mode: RETRIEVAL_CHANGE.MINOR_CHANGE,
        reason: `same scene/topic with meaningful delta (lexical overlap ${overlap.toFixed(2)}, continuity ${continuityScore})`,
        confidence: 0.72,
        ...baselineMeta,
    };

}


let acceptedSceneGate = null;
// Foreground Retrieval consumes a semantic scene transition once per accepted
// Scene Scanner revision. Retrieval success/failure is execution state and must
// not resurrect the same MINOR/MAJOR semantic decision on retries or overlapping
// foreground generations. Other consumers continue to read acceptedSceneGate.
let retrievalTransitionConsumption = null;

function sceneDeltaChanged(delta, key) {
    return delta?.[key]?.changed === true;
}

function sceneTimeText(value) {
    return String(value || '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

function sceneClockMinutes(value) {
    const text = sceneTimeText(value);
    const match = /\b(\d{1,2}):(\d{2})\s*(a\.?m\.?|p\.?m\.?)?\b/i.exec(text);
    if (!match) return null;
    let hour = Number(match[1]), minute = Number(match[2]);
    if (!Number.isInteger(hour) || !Number.isInteger(minute) || minute < 0 || minute > 59) return null;
    const suffix = String(match[3] || '').toLowerCase().replace(/\./g, '');
    if (suffix) {
        if (hour < 1 || hour > 12) return null;
        if (suffix === 'pm' && hour !== 12) hour += 12;
        if (suffix === 'am' && hour === 12) hour = 0;
    } else if (hour > 23) return null;
    return hour * 60 + minute;
}

function sceneTimePhase(value) {
    const text = sceneTimeText(value);
    if (/\b(dawn|early morning|morning)\b/.test(text)) return 'morning';
    if (/\b(noon|midday|afternoon|late afternoon)\b/.test(text)) return 'afternoon';
    if (/\b(dusk|evening|late evening)\b/.test(text)) return 'evening';
    if (/\b(midnight|night|overnight)\b/.test(text)) return 'night';
    return '';
}

function sceneTimeBoundary(delta) {
    const row = delta?.timeContext || {};
    if (row?.changed !== true) return false;
    const previous = sceneTimeText(row.previous);
    const current = sceneTimeText(row.current);
    if (!current || current === previous) return false;

    // Explicit discontinuities are topology. These are structured Scene Scanner
    // observations, not raw chat heuristics.
    if (/\b(next|following|tomorrow|yesterday)\b/.test(current)
        || /\b(?:hours?|days?|weeks?|months?|years?)\s+(?:later|after)\b/.test(current)
        || /\b(?:later|earlier)\s+(?:that|the)\s+(?:day|night|week|month|year)\b/.test(current)
        || /(?:翌日|次の日|翌朝|数時間後|数日後|次の朝|第二天|次日|翌晚|几小时后|幾小時後|几天后|幾天後)/u.test(current)) return true;

    const beforeClock = sceneClockMinutes(previous), afterClock = sceneClockMinutes(current);
    if (beforeClock !== null && afterClock !== null) {
        let diff = Math.abs(afterClock - beforeClock);
        diff = Math.min(diff, 1440 - diff);
        // Ordinary clock progression inside the same beat is drift, not a new
        // topology. A multi-hour jump is a genuine temporal boundary.
        if (diff <= 90) return false;
        if (diff >= 180) return true;
    }

    const beforePhase = sceneTimePhase(previous), afterPhase = sceneTimePhase(current);
    return Boolean(beforePhase && afterPhase && beforePhase !== afterPhase);
}

/**
 * Authoritative scene-delta classifier. The Scene Scanner owns observation;
 * Change Gate owns only the policy that maps observed deltas to
 * NO_CHANGE/MINOR_CHANGE/MAJOR_CHANGE. Raw prose is deliberately absent here.
 */
export function classifySceneDelta({ sceneScan = null, disabled = false } = {}) {
    const delta = sceneScan?.delta || {};
    const baselineMeta = {
        coldStart: sceneScan?.cold === true,
        hydratedScene: sceneScan?.cold !== true,
        sceneRevision: String(sceneScan?.scanRevision || ''),
    };
    if (disabled) {
        return {
            mode: RETRIEVAL_CHANGE.NO_CHANGE,
            reason: 'change gate disabled; scene delta classification bypassed',
            confidence: 1,
            signals: ['change-gate-disabled'],
            classificationDisabled: true,
            ...baselineMeta,
        };
    }
    if (!sceneScan || delta.initialBaseline === true || !sceneScan?.previousScene) {
        return {
            mode: RETRIEVAL_CHANGE.NO_CHANGE,
            reason: 'scene scanner established the accepted baseline; no prior scene delta exists',
            confidence: 1,
            signals: ['scene-baseline'],
            ...baselineMeta,
        };
    }
    if (delta.degraded === true || sceneScan?.degraded === true) {
        return {
            mode: RETRIEVAL_CHANGE.MINOR_CHANGE,
            reason: 'scene observation degraded; preserve topology and perform a targeted safety refresh',
            confidence: 0.7,
            signals: ['scene-scan-degraded'],
            hardSignals: [],
            softSignals: ['scene-scan-degraded'],
            ...baselineMeta,
        };
    }

    const hardSignals = [];
    const softSignals = [];
    if (sceneDeltaChanged(delta, 'participants')) hardSignals.push('participant-boundary');
    if (sceneDeltaChanged(delta, 'location')) hardSignals.push('location-boundary');
    if (sceneDeltaChanged(delta, 'activity')) hardSignals.push('activity-boundary');
    if (sceneDeltaChanged(delta, 'timeContext')) {
        if (sceneTimeBoundary(delta)) hardSignals.push('time-boundary');
        else softSignals.push('time-drift');
    }
    // Objective/focus are relevance/material changes inside a stable topology.
    // They require reselection, but do not by themselves create a MAJOR reroute.
    if (sceneDeltaChanged(delta, 'objective')) softSignals.push('objective-shift');
    if (sceneDeltaChanged(delta, 'focus')) softSignals.push('focus-shift');

    if (hardSignals.length) {
        return {
            mode: RETRIEVAL_CHANGE.MAJOR_CHANGE,
            reason: `scene scanner reported topology transition (${hardSignals.join(', ')})`,
            confidence: 0.97,
            signals: [...hardSignals, ...softSignals],
            hardSignals,
            softSignals,
            sceneDelta: delta,
            ...baselineMeta,
        };
    }
    if (softSignals.length) {
        return {
            mode: RETRIEVAL_CHANGE.MINOR_CHANGE,
            reason: `scene topology is stable but the immediate beat shifted (${softSignals.join(', ')})`,
            confidence: 0.88,
            signals: softSignals,
            hardSignals: [],
            softSignals,
            sceneDelta: delta,
            ...baselineMeta,
        };
    }
    return {
        mode: RETRIEVAL_CHANGE.NO_CHANGE,
        reason: 'scene scanner reports the same participants, location, activity, objective, and time context',
        confidence: 0.96,
        signals: [],
        hardSignals: [],
        softSignals: [],
        sceneDelta: delta,
        ...baselineMeta,
    };
}

export function evaluateSceneChange({ sceneScan = null, disabled = false, source = 'scene-scanner' } = {}) {
    const chatId = sceneScan?.chatId == null ? null : String(sceneScan.chatId);
    const sceneRevision = String(sceneScan?.scanRevision || '');
    // One scanner revision has one accepted semantic gate. Consumers may ask
    // for it repeatedly, but they cannot advance/reclassify the same scene.
    if (acceptedSceneGate && String(acceptedSceneGate.chatId ?? '') === String(chatId ?? '')
        && String(acceptedSceneGate.sceneRevision || '') === sceneRevision
        && Boolean(acceptedSceneGate.classificationDisabled) === (disabled === true)) {
        return { ...acceptedSceneGate };
    }
    const classification = classifySceneDelta({ sceneScan, disabled });
    const priorRevision = acceptedSceneGate ? String(acceptedSceneGate.sceneRevision || '') : '';
    const priorChatId = acceptedSceneGate ? String(acceptedSceneGate.chatId ?? '') : '';
    acceptedSceneGate = {
        ...classification,
        chatId,
        sceneRevision: sceneRevision || String(classification.sceneRevision || ''),
        source: String(source || 'scene-scanner'),
        evaluatedAt: Date.now(),
    };
    if (priorRevision !== String(acceptedSceneGate.sceneRevision || '') || priorChatId !== String(acceptedSceneGate.chatId ?? '')) {
        retrievalTransitionConsumption = null;
    }
    logEvent('retrieval', 'change-gate-scene-delta', {
        source: acceptedSceneGate.source,
        chatId: acceptedSceneGate.chatId,
        sceneRevision: acceptedSceneGate.sceneRevision,
        mode: acceptedSceneGate.mode,
        reason: acceptedSceneGate.reason,
        hardSignals: acceptedSceneGate.hardSignals || [],
        softSignals: acceptedSceneGate.softSignals || [],
    }, 'info');
    return { ...acceptedSceneGate };
}


export function applySceneChangeAssist(gate = null, { mode = null, provider = null, latencyMs = 0, sourceFingerprint = null } = {}) {
    if (!gate || !acceptedSceneGate) return gate ? { ...gate } : null;
    const classification = String(mode || '');
    if (![RETRIEVAL_CHANGE.NO_CHANGE, RETRIEVAL_CHANGE.MINOR_CHANGE, RETRIEVAL_CHANGE.MAJOR_CHANGE].includes(classification)) return { ...gate };
    if (String(acceptedSceneGate.chatId ?? '') !== String(gate.chatId ?? '') || String(acceptedSceneGate.sceneRevision || '') !== String(gate.sceneRevision || '')) return { ...gate };
    const priorMode = String(acceptedSceneGate.mode || '');
    acceptedSceneGate = {
        ...acceptedSceneGate,
        mode: classification,
        reason: `Decision Core assist classified the accepted scene as ${classification}`,
        confidence: classification === priorMode ? Math.max(Number(acceptedSceneGate.confidence) || 0, 0.9) : 0.9,
        decisionAssist: { provider: provider || null, latencyMs: Math.max(0, Number(latencyMs) || 0), sourceFingerprint: sourceFingerprint || null, priorMode },
        assistedAt: Date.now(),
    };
    if (classification !== priorMode) retrievalTransitionConsumption = null;
    logEvent('retrieval', 'change-gate-decision-assist-applied', {
        chatId: acceptedSceneGate.chatId, sceneRevision: acceptedSceneGate.sceneRevision, priorMode, mode: classification, provider: provider || null, latencyMs: Math.max(0, Number(latencyMs) || 0), sourceFingerprint: sourceFingerprint || null,
    }, 'info');
    return { ...acceptedSceneGate };
}


export function consumeSceneChangeGateForRetrieval(gate = null) {
    const current = gate ? { ...gate } : null;
    if (!current) return null;
    const mode = String(current.mode || '');
    const chatId = current.chatId == null ? null : String(current.chatId);
    const sceneRevision = String(current.sceneRevision || '');
    if (!sceneRevision || ![RETRIEVAL_CHANGE.MINOR_CHANGE, RETRIEVAL_CHANGE.MAJOR_CHANGE].includes(mode)) {
        return current;
    }

    const same = retrievalTransitionConsumption
        && String(retrievalTransitionConsumption.chatId ?? '') === String(chatId ?? '')
        && String(retrievalTransitionConsumption.sceneRevision || '') === sceneRevision;
    if (!same) {
        retrievalTransitionConsumption = {
            chatId,
            sceneRevision,
            mode,
            consumedAt: Date.now(),
            executionPublished: false,
            publishedAt: 0,
        };
        logEvent('retrieval', 'change-gate-transition-consumed', {
            chatId, sceneRevision, mode, executionPublished: false,
        }, mode === RETRIEVAL_CHANGE.MAJOR_CHANGE ? 'info' : 'debug');
        return {
            ...current,
            transitionConsumed: true,
            transitionFirstConsumer: true,
            transitionExecutionPending: true,
        };
    }

    const replayedFrom = String(retrievalTransitionConsumption.mode || mode);
    const executionPending = retrievalTransitionConsumption.executionPublished !== true;
    const suppressed = {
        ...current,
        mode: RETRIEVAL_CHANGE.NO_CHANGE,
        reason: `scene revision ${sceneRevision} already emitted ${replayedFrom}; semantic replay suppressed for Retrieval`,
        confidence: 1,
        signals: [],
        hardSignals: [],
        softSignals: [],
        semanticReplaySuppressed: true,
        replayedFrom,
        transitionConsumed: true,
        transitionFirstConsumer: false,
        transitionExecutionPending: executionPending,
    };
    logEvent('retrieval', 'change-gate-transition-replay-suppressed', {
        chatId,
        sceneRevision,
        replayedFrom,
        executionPending,
    }, replayedFrom === RETRIEVAL_CHANGE.MAJOR_CHANGE ? 'info' : 'debug');
    return suppressed;
}

export function acknowledgeSceneChangeGateRetrievalExecution(gate = null) {
    if (!gate || !retrievalTransitionConsumption) return false;
    const chatId = gate.chatId == null ? null : String(gate.chatId);
    const sceneRevision = String(gate.sceneRevision || '');
    if (!sceneRevision
        || String(retrievalTransitionConsumption.chatId ?? '') !== String(chatId ?? '')
        || String(retrievalTransitionConsumption.sceneRevision || '') !== sceneRevision) return false;
    if (retrievalTransitionConsumption.executionPublished === true) return true;
    retrievalTransitionConsumption.executionPublished = true;
    retrievalTransitionConsumption.publishedAt = Date.now();
    logEvent('retrieval', 'change-gate-transition-execution-published', {
        chatId,
        sceneRevision,
        mode: retrievalTransitionConsumption.mode,
    }, 'debug');
    return true;
}

export function getSceneChangeGateRetrievalConsumption() {
    return retrievalTransitionConsumption ? { ...retrievalTransitionConsumption } : null;
}

export function getCurrentSceneChangeGate({ chatId = null } = {}) {
    if (!acceptedSceneGate) return null;
    if (chatId != null && String(chatId) !== String(acceptedSceneGate.chatId ?? '')) return null;
    return { ...acceptedSceneGate };
}

export function clearSceneChangeGate(reason = 'cleared') {
    const prior = acceptedSceneGate;
    acceptedSceneGate = null;
    retrievalTransitionConsumption = null;
    if (prior) logEvent('retrieval', 'change-gate-scene-state-cleared', { reason, chatId: prior.chatId, sceneRevision: prior.sceneRevision }, 'debug');
    return prior ? { ...prior } : null;
}


/**
 * Change Gate reconciliation for local Smart Context relevance drift.
 * The retriever may supply drift evidence, but it may not rewrite semantic
 * classification itself. This keeps NO/MINOR/MAJOR ownership in one module.
 */
export function applyContextDriftToRetrievalChange(classification, pendingWarmRefresh, { hasReusableInjection = false } = {}) {
    const gate = { ...(classification || {}) };
    if (!pendingWarmRefresh || gate.mode !== RETRIEVAL_CHANGE.NO_CHANGE || !hasReusableInjection) return gate;
    return {
        ...gate,
        mode: RETRIEVAL_CHANGE.MINOR_CHANGE,
        promotedFrom: RETRIEVAL_CHANGE.NO_CHANGE,
        reason: `${gate.reason}; ${String(pendingWarmRefresh.reason || 'smart-context relevance drift')}`,
        confidence: Math.max(Number(gate.confidence) || 0, 0.85),
        signals: [...new Set([...(Array.isArray(gate.signals) ? gate.signals : []), 'smart-context-relevance-drift'])],
        warmRefreshSignature: pendingWarmRefresh.signature,
    };
}

export function applyReuseFreshness(classification, state, refreshAfter = 3) {
    const next = { ...(classification || {}) };
    const limit = Math.max(0, Number(refreshAfter) || 0);
    if (next.mode === RETRIEVAL_CHANGE.NO_CHANGE) {
        state.noChangeStreak = Number(state.noChangeStreak || 0) + 1;
        if (limit > 0 && state.noChangeStreak > limit) {
            state.noChangeStreak = 0;
            const promoted = {
                mode: RETRIEVAL_CHANGE.MINOR_CHANGE,
                reason: `freshness refresh after ${limit} reused turn(s)`,
                confidence: 1,
                promotedFrom: RETRIEVAL_CHANGE.NO_CHANGE,
            };
            logEvent('retrieval', 'change-gate-promoted', promoted, 'info');
            return promoted;
        }
    } else {
        state.noChangeStreak = 0;
    }
    return next;
}
