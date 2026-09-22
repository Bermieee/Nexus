import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  comparePromptLoaderAdapterSelection,
  listPromptLoaderAdapters,
  normalizePromptLoaderPresentation,
  promptLoaderAdapterSignature,
  promptLoaderPresentationsCompatible,
  resolvePromptLoaderAdapter,
  resolvePromptLoaderLoreOrderPolicy,
} from '../nexus/prompt-loader-adapters.js';
import { resolveMainModelHint, resolveMainProviderHint } from '../observability/token-estimator.js';
import { analyzeChatCompletionPromptReady, resetPromptLoaderTelemetryState } from '../observability/prompt-loader-telemetry.js';
import {
  NEXUS_GENERATION_OUTLET,
  NEXUS_GENERATION_OUTLET_STATUS,
  composeGenerationFrame,
  createGenerationFrameRecord,
  resetGenerationFrameCompiledSectionCache,
  sealGenerationFrameRecord,
  updateGenerationFrameOutlet,
} from '../nexus/generation-frame-contract.js';
import {
  canonicalLorePresentation,
  observeLorePresentationCache,
  planLorePresentationCache,
  resetLorePresentationCacheAnalysis,
  stableLorePresentation,
  sameLorePresentationMembership,
} from '../retrieval/presentation-cache-analysis.js';

const priorOai = globalThis.oai_settings;
const priorTextgen = globalThis.textgenerationwebui_settings;
try {
  globalThis.oai_settings = {
    chat_completion_source: 'openrouter',
    openai_model: 'gpt-5.6-terra',
    claude_model: 'claude-sonnet-5',
    openrouter_model: 'xiaomi/mimo-v2.6',
    google_model: 'gemini-3.7-flash',
  };
  assert.equal(resolveMainProviderHint(), 'openrouter');
  assert.equal(resolveMainProviderHint({
    type: 'normal',
    source: 'foreground',
    chatCompletionSettings: globalThis.oai_settings,
  }), 'openrouter');
  assert.equal(resolveMainModelHint(), 'xiaomi/mimo-v2.6');
  assert.equal(resolvePromptLoaderAdapter({ model: resolveMainModelHint(), provider: resolveMainProviderHint() }).family, 'MiMo');

  globalThis.oai_settings.chat_completion_source = 'claude';
  assert.equal(resolveMainModelHint(), 'claude-sonnet-5');
  assert.equal(resolvePromptLoaderAdapter({ model: resolveMainModelHint(), provider: resolveMainProviderHint() }).family, 'Claude');

  globalThis.oai_settings.chat_completion_source = 'makersuite';
  assert.equal(resolveMainModelHint(), 'gemini-3.7-flash');
  assert.equal(resolvePromptLoaderAdapter({ model: resolveMainModelHint(), provider: resolveMainProviderHint() }).family, 'Gemini');

  assert.equal(resolveMainModelHint({ model: 'deepseek-chat', chatCompletionSettings: globalThis.oai_settings }), 'deepseek-chat');
} finally {
  if (priorOai === undefined) delete globalThis.oai_settings;
  else globalThis.oai_settings = priorOai;
  if (priorTextgen === undefined) delete globalThis.textgenerationwebui_settings;
  else globalThis.textgenerationwebui_settings = priorTextgen;
}

const priorRouteSettings = globalThis.oai_settings;
try {
  globalThis.oai_settings = {
    chat_completion_source: 'custom',
    custom_url: 'https://api.xiaomimimo.com/v1',
    custom_model: 'mimo-v2.6-flash',
  };
  assert.equal(resolveMainProviderHint(), 'xiaomi-mimo');
  assert.equal(resolveMainModelHint(), 'mimo-v2.6-flash');
  const liveMiMoAdapter=resolvePromptLoaderAdapter({model:resolveMainModelHint(),provider:resolveMainProviderHint()});
  assert.equal(liveMiMoAdapter.id,'mimo-stable-prefix-v1');
  assert.equal(liveMiMoAdapter.family,'MiMo');
  assert.equal(liveMiMoAdapter.presentation.layout,'stable-prefix-v2');
  assert.equal(liveMiMoAdapter.presentation.wrapperStyle,'nexus-brackets');
  assert.equal(liveMiMoAdapter.presentation.cachePolicy,'stable-prefix-volatile-tail');
  assert.equal(resolvePromptLoaderLoreOrderPolicy(liveMiMoAdapter),'stable-survivors-append');

  globalThis.oai_settings = {
    chat_completion_source: 'custom',
    custom_url: 'https://api.xiaomimimo.com/v1',
    custom_model: 'mimo-v2.6-pro',
  };
  assert.equal(resolveMainProviderHint(), 'xiaomi-mimo');
  assert.equal(resolveMainModelHint(), 'mimo-v2.6-pro');
  assert.equal(
    resolvePromptLoaderLoreOrderPolicy(resolvePromptLoaderAdapter({
      model: resolveMainModelHint(),
      provider: resolveMainProviderHint(),
    })),
    'stable-survivors-append',
  );

  globalThis.oai_settings.custom_url = 'https://token-plan-cn.xiaomimimo.com/v1';
  assert.equal(resolveMainProviderHint(), 'xiaomi-mimo');

  globalThis.oai_settings.custom_url = 'https://proxy.example.com/v1';
  assert.equal(resolveMainProviderHint(), 'custom');
  assert.equal(
    resolvePromptLoaderLoreOrderPolicy(resolvePromptLoaderAdapter({
      model: resolveMainModelHint(),
      provider: resolveMainProviderHint(),
    })),
    'canonical',
  );

  assert.equal(resolveMainProviderHint({
    chat_completion_source: 'custom',
    custom_url: 'https://api.xiaomimimo.com/v1',
    model: 'mimo-v2.6-pro',
  }), 'xiaomi-mimo');
} finally {
  if (priorRouteSettings === undefined) delete globalThis.oai_settings;
  else globalThis.oai_settings = priorRouteSettings;
}

const priorAlibabaSettings = globalThis.oai_settings;
try {
  globalThis.oai_settings = {
    chat_completion_source: 'custom',
    custom_url: 'https://dashscope-us.aliyuncs.com/compatible-mode/v1',
    custom_model: 'qwen3.8-max',
  };
  assert.equal(resolveMainProviderHint(), 'alibaba-model-studio');
  assert.equal(resolveMainModelHint(), 'qwen3.8-max');
  assert.equal(
    resolvePromptLoaderLoreOrderPolicy(resolvePromptLoaderAdapter({
      model: resolveMainModelHint(),
      provider: resolveMainProviderHint(),
    })),
    'stable-survivors-append',
  );

  globalThis.oai_settings.custom_url = 'https://workspace-123.cn-beijing.maas.aliyuncs.com/compatible-mode/v1';
  globalThis.oai_settings.custom_model = 'glm-5.2';
  assert.equal(resolveMainProviderHint(), 'alibaba-model-studio');
  assert.equal(resolveMainModelHint(), 'glm-5.2');
  assert.equal(
    resolvePromptLoaderLoreOrderPolicy(resolvePromptLoaderAdapter({
      model: resolveMainModelHint(),
      provider: resolveMainProviderHint(),
    })),
    'stable-survivors-append',
  );

  globalThis.oai_settings.custom_url = 'https://oss-cn-beijing.aliyuncs.com/v1';
  assert.equal(resolveMainProviderHint(), 'custom');
} finally {
  if (priorAlibabaSettings === undefined) delete globalThis.oai_settings;
  else globalThis.oai_settings = priorAlibabaSettings;
}

const priorProxySettings = globalThis.oai_settings;
try {
  globalThis.oai_settings = {
    chat_completion_source: 'openai',
    openai_model: 'gpt-5.6-sol',
    reverse_proxy: 'https://proxy.example.com/v1',
  };
  assert.equal(resolveMainProviderHint(), 'openai-proxy');
  assert.equal(resolveMainModelHint(), 'gpt-5.6-sol');
  const proxiedOpenAIAdapter=resolvePromptLoaderAdapter({model:resolveMainModelHint(),provider:resolveMainProviderHint()});
  assert.equal(proxiedOpenAIAdapter.family,'OpenAI');
  assert.equal(proxiedOpenAIAdapter.evidence.cache,'custom-endpoint-unverified');
  assert.equal(resolvePromptLoaderLoreOrderPolicy(proxiedOpenAIAdapter),'canonical');

  globalThis.oai_settings = {
    chat_completion_source: 'deepseek',
    deepseek_model: 'deepseek-chat',
    reverse_proxy: 'https://proxy.example.com/v1',
  };
  assert.equal(resolveMainProviderHint(), 'deepseek-proxy');
  assert.equal(resolveMainModelHint(), 'deepseek-chat');
  assert.equal(
    resolvePromptLoaderLoreOrderPolicy(resolvePromptLoaderAdapter({
      model:resolveMainModelHint(),
      provider:resolveMainProviderHint(),
    })),
    'canonical',
  );

  globalThis.oai_settings = {
    chat_completion_source: 'openai',
    openai_model: 'gpt-5.6-sol',
    reverse_proxy: 'https://api.openai.com/v1',
  };
  assert.equal(resolveMainProviderHint(), 'openai-direct');
  assert.equal(
    resolvePromptLoaderLoreOrderPolicy(resolvePromptLoaderAdapter({
      model:resolveMainModelHint(),
      provider:resolveMainProviderHint(),
    })),
    'stable-survivors-append',
  );
} finally {
  if (priorProxySettings === undefined) delete globalThis.oai_settings;
  else globalThis.oai_settings = priorProxySettings;
}

const priorProviderPrecedenceSettings=globalThis.oai_settings;
try {
  delete globalThis.oai_settings;
  const nestedProxyContext={
    provider:'openai',
    chatCompletionSettings:{
      chat_completion_source:'openai',
      openai_model:'gpt-5.6-sol',
      reverse_proxy:'https://proxy.example.com/v1',
    },
  };
  assert.equal(resolveMainProviderHint(nestedProxyContext),'openai-proxy');
  assert.equal(resolveMainModelHint(nestedProxyContext),'gpt-5.6-sol');

  const nestedDirectMiMoContext={
    provider:'openai',
    chatCompletionSettings:{
      chat_completion_source:'custom',
      custom_url:'https://api.xiaomimimo.com/v1',
      custom_model:'mimo-v2.6-pro',
    },
  };
  assert.equal(resolveMainProviderHint(nestedDirectMiMoContext),'xiaomi-mimo');
  assert.equal(resolveMainModelHint(nestedDirectMiMoContext),'mimo-v2.6-pro');
} finally {
  if(priorProviderPrecedenceSettings===undefined)delete globalThis.oai_settings;
  else globalThis.oai_settings=priorProviderPrecedenceSettings;
}

const cases = [
  ['deepseek-chat', '', 'DeepSeek'],
  ['z-ai/glm-4.6', 'openrouter', 'GLM'],
  ['google/gemini-2.5-pro', 'openrouter', 'Gemini'],
  ['anthropic/claude-sonnet-4', 'openrouter', 'Claude'],
  ['xiaomi/mimo-v2.6', 'openrouter', 'MiMo'],
  ['qwen/qwen3-235b', 'openrouter', 'Qwen'],
  ['openai/gpt-5.1', 'openrouter', 'OpenAI'],
];

for (const [model, provider, family] of cases) {
  const adapter = resolvePromptLoaderAdapter({ model, provider });
  assert.equal(adapter.family, family, `${model} should resolve to ${family}`);
  assert.equal(adapter.matchedBy, 'model');
  assert.equal(adapter.presentation.providerTemplateOwnership, 'host');
  if (family === 'Claude' || family === 'Gemini') {
    assert.equal(adapter.presentation.layout, 'stable-prefix-xml-v1');
    assert.equal(adapter.presentation.wrapperStyle, 'xml-sections');
  } else {
    assert.equal(adapter.presentation.layout, 'stable-prefix-v2');
    assert.equal(adapter.presentation.wrapperStyle, 'nexus-brackets');
  }
  assert.equal(adapter.presentation.cachePolicy, 'stable-prefix-volatile-tail');
}

assert.equal(
  promptLoaderPresentationsCompatible(
    resolvePromptLoaderAdapter({ model: 'deepseek-chat', provider: 'deepseek' }),
    resolvePromptLoaderAdapter({ model: 'mimo-v2.6-pro', provider: 'xiaomi-mimo' }),
  ),
  true,
);
assert.equal(
  promptLoaderPresentationsCompatible(
    resolvePromptLoaderAdapter({ model: 'claude-sonnet-5', provider: 'anthropic' }),
    resolvePromptLoaderAdapter({ model: 'gemini-3.7-pro', provider: 'google' }),
  ),
  true,
);
assert.equal(
  promptLoaderPresentationsCompatible(
    resolvePromptLoaderAdapter({ model: 'deepseek-chat', provider: 'deepseek' }),
    resolvePromptLoaderAdapter({ model: 'claude-sonnet-5', provider: 'anthropic' }),
  ),
  false,
);

const routedDeepSeekPolicy = resolvePromptLoaderLoreOrderPolicy(resolvePromptLoaderAdapter({ model: 'deepseek-chat', provider: 'openrouter' }));
assert.equal(routedDeepSeekPolicy, 'canonical');
const directDeepSeekPolicy = resolvePromptLoaderLoreOrderPolicy(resolvePromptLoaderAdapter({ model: 'deepseek-chat', provider: 'deepseek' }));
assert.equal(directDeepSeekPolicy, 'stable-survivors-append');
const directMiMoPolicy = resolvePromptLoaderLoreOrderPolicy(resolvePromptLoaderAdapter({ model: 'mimo-v2.6-pro', provider: 'xiaomi-mimo' }));
assert.equal(directMiMoPolicy, 'stable-survivors-append');
const customMiMoPolicy = resolvePromptLoaderLoreOrderPolicy(resolvePromptLoaderAdapter({ model: 'mimo-v2.6-pro', provider: 'custom' }));
assert.equal(customMiMoPolicy, 'canonical');

const directDeepSeek = resolvePromptLoaderAdapter({ model: 'deepseek-chat', provider: 'deepseek' });
assert.equal(directDeepSeek.evidence.cache, 'provider-documented-prefix-cache');
const directOpenAI = resolvePromptLoaderAdapter({ model: 'gpt-5.6-sol', provider: 'openai' });
assert.equal(directOpenAI.evidence.cache, 'provider-documented-prompt-cache');
const directMiMo = resolvePromptLoaderAdapter({ model: 'mimo-v2.6-pro', provider: 'xiaomi-mimo' });
assert.equal(directMiMo.evidence.cache, 'provider-documented-prefix-cache');
const dashscopeQwen = resolvePromptLoaderAdapter({ model: 'qwen3.8-max', provider: 'dashscope' });
assert.equal(dashscopeQwen.evidence.cache, 'provider-documented-prefix-cache');
const dashscopeGlm = resolvePromptLoaderAdapter({ model: 'glm-5.2', provider: 'alibaba-model-studio' });
assert.equal(dashscopeGlm.evidence.cache, 'provider-documented-prefix-cache');
const routedOpenAI = resolvePromptLoaderAdapter({ model: 'openai/gpt-5.1', provider: 'openrouter' });
assert.equal(routedOpenAI.evidence.cache, 'router-dependent-unverified');
const customMiMo = resolvePromptLoaderAdapter({ model: 'mimo-v2.6-pro', provider: 'custom' });
assert.equal(customMiMo.evidence.cache, 'custom-endpoint-unverified');

const providerFallback = resolvePromptLoaderAdapter({ provider: 'anthropic' });
assert.equal(providerFallback.family, 'Claude');
assert.equal(providerFallback.matchedBy, 'provider');

const generic = resolvePromptLoaderAdapter({ model: 'unknown-future-model' });
assert.equal(generic.family, 'Generic');
assert.equal(generic.matchedBy, 'generic');
assert.match(promptLoaderAdapterSignature(generic), /^3\|generic-stable-prefix-v3\|/);

const listed = listPromptLoaderAdapters();
assert.ok(listed.length >= 7);
assert.equal(new Set(listed.map(row => row.id)).size, listed.length);

function sealedFor(model) {
  const frame = createGenerationFrameRecord({ generationId: `g-${model}`, chatId: 'chat-1', chatEpoch: 7 });
  updateGenerationFrameOutlet(frame, NEXUS_GENERATION_OUTLET.RETRIEVAL_LORE, {
    status: NEXUS_GENERATION_OUTLET_STATUS.READY,
    content: 'Stable canonical lore payload.',
    refs: [{ book: 'World', uid: 1 }],
    sourceRevision: 'rev-1',
  });
  const adapter = resolvePromptLoaderAdapter({ model, provider: 'openrouter' });
  return sealGenerationFrameRecord(frame, { promptLoader: adapter, sealedAt: 123 });
}

resetGenerationFrameCompiledSectionCache();
const deepseekFrame = sealedFor('deepseek-chat');
const mimoFrame = sealedFor('xiaomi/mimo-v2.6');
const claudeFrame = sealedFor('anthropic/claude-sonnet-4');
const geminiFrame = sealedFor('google/gemini-3.7-pro');

assert.equal(deepseekFrame.promptLoader.family, 'DeepSeek');
assert.equal(deepseekFrame.manifest.promptLoader.family, 'DeepSeek');
assert.equal(mimoFrame.promptLoader.family, 'MiMo');
assert.equal(mimoFrame.manifest.promptLoader.family, 'MiMo');
assert.equal(claudeFrame.promptLoader.wrapperStyle, 'xml-sections');
assert.equal(geminiFrame.promptLoader.wrapperStyle, 'xml-sections');
assert.equal(deepseekFrame.manifest.compileCache.misses, 1);
assert.equal(mimoFrame.manifest.compileCache.hits, 1);
assert.equal(claudeFrame.manifest.compileCache.misses, 1);
assert.equal(geminiFrame.manifest.compileCache.hits, 1);
assert.equal(claudeFrame.promptLoader.evidence.structure, 'provider-documented-xml');
assert.equal(geminiFrame.promptLoader.evidence.structure, 'provider-documented-xml-or-markdown-delimiters');
assert.equal(deepseekFrame.promptLoader.evidence.cache, 'router-dependent-unverified');
assert.equal(mimoFrame.promptLoader.evidence.structure, 'conservative-default');

// Bracket-family adapters keep the canonical Nexus wire format.
assert.equal(deepseekFrame.serializedPrompt, mimoFrame.serializedPrompt);
assert.equal(deepseekFrame.promptHash, mimoFrame.promptHash);
assert.match(deepseekFrame.serializedPrompt, /\[NEXUS:LORE:SELECTED\]/);

// Claude/Gemini use the same semantic payload with XML structure.
assert.equal(claudeFrame.serializedPrompt, geminiFrame.serializedPrompt);
assert.equal(claudeFrame.promptHash, geminiFrame.promptHash);
assert.notEqual(claudeFrame.serializedPrompt, deepseekFrame.serializedPrompt);
assert.match(claudeFrame.serializedPrompt, /<nexus_context_legend version="1">/);
assert.match(claudeFrame.serializedPrompt, /<nexus_section id="retrieval-lore" label="LORE:SELECTED">/);
assert.match(claudeFrame.serializedPrompt, /Stable canonical lore payload\./);
assert.doesNotMatch(claudeFrame.serializedPrompt, /\[NEXUS:LORE:SELECTED\]/);

// A sealed normalized adapter must survive later diagnostic recomposition.
const recomposedClaude = composeGenerationFrame(claudeFrame);
assert.equal(recomposedClaude.promptLoader.family, 'Claude');
assert.equal(recomposedClaude.promptLoader.wrapperStyle, 'xml-sections');
assert.equal(recomposedClaude.promptLoader.evidence.structure, 'provider-documented-xml');
assert.equal(recomposedClaude.serializedPrompt, claudeFrame.serializedPrompt);
assert.equal(recomposedClaude.promptHash, claudeFrame.promptHash);


const sealedClaudeAdapter = normalizePromptLoaderPresentation(resolvePromptLoaderAdapter({ model: 'claude-sonnet-4', provider: 'anthropic' }));
const verifiedClaude = comparePromptLoaderAdapterSelection(sealedClaudeAdapter, { model: 'claude-sonnet-4', provider: 'anthropic' });
assert.equal(verifiedClaude.matched, true);
assert.equal(verifiedClaude.reason, 'adapter-match');
const mismatchedActual = comparePromptLoaderAdapterSelection(sealedClaudeAdapter, { model: 'xiaomi/mimo-v2.6', provider: 'openrouter' });
assert.equal(mismatchedActual.matched, false);
assert.equal(mismatchedActual.reason, 'adapter-selection-mismatch');
assert.equal(mismatchedActual.sealed.family, 'Claude');
assert.equal(mismatchedActual.actual.family, 'MiMo');

const normalized = normalizePromptLoaderPresentation(resolvePromptLoaderAdapter({ model: 'deepseek-chat' }));
assert.equal(normalized.providerTemplateOwnership, 'host');
assert.equal(normalized.outletOrder, 'canonical');
assert.equal(normalized.legendMode, 'standard');
assert.equal(normalized.sectionSeparator, '\n\n');
assert.equal(normalized.wrapperStyle, 'nexus-brackets');
assert.equal(normalized.cachePolicy, 'stable-prefix-volatile-tail');

const claudePresentation = normalizePromptLoaderPresentation(resolvePromptLoaderAdapter({ model: 'claude-sonnet-4' }));
assert.equal(claudePresentation.wrapperStyle, 'xml-sections');
assert.equal(claudePresentation.layout, 'stable-prefix-xml-v1');

resetPromptLoaderTelemetryState();
const xmlOnlyObservation = analyzeChatCompletionPromptReady({
  chat: [{ role: 'system', content: '<nexus_section id="retrieval-lore" label="LORE:SELECTED">\nXML-only Nexus payload\n</nexus_section>' }],
  dryRun: true,
}, { model: 'claude-sonnet-5' });
assert.equal(xmlOnlyObservation.hostEnvelope.containingMessageCount, 1);
assert.equal(xmlOnlyObservation.stability.messagePrefix.firstNexusMessageIndex, 0);

const generationFrameSource = readFileSync(new URL('../nexus/generation-frame.js', import.meta.url), 'utf8');
assert.match(generationFrameSource, /comparisonResetReason=sameAuthority&&!samePresentation\?'adapter-presentation-changed'/);

const loreChunk = row => `[${row.book} | UID ${row.uid} | ${row.title}]\n${row.content}`;
const loreA={book:'World',uid:1,title:'A',content:'Lore A'};
const loreB={book:'World',uid:2,title:'B',content:'Lore B'};
const loreC={book:'World',uid:3,title:'C',content:'Lore C'};
const loreD={book:'World',uid:4,title:'D',content:'Lore D'};
resetLorePresentationCacheAnalysis();
const loreScope='chat-1|epoch-7';
const firstLore=[loreB,loreC];
const firstCanonical=canonicalLorePresentation(firstLore);
observeLorePresentationCache({
  scopeKey:loreScope,
  currentCandidates:firstLore,
  presentedCandidates:firstCanonical,
  currentText:firstCanonical.map(loreChunk).join('\n\n'),
  model:'deepseek-chat',
});
const secondLore=[loreA,loreB,loreC];
const secondPlan=planLorePresentationCache({scopeKey:loreScope,currentCandidates:secondLore,strategy:'stable-survivors-append'});
assert.deepEqual(secondPlan.orderedCandidates.map(row=>row.uid),[2,3,1]);
assert.deepEqual(
  [...secondPlan.orderedCandidates].map(row=>row.uid).sort((a,b)=>a-b),
  canonicalLorePresentation(secondLore).map(row=>row.uid).sort((a,b)=>a-b),
);
assert.deepEqual(stableLorePresentation(secondLore,firstCanonical).map(row=>row.uid),[2,3,1]);
assert.equal(sameLorePresentationMembership(secondLore,secondPlan.orderedCandidates),true);
assert.equal(sameLorePresentationMembership(secondLore,[loreB,loreC]),false);
assert.equal(sameLorePresentationMembership([loreB,loreB,loreC],[loreB,loreC,loreB]),true);
assert.equal(sameLorePresentationMembership([loreB,loreB,loreC],[loreB,loreC]),false);
const secondCanonicalText=canonicalLorePresentation(secondLore).map(loreChunk).join('\n\n');
const secondActualText=secondPlan.orderedCandidates.map(loreChunk).join('\n\n');
const secondObservation=observeLorePresentationCache({
  scopeKey:loreScope,
  currentCandidates:secondLore,
  presentedCandidates:secondPlan.orderedCandidates,
  currentText:secondActualText,
  baselineText:secondCanonicalText,
  model:'deepseek-chat',
});
assert.equal(secondObservation.hasPrior,true);
assert.equal(secondObservation.actualMatchesStable,true);
assert.equal(secondObservation.activePresentationChangedFromBaseline,true);
assert.ok(secondObservation.realizedGainTokens>0);
assert.equal(secondObservation.remainingPotentialGainTokens,0);
assert.ok(secondObservation.potentialGainTokens>=secondObservation.realizedGainTokens);
const thirdLore=[loreC,loreA,loreD];
const thirdPlan=planLorePresentationCache({scopeKey:loreScope,currentCandidates:thirdLore,strategy:'stable-survivors-append'});
assert.deepEqual(thirdPlan.orderedCandidates.map(row=>row.uid),[3,1,4]);
const canonicalPlan=planLorePresentationCache({scopeKey:loreScope,currentCandidates:thirdLore,strategy:'canonical'});
assert.deepEqual(canonicalPlan.orderedCandidates.map(row=>row.uid),[1,3,4]);
const switchedCacheDomainPlan=planLorePresentationCache({
  scopeKey:'chat-1|epoch-7|xiaomi-mimo|mimo-v2.6-pro',
  currentCandidates:secondLore,
  strategy:'stable-survivors-append',
});
assert.equal(switchedCacheDomainPlan.hasPrior,false);
assert.deepEqual(switchedCacheDomainPlan.orderedCandidates.map(row=>row.uid),[1,2,3]);

const retrievalStateSource = readFileSync(new URL('../retrieval/state.js', import.meta.url), 'utf8');
assert.match(retrievalStateSource, /lastInjectionProvider: ''/);
assert.match(retrievalStateSource, /lastLoreOrderPolicy: 'canonical'/);
assert.match(retrievalStateSource, /state\.lastInjectionProvider = String\(provider \|\| ''\)/);
assert.match(retrievalStateSource, /state\.lastLoreOrderPolicy = String\(loreOrderPolicy \|\| 'canonical'\)/);

const retrieverSource = readFileSync(new URL('../retrieval/retriever.js', import.meta.url), 'utf8');
assert.match(retrieverSource, /presentationStrategy:finalPolicy\.loreOrderPolicy/);
assert.match(retrieverSource, /finalPolicy\.mainProvider\|\|'unknown-provider'/);
assert.match(retrieverSource, /finalPolicy\.mainModel\|\|'unknown-model'/);
assert.match(retrieverSource, /presentedCandidates:rendered\.presentedCandidates/);
assert.match(retrieverSource, /includedCandidates=selected\.map/);
assert.match(retrieverSource, /presentationFallbackReason:membershipValid\?null:'membership-mismatch'/);
assert.match(retrieverSource, /state\.lastInjectionProvider \|\| ''\).*policy\?\.mainProvider/);
assert.match(retrieverSource, /state\.lastLoreOrderPolicy \|\| 'canonical'\).*policy\?\.loreOrderPolicy/);
assert.match(retrieverSource, /provider:finalPolicy\.mainProvider, loreOrderPolicy:finalPolicy\.loreOrderPolicy/);

const telemetrySource = readFileSync(new URL('../observability/telemetry.js', import.meta.url), 'utf8');
assert.match(telemetrySource, /adapterVerification: null/);
assert.match(telemetrySource, /record\.name === 'adapter-verified' \|\| record\.name === 'adapter-mismatch'/);
const diagnosticsSource = readFileSync(new URL('../observability/ui.js', import.meta.url), 'utf8');
assert.match(diagnosticsSource, /REQUEST MISMATCH sealed/);
assert.match(diagnosticsSource, /request verified/);
assert.match(diagnosticsSource, /realized prefix tokens vs canonical/);

console.log('PASS Prompt Loader adapter registry + Generation Frame seal contract');
