// Explicit operator selection is independent of a story's runtime binding.
// Session-only: a legacy saved picker must never restart background work after
// browser refresh. Only a successfully admitted authoring load selects a book.
let authoringBook=null,selectionRequest=0;
export function readLorebookAuthoringSelection(){return authoringBook;}
function publishSelection(book){
  if(authoringBook===book)return;
  authoringBook=book;
  try{globalThis.window?.dispatchEvent?.(new CustomEvent('nexus-lore-authoring-source-selected',{detail:{book}}));}catch{}
}
export function clearLorebookAuthoringSelection(){selectionRequest++;publishSelection(null);}
export function createLorebookAuthoringSource({listNames,canRead,assertReady,loadBook,enableBook,createBook}){
  const names=()=>[...new Set(listNames().map(name=>String(name).trim()).filter(Boolean))];
  const key=name=>name.normalize('NFD').replace(/\p{M}/gu,'').toLocaleLowerCase();
  const validName=value=>{
    const name=String(value??'').trim();
    if(!name||name.startsWith('---')||/[<>:"/\\|?*\x00-\x1f]/.test(name)||/[. ]$/.test(name)||/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name))throw Error('Choose a valid Lorebook name.');
    return name;
  };
  const load=async value=>{
    assertReady();const book=validName(value);
    if(!names().includes(book))throw Error(`Lorebook "${book}" does not exist.`);
    if(!canRead(book))throw Error(`Lorebook "${book}" cannot be read for authoring.`);
    const request=++selectionRequest;publishSelection(null);
    const data=await loadBook(book);
    if(request!==selectionRequest)throw Error('Lorebook selection changed while loading.');
    if(!data?.entries)throw Error(`Lorebook "${book}" could not be loaded.`);
    await enableBook(book);
    if(request!==selectionRequest)throw Error('Lorebook selection changed while loading.');
    publishSelection(book);
    return {book,data};
  };
  return {
    list:()=>names().filter(canRead),load,
    async create(value){
      assertReady();const book=validName(value);
      if(names().some(name=>key(name)===key(book)))throw Error(`Lorebook "${book}" already exists.`);
      if(!canRead(book))throw Error(`Lorebook "${book}" cannot be read for authoring.`);
      if(await createBook(book)!==true)throw Error(`Lorebook "${book}" was not created; its name may already exist.`);
      return load(book);
    },
  };
}
