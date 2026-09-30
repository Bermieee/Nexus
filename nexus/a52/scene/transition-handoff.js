const clone=(value)=>value==null?value:structuredClone(value);
const uniq=(values,limit=64)=>[...new Set((values??[]).filter(Boolean).map(String))].slice(-limit);

export class SceneTransitionHandoffBuilder{
  constructor({maxTailRefs=6,ttlRevisions=3}={}){
    this.maxTailRefs=Math.max(1,Math.min(16,Number(maxTailRefs)||6));
    this.ttlRevisions=Math.max(1,Math.min(16,Number(ttlRevisions)||3));
  }
  build({transition,priorScene,nextScene,episode=null,recentTailRefs=[],destinationHints={},evidenceRefs=[],sourceRevisionRefs=[]}={}){
    if(!transition?.fromSceneId||!transition?.toSceneId)throw new TypeError('Scene transition handoff requires from/to Scene identity');
    if(!priorScene?.sceneId||!nextScene?.sceneId)throw new TypeError('Scene transition handoff requires prior and next Scene');
    const refs=uniq([...sourceRevisionRefs,...priorScene.sourceRevisionRefs??[],...nextScene.sourceRevisionRefs??[]],128);
    const continuity=Object.freeze({
      kind:'SceneContinuityNomination',episodeRef:clone(episode?.artifactRef??null),
      compactPriorSceneSummary:String(episode?.compactSummary??'').slice(0,1600),
      recentTailRefs:uniq(recentTailRefs,this.maxTailRefs),sourceRevisionRefs:uniq(episode?.sourceRevisionRefs??priorScene.sourceRevisionRefs??[],64),
      eligibility:'OPTIONAL_PRIOR_SCENE_CONTEXT',promptInclusionAuthority:false,rawDialogueDeletionAuthority:false,contextSealAuthority:false,
    });
    return Object.freeze({
      kind:'SceneTransitionContextHandoff',contractVersion:'1.0.0',
      handoffId:`scene-handoff:${transition.fromSceneId}:${priorScene.revision}->${transition.toSceneId}:${nextScene.revision}`,
      fromSceneRef:Object.freeze({sceneId:transition.fromSceneId,sceneRevision:priorScene.revision}),
      toSceneRef:Object.freeze({sceneId:transition.toSceneId,sceneRevision:nextScene.revision}),
      relationship:transition.relationship??null,status:'ACTIVE',continuity,
      destinationPrefetch:Object.freeze({
        entityRefs:uniq(destinationHints.entityRefs,32),locationRefs:uniq(destinationHints.locationRefs,16),
        threadRefs:uniq(destinationHints.threadRefs,32),sceneRefs:uniq([transition.fromSceneId,transition.toSceneId,...(destinationHints.sceneRefs??[])],16),
      }),
      evidenceRefs:uniq(evidenceRefs,64),sourceRevisionRefs:refs,invalidators:[],
      expiryRevision:nextScene.revision+this.ttlRevisions,
      authority:'NOMINATION_ONLY',runtimeSchedulingAuthority:false,promptInclusionAuthority:false,
      rawDialogueDeletionAuthority:false,memoryMutationAuthority:false,settlementAuthority:false,contextSealAuthority:false,
    });
  }
  invalidate(handoff,{sourceRevisionRef=null,replacementRef=null}={}){
    if(!handoff)return null;
    if(sourceRevisionRef&&!handoff.sourceRevisionRefs?.includes?.(sourceRevisionRef))return clone(handoff);
    return Object.freeze({...clone(handoff),status:'INVALIDATED',invalidators:uniq([...(handoff.invalidators??[]),replacementRef??sourceRevisionRef],32)});
  }
  isFresh(handoff,{sceneId,sceneRevision}={}){
    return Boolean(handoff?.kind==='SceneTransitionContextHandoff'&&handoff.status==='ACTIVE'&&handoff.toSceneRef?.sceneId===sceneId&&Number(sceneRevision)<=Number(handoff.expiryRevision));
  }
}
