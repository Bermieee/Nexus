import { getNexusWorldTreeOwner } from './index.js';
import { reconstructLoreBookFromWorldTree, reconstructLoreTreeFromWorldTree } from './lore-read-parity.js';

let state=Object.freeze({book:null,authority:'OWNER_IMPORT',parity:null,reason:'not-verified',updatedAt:0});

export function setLoreReadAuthority({book,parity=null,authority=null,reason=null}={}){
  const name=String(book??'').trim()||null;
  const selected=authority??(parity?.status==='PASS'&&parity?.controlMetadata==='PASS'?'WORLD_TREE':'OWNER_IMPORT');
  state=Object.freeze({book:name,authority:selected==='WORLD_TREE'?'WORLD_TREE':'OWNER_IMPORT',parity:parity??null,reason:reason??(selected==='WORLD_TREE'?'PARITY_PASS':'PARITY_REQUIRED'),updatedAt:Date.now()});
  return loreReadAuthorityStatus();
}
export function invalidateLoreReadAuthority(book=null,reason='owner-source-changed'){
  const name=String(book??'').trim()||state.book;
  state=Object.freeze({book:name??null,authority:'OWNER_IMPORT',parity:state.book===name?state.parity:null,reason:String(reason||'owner-source-changed'),updatedAt:Date.now()});
  return loreReadAuthorityStatus();
}
export function loreReadAuthorityStatus(book=null){
  const name=String(book??'').trim();
  if(name&&state.book&&name!==state.book)return Object.freeze({book:name,authority:'OWNER_IMPORT',parity:null,reason:'outside-verified-story-binding',updatedAt:state.updatedAt,readersSwitched:false});
  return Object.freeze({...state,readersSwitched:state.authority==='WORLD_TREE'});
}
export function readLoreBookByAuthority(book,ownerBook){
  const status=loreReadAuthorityStatus(book);
  if(status.authority!=='WORLD_TREE')return ownerBook;
  const reconstructed=reconstructLoreBookFromWorldTree(getNexusWorldTreeOwner(),book);
  return reconstructed??ownerBook;
}
export function readLoreTreeByAuthority(book,ownerTree){
  const status=loreReadAuthorityStatus(book);
  if(status.authority!=='WORLD_TREE')return ownerTree;
  const reconstructed=reconstructLoreTreeFromWorldTree(getNexusWorldTreeOwner(),book);
  return reconstructed??ownerTree;
}
