import { world_names } from '../../../../world-info.js';

function cleanName(value){ return String(value ?? '').trim(); }
export function getHostLorebookNames(){ return [...new Set((Array.isArray(world_names)?world_names:[]).map(cleanName).filter(Boolean))]; }
export function hostLorebookExists(book){ const name=cleanName(book); return !!name && getHostLorebookNames().includes(name); }
