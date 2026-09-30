import { getNexusWorldTree } from '../world-tree/index.js';
let sequence=0;
// Map-compatible read surface; the canonical owner holds every payload. A new
// World Tree instance has no overlays and therefore cannot inherit old carry.
export class EphemeralLateResults {
 constructor(){this.ownerKey=`scheduler-late-${++sequence}`;}
 *entries(){for(const row of getNexusWorldTree().overlays.values())if(row.generationId===this.ownerKey)yield [row.data.key,structuredClone(row.data.value)];}
 [Symbol.iterator](){return this.entries();}
 has(key){return getNexusWorldTree().overlays.has(this.id(key));}
 get size(){let count=0;for(const _ of this.entries())count++;return count;}
 id(key){return JSON.stringify([this.ownerKey,String(key)]);}
 get(key){const row=getNexusWorldTree().overlays.get(this.id(key));return row?structuredClone(row.data.value):undefined;}
 set(key,value){
  const chatId=String(value?.scope?.chatId??'').trim();if(!chatId)throw new TypeError('Late result requires a captured chat scope');
  getNexusWorldTree().addEphemeralOverlay({id:this.id(key),kind:'RUNTIME',chatId,nodeIds:['world:nexus'],generationId:this.ownerKey,data:{key,value}});return this;
 }
 delete(key){const tree=getNexusWorldTree(),id=this.id(key);if(!tree.overlays.has(id))return false;
  // Existing owner expiration is used rather than mutating its backing Map.
  const row=tree.overlays.get(id);tree.addEphemeralOverlay({...row,generationId:id});tree.expireEphemeral({chatId:row.chatId,clearGenerationId:id});return true;
 }
 clear(){getNexusWorldTree().expireEphemeral({clearGenerationId:this.ownerKey});}
}
