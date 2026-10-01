const key=scope=>JSON.stringify([scope?.worldId??'nexus',scope?.type,scope?.chatId??null]);
export class WorldTreeLayoutStore {
  constructor({save=null}={}){this.rows=new Map();this.save=save;this.tail=Promise.resolve();}
  read(scope){return structuredClone(this.rows.get(key(scope))??{revision:0,scope,layout:null});}
  publish(input){
    const run=async()=>{
      const {scope,worldRevision,expectedLayoutRevision,layout}=input;
      if(!['GLOBAL','CHAT'].includes(scope?.type)||scope.type==='CHAT'&&!scope.chatId)throw Error('Layout scope required');
      const previous=this.read(scope);if(previous.revision!==expectedLayoutRevision)throw Error('Stale layout revision');
      for(const p of Object.values(layout?.positions??{}))if(!Number.isFinite(p?.x)||!Number.isFinite(p?.y))throw Error('Invalid layout coordinates');
      const record={scope:structuredClone(scope),worldRevision,revision:previous.revision+1,layout:structuredClone(layout)},next=new Map(this.rows);
      next.set(key(scope),record);const state={contract:'nexus-world-tree-layout/v1',rows:[...next.entries()]};
      if(this.save)await this.save(structuredClone(state));this.rows=next;return structuredClone(record);
    };
    const pending=this.tail.then(run,run);this.tail=pending.catch(()=>{});return pending;
  }
  exportState(){return structuredClone({contract:'nexus-world-tree-layout/v1',rows:[...this.rows.entries()]});}
  restore(state){if(state?.contract!=='nexus-world-tree-layout/v1')throw Error('Invalid layout state');this.rows=new Map(structuredClone(state.rows));return this;}
}
