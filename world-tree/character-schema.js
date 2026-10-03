const clone=value=>value==null?value:structuredClone(value);
const safeId=value=>encodeURIComponent(String(value??''));
export function characterOwnerRecord(bank={}){return clone(bank);}
export function boundCharacterWorldNodeId(avatar){return 'character-card:'+safeId(avatar);}
export function localCharacterWorldNodeId(chatId,characterStateId){return 'character-local:'+safeId(chatId)+':'+safeId(characterStateId);}
export function characterStateWorldNodeId(chatId,characterStateId){return 'character-state:'+safeId(chatId)+':'+safeId(characterStateId);}
export function characterControlWorldNodeId(chatId){return 'character-control:'+safeId(chatId);}
