import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createUidSummarizerState, openUidSummarizer, closeUidSummarizer } from '../src/ui-core/uid-summarizer-console.js';

const read=path=>fs.readFileSync(new URL('../'+path,import.meta.url),'utf8');

test('UID Summarizer state opens scoped to the selected World Tree UID',()=>{
  const state=createUidSummarizerState();
  assert.equal(state.open,false);
  openUidSummarizer(state,{book:'Book',uid:46,title:"Cliff's Grimoire"});
  assert.equal(state.open,true);
  assert.equal(state.selection.uid,46);
  assert.equal(state.selection.book,'Book');
  assert.equal(state.profile,'balanced');
  closeUidSummarizer(state);
  assert.equal(state.open,false);
});

test('UID generation requests Lean Balanced Heavy together',()=>{
  const host=read('nexus-ui-host.js');
  assert.match(host,/summarizeUid\(\{book:id,uid:numericUid,profiles:\['lean','balanced','heavy'\]/);
});

test('selectable World Tree source UIDs expose Summarize visibly in the existing inspector',()=>{
  const graph=read('src/ui-core/lore-neural-graph.js');
  const surface=read('src/ui-core/wave13-operator-surfaces.js');
  const css=read('styles/ui-core-lore-neural.css');
  assert.match(graph,/label:'Summarize'/);
  assert.match(graph,/nexus-world-entity-inspector__summarize/);
  assert.match(graph,/tools\.openUidSummarizer/);
  assert.ok(graph.indexOf("nexus-world-entity-inspector__summarize")<graph.indexOf("nexus-world-entity-inspector__excerpt"),'Summarize must render before the long excerpt/metadata path');
  assert.match(surface,/openUidSummarizer:sourceBook&&uidSummarizerState/);
  assert.equal(surface.includes('openUidSummarizer:caps.summarizeLoreUid&&'),false,'launcher visibility must not depend on engine capability');
  assert.match(css,/\.nexus-world-entity-inspector__summarize\{/);
  assert.match(graph,/nexus-lore-future-action','nexus-world-entity-inspector__summarize/);
  assert.match(css,/width:auto/);
  assert.match(css,/background:rgba\(12,49,72,.28\)!important/);
  assert.match(graph,/Representations/);
  assert.match(graph,/Derived refs/);
});

test('profile switching only changes the visible retained option',()=>{
  const ui=read('src/ui-core/uid-summarizer-console.js');
  assert.match(ui,/const PROFILE_ORDER=\['lean','balanced','heavy'\]/);
  assert.match(ui,/state\.profile===id/);
  assert.match(ui,/onPress:\(\)=>\{state\.profile=id;refresh\?\.\(\);\}/);
  const profileBlock=ui.slice(ui.indexOf("for(const id of PROFILE_ORDER)"),ui.indexOf("const option=options.find"));
  assert.equal(profileBlock.includes('summarizeLoreUid'),false,'profile tabs must not regenerate drafts');
});

test('selected UID summary stages through review instead of writing lore directly',()=>{
  const ui=read('src/ui-core/uid-summarizer-console.js');
  const host=read('nexus-ui-host.js');
  assert.match(ui,/Stage .* for review/);
  assert.match(host,/stageUidSummarySelectionTransaction/);
  assert.match(host,/persistNexusReviewTransaction/);
  assert.equal(ui.includes('saveBook'),false);
  assert.equal(ui.includes('commitCanonicalNexusMutation'),false);
});

test('UID Summarizer stylesheet is loaded',()=>{
  const style=read('style.css');
  assert.match(style,/ui-core-uid-summarizer\.css/);
});


test('UID Summarizer keeps Main A B Running Queued status strip',()=>{
  const ui=read('src/ui-core/uid-summarizer-console.js');
  for(const label of ["add('Main'","add('A'","add('B'","add('Running'","add('Queued'"])assert.equal(ui.includes(label),true,'missing runtime slot '+label);
});


test('World Tree toolbar no longer exposes the obsolete Summarizer button',()=>{
  const graph=read('src/ui-core/lore-neural-graph.js');
  const surface=read('src/ui-core/wave13-operator-surfaces.js');
  assert.equal(graph.includes("label:'Summarizer'"),false);
  assert.equal(surface.includes('summarize:caps.summarizeWorldTreeSource'),false);
});
