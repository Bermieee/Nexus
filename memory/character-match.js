function cleanText(value){ return String(value ?? '').replace(/\s+/g, ' ').trim(); }
function escRe(value){ return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

export function characterPresentInText(character,text){
    const name=cleanText(character).toLowerCase();
    const hay=cleanText(text).toLowerCase();
    if(!name||!hay)return false;
    const boundary=value=>new RegExp(`(^|[^\\p{L}\\p{N}])${escRe(value).replace(/\\ /g,'\\s+')}([^\\p{L}\\p{N}]|$)`,'iu').test(hay);
    if(boundary(name))return true;
    const words=name.match(/[\p{L}\p{N}][\p{L}\p{N}'_-]*/gu)||[];
    if(words.length===1)return false;
    const distinctive=words.filter(word=>[...word].length>=4);
    if(!distinctive.length)return false;
    let hits=0;
    for(const word of distinctive)if(boundary(word))hits++;
    return hits>=Math.min(2,distinctive.length);
}
