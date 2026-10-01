// Explicit operator selection is independent of a story's runtime binding.
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
    const data=await loadBook(book);
    if(!data?.entries)throw Error(`Lorebook "${book}" could not be loaded.`);
    await enableBook(book);
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
