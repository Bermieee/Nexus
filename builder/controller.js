import { createMutationProposal } from '../nexus/contracts.js';
import { clone, findNodeContainingUid, semanticSnapshot, collectUids } from '../tree/model.js';
import { BUILDER_MODE, createBuildRequest, createLedgerMutationPlan } from './contracts.js';
import { buildLorebookInventory, buildTreeInventory, determineBuilderMode } from './inventory.js';
import { buildLorebookBuilderPlan } from './director-bridge.js';
import { buildBuilderAssumptions } from './assumptions.js';
import { normalizePlacementPayload, validatePlacementCoverage, validateMaterializedDelta } from './validation.js';
import { materializeTreeDelta } from './tree-delta.js';
import { inspectBuilderTreeQuality } from './navigation-policy.js';


function nodeIndex(root, parentId = null, out = new Map()) {
    if (!root) return out;
    out.set(root.id, { node: root, parentId });
    for (const child of root.children || []) nodeIndex(child, root.id, out);
    return out;
}

function operationsForDelta(delta, book) {
    return [
        ...(delta.newNodes || []).map(node => ({ type: 'create-tree-node', ...node })),
        ...(delta.added || []).map(row => ({ type: 'attach-lore-uid', uid: row.uid, nodeId: row.nodeId, priorNodeId: row.priorNodeId })),
        { type: 'update-builder-manifest', book },
    ];
}

function buildEditedTreeDelta({ book, mode, originalDelta, existingTree, lorebookInventory, editedTree, now = Date.now() } = {}) {
    const nextTree = clone(editedTree);
    if (!nextTree?.root) throw new Error('Edited Builder preview has no Tree root.');

    // Incremental review may manipulate only Builder-created nodes and Builder-target UIDs.
    // Existing Tree structure is locked so the review surface cannot silently turn into
    // an unrelated manual Tree refactor.
    const beforeNodes = nodeIndex(existingTree?.root);
    const afterNodes = nodeIndex(nextTree.root);
    for (const [nodeId, before] of beforeNodes.entries()) {
        const after = afterNodes.get(nodeId);
        if (!after) throw new Error(`Builder review cannot delete existing Tree node ${before.node.label || nodeId}.`);
        if (String(after.node.label || '') !== String(before.node.label || '')) throw new Error(`Builder review cannot rename existing Tree node ${before.node.label || nodeId}.`);
        if ((after.parentId || null) !== (before.parentId || null)) throw new Error(`Builder review cannot move existing Tree node ${before.node.label || nodeId}.`);
        if (String(after.node.summary || '') !== String(before.node.summary || '')) throw new Error(`Builder review cannot edit the summary of established Tree node ${before.node.label || nodeId}.`);
        const beforeKeywords=JSON.stringify([...(before.node.keywords||[])].map(String));
        const afterKeywords=JSON.stringify([...(after.node.keywords||[])].map(String));
        if (afterKeywords !== beforeKeywords) throw new Error(`Builder review cannot edit keywords of established Tree node ${before.node.label || nodeId}.`);
    }

    const added = (originalDelta?.added || []).map(row => {
        const node = findNodeContainingUid(nextTree.root, Number(row.uid));
        if (!node) throw new Error(`Builder target UID ${row.uid} must remain attached to exactly one preview node.`);
        return { ...clone(row), nodeId: node.id, nodeLabel: node.label };
    });

    const newNodes = [];
    const originalBuilderNodeIds=new Set((originalDelta?.newNodes||[]).map(row=>String(row?.nodeId||'')).filter(Boolean));
    const targetUids=new Set((originalDelta?.added||[]).map(row=>Number(row?.uid)).filter(Number.isFinite));
    for (const [nodeId, row] of afterNodes.entries()) {
        if (nodeId === nextTree.root.id || beforeNodes.has(nodeId)) continue;
        const hostsTarget=collectUids(row.node).some(uid=>targetUids.has(Number(uid)));
        if(!originalBuilderNodeIds.has(String(nodeId))&&!hostsTarget){
            throw new Error(`Builder review cannot create unrelated category ${row.node.label || nodeId}; use the normal Tree editor for unrelated structural work.`);
        }
        newNodes.push({
            nodeId,
            label: row.node.label,
            parentNodeId: row.parentId,
            parentLabel: row.parentId ? (afterNodes.get(row.parentId)?.node?.label || 'Root') : 'Root',
        });
    }

    const manifestEntries = {};
    for (const entry of lorebookInventory?.activeEntries || []) {
        const node = findNodeContainingUid(nextTree.root, Number(entry.uid));
        if (!node) continue;
        manifestEntries[String(entry.uid)] = {
            uid: Number(entry.uid),
            title: entry.title,
            fingerprint: entry.fingerprint,
            nodeId: node.id,
            nodeLabel: node.label,
        };
    }
    nextTree.builderManifest = {
        schema: 'nexus-lorebook-builder-manifest/v1',
        book,
        bookFingerprint: lorebookInventory?.fingerprint || '',
        reconciledAt: now,
        entries: manifestEntries,
    };
    nextTree.lastBuilt = now;

    const delta = {
        ...clone(originalDelta || {}),
        book,
        mode,
        added,
        newNodes,
        nextTree,
    };
    const quality=inspectBuilderTreeQuality({tree:nextTree,lorebookInventory});
    delta.conflicts=[...(delta.conflicts||[]).filter(row=>!String(row.type||'').startsWith('builder-quality-')),...quality.issues];
    delta.quality=quality.metrics;
    const treeInventory = buildTreeInventory(book, existingTree, lorebookInventory);
    const structural = validateMaterializedDelta({
        mode,
        existingTree,
        treeInventory,
        lorebookInventory,
        delta,
    });
    if (!structural.passed) throw new Error(structural.errors.join(' '));
    return { delta, structural };
}

function requiredFunction(name, value) {
    if (typeof value !== 'function') throw new Error(`Lorebook Builder dependency ${name} is required.`);
    return value;
}

export class LorebookBuilderController {
    constructor({
        loadBook,
        getTree,
        commitMutation,
        assertReadableBook = () => true,
        assertWritableBook = () => true,
        director,
        ledger,
        semanticExecutor,
        planningConfigProvider,
        persistReviewTransaction = null,
        cancelReviewTransactionDurably = null,
        supersedeReviewTransactionDurably = null,
        logEvent = () => {},
        now = () => Date.now(),
    } = {}) {
        this.loadBook = requiredFunction('loadBook', loadBook);
        this.getTree = requiredFunction('getTree', getTree);
        this.commitMutation = requiredFunction('commitMutation', commitMutation);
        this.assertReadableBook = requiredFunction('assertReadableBook', assertReadableBook);
        this.assertWritableBook = requiredFunction('assertWritableBook', assertWritableBook);
        if (!director) throw new Error('Lorebook Builder requires Work Director.');
        if (!ledger || typeof ledger.begin !== 'function' || typeof ledger.run !== 'function') throw new Error('Lorebook Builder requires Transaction Ledger.');
        if (!semanticExecutor || typeof semanticExecutor.execute !== 'function') throw new Error('Lorebook Builder requires a semantic executor.');
        this.director = director;
        this.ledger = ledger;
        this.semanticExecutor = semanticExecutor;
        this.planningConfigProvider = requiredFunction('planningConfigProvider', planningConfigProvider);
        this.persistReviewTransaction = persistReviewTransaction;
        this.cancelReviewTransactionDurably = cancelReviewTransactionDurably;
        this.supersedeReviewTransactionDurably = supersedeReviewTransactionDurably;
        this.logEvent = logEvent;
        this.now = now;
        // One staged Builder review owns restaging at a time. This prevents two
        // concurrent operator edits from manufacturing competing replacement
        // transactions before durable supersession settles.
        this.restageClaims = new Set();
    }

    async inspect(book) {
        this.assertReadableBook(book);
        const data = await this.loadBook(book);
        const tree = this.getTree(book);
        const lorebookInventory = buildLorebookInventory(book, data);
        const treeInventory = buildTreeInventory(book, tree, lorebookInventory);
        return { data, tree, lorebookInventory, treeInventory };
    }

    async start(requestLike = {}, { signal = null, onTransaction = null } = {}) {
        const request = createBuildRequest(requestLike);
        this.assertReadableBook(request.book);
        this.assertWritableBook(request.book);
        const inspected = await this.inspect(request.book);
        const mode = determineBuilderMode(request, inspected.lorebookInventory, inspected.treeInventory);
        this.logEvent('builder', 'run-inspected', {
            runId: request.id, book: request.book, mode,
            entryCount: inspected.lorebookInventory.entryCount,
            representedCount: inspected.treeInventory.representedCount,
            unrepresentedCount: inspected.treeInventory.unrepresentedCount,
            changedCount: inspected.treeInventory.changedCount,
        }, 'info');

        if (mode === BUILDER_MODE.NOOP) {
            return {
                runId: request.id,
                book: request.book,
                mode,
                state: 'current',
                transactionId: null,
                directorPlan: null,
                preview: { unchangedCount: inspected.treeInventory.representedCount, added: [], newNodes: [], conflicts: [] },
            };
        }
        if (mode === BUILDER_MODE.REPAIR) {
            this.logEvent('builder', 'repair-deferred', {
                runId: request.id,
                book: request.book,
                changedCount: inspected.treeInventory.changedCount,
                duplicateCount: inspected.treeInventory.duplicateUidRefs.length,
                orphanedCount: inspected.treeInventory.orphanedTreeUids.length,
            }, 'warn');
            throw new Error('Builder Repair mode is not part of the first vertical slice yet; no mutation was staged.');
        }

        const semanticResource = typeof this.semanticExecutor.resolveResource === 'function'
            ? this.semanticExecutor.resolveResource(request)
            : 'sidecar';
        // Resolve Tree planning exactly once for this run. Executors consume this
        // immutable plan; neither Main nor Sidecar may re-read/override semantics.
        const planningConfig = this.planningConfigProvider({ semanticResource });
        const buildPlan = buildLorebookBuilderPlan({
            request, mode, ...inspected, director: this.director, semanticResource,
            maxEntriesPerJob: planningConfig.maxEntriesPerJob,
            semanticInputTargetTokens: planningConfig.semanticInputTargetTokens,
            maxJobsPerWave: planningConfig.maxJobsPerWave,
            waveTargetInputTokens: planningConfig.waveTargetInputTokens,
        });
        this.logEvent('builder', 'batch-plan-config', {
            runId: request.id, book: request.book, semanticResource,
            semanticSliceCount: buildPlan.metadata?.semanticSliceCount ?? null,
            semanticSliceEntryCounts: buildPlan.metadata?.semanticSliceEntryCounts ?? [],
            maxEntriesPerSemanticSlice: buildPlan.metadata?.maxEntriesPerSemanticSlice ?? null,
            semanticInputTargetTokens: buildPlan.metadata?.semanticInputTargetTokens ?? null,
            maxJobsPerWave: planningConfig.maxJobsPerWave ?? null,
            waveTargetInputTokens: planningConfig.waveTargetInputTokens ?? null,
            treeBatchEnabled: planningConfig.treeBatchEnabled ?? null,
            configProvenance: planningConfig.provenance ?? null,
        }, 'info');
        const assumptions = buildBuilderAssumptions({ book: request.book, ...inspected });
        const { _sourceEntries: _executorOnlySourceEntries, ...inventorySnapshot } = inspected.lorebookInventory;
        const tx = this.ledger.begin({
            type: 'lorebook-builder',
            input: { request, buildPlan },
            // Durable review/restage state needs fingerprints/refs, not a second
            // copy of every lore entry's raw content. Keep the executor-only text
            // outside the Ledger snapshot to bound large-world memory pressure.
            snapshot: { tree: inspected.tree, inventory: inventorySnapshot },
            assumptions,
            metadata: { builderRunId: request.id, book: request.book, mode, source: request.source },
        });
        onTransaction?.(tx.id);
        if (signal?.aborted) {
            this.ledger.cancel(tx.id, 'Lorebook Builder cancelled before semantic execution.');
            throw new DOMException('Lorebook Builder cancelled.', 'AbortError');
        }

        const phaseStartedAt = new Map();
        const beginPhase = phase => { phaseStartedAt.set(phase, this.now()); return phase; };
        const phaseMs = phase => Math.max(0, this.now() - (phaseStartedAt.get(phase) || this.now()));
        const ensureLive = () => {
            if (signal?.aborted) throw new DOMException('Lorebook Builder cancelled.', 'AbortError');
        };
        let phase = 'semantic-execution';
        let staged = null;
        try {
            this.ledger.executing(tx.id);
            beginPhase(phase);
            ensureLive();
            const raw = await this.semanticExecutor.execute({
                request,
                mode,
                buildPlan,
                lorebookInventory: inspected.lorebookInventory,
                treeInventory: inspected.treeInventory,
                tree: inspected.tree,
                signal,
            });
            ensureLive();

            phase = beginPhase('aggregate-received');
            const parsed = normalizePlacementPayload(raw);
            this.logEvent('builder', 'aggregate-received', {
                runId: request.id, transactionId: tx.id, book: request.book,
                placementCount: parsed.placements.length,
                semanticSliceCount: buildPlan.metadata?.semanticSliceCount ?? null,
                durationMs: phaseMs(phase),
            }, 'info');
            // Store the compact normalized aggregate once. The old generic run()
            // path deep-copied both raw and parsed payloads, which is avoidable on
            // large Builder runs and obscured the post-gather failure boundary.
            this.ledger.parsed(tx.id, parsed);
            ensureLive();

            phase = beginPhase('coverage-valid');
            const coverage = validatePlacementCoverage({ buildPlan, payload: parsed, lorebookInventory: inspected.lorebookInventory });
            if (!coverage.passed) throw new Error(coverage.errors.join(' '));
            this.logEvent('builder', 'coverage-valid', {
                runId: request.id, transactionId: tx.id, book: request.book,
                expectedCount: buildPlan.targetRefs.length,
                receivedCount: parsed.placements.length,
                durationMs: phaseMs(phase),
            }, 'info');
            ensureLive();

            phase = beginPhase('delta-materialized');
            const validatedDelta = materializeTreeDelta({
                book: request.book,
                mode,
                existingTree: inspected.tree,
                lorebookInventory: inspected.lorebookInventory,
                treeInventory: inspected.treeInventory,
                placements: parsed.placements,
                now: this.now(),
            });
            this.logEvent('builder', 'delta-materialized', {
                runId: request.id, transactionId: tx.id, book: request.book,
                addedCount: validatedDelta.added?.length || 0,
                newNodeCount: validatedDelta.newNodes?.length || 0,
                conflictCount: validatedDelta.conflicts?.length || 0,
                durationMs: phaseMs(phase),
            }, 'info');
            ensureLive();

            phase = beginPhase('delta-valid');
            const structural = validateMaterializedDelta({
                mode,
                existingTree: inspected.tree,
                treeInventory: inspected.treeInventory,
                lorebookInventory: inspected.lorebookInventory,
                delta: validatedDelta,
            });
            if (!structural.passed) throw new Error(structural.errors.join(' '));
            this.ledger.validated(tx.id, { passed: true, coverage, structural });
            this.logEvent('builder', 'delta-valid', {
                runId: request.id, transactionId: tx.id, book: request.book,
                addedCount: validatedDelta.added?.length || 0,
                durationMs: phaseMs(phase),
            }, 'info');
            ensureLive();

            // Re-read assumptions immediately before staging. A ten-minute model
            // run must not stage against a lorebook or Tree that changed while the
            // semantic workers were still running.
            phase = beginPhase('prestage-freshness');
            const currentAssumptions = await this.currentAssumptions(request.book);
            const freshness = this.ledger.checkFresh(tx.id, currentAssumptions);
            if (!freshness.fresh) {
                staged = this.ledger.stale(tx.id, 'Lorebook Builder source changed before proposal staging.', freshness);
                this.logEvent('builder', 'stale-plan-rejected', { runId: request.id, transactionId: tx.id, book: request.book, phase, freshness, durationMs: phaseMs(phase) }, 'warn');
                return {
                    runId: request.id, book: request.book, mode, state: staged.state,
                    transactionId: staged.id, directorPlan: buildPlan.directorPlan,
                    preview: null, mutationProposal: null,
                };
            }
            ensureLive();

            phase = beginPhase('ledger-staged');
            const operations = operationsForDelta(validatedDelta, request.book);
            const stagedPlan = createLedgerMutationPlan({ book: request.book, mode, operations, assumptions, delta: validatedDelta });
            const mutationProposal = createMutationProposal({
                transactionId: tx.id,
                type: 'lorebook-builder-tree-delta',
                target: { book: request.book, tree: true },
                draft: { mode, delta: stagedPlan.delta, operations: stagedPlan.operations },
                assumptions,
                approvalRequired: true,
                metadata: { builderRunId: request.id, directorPlanId: buildPlan.directorPlan?.id || null },
            });
            staged = this.ledger.staged(tx.id, stagedPlan, { mutationProposal });
            if (typeof this.persistReviewTransaction !== 'function') { const error=new Error('Lorebook Builder review durability is unavailable.'); error.name='TV2OperatorReviewDurabilityUnavailable'; throw error; }
            await this.persistReviewTransaction(staged.id);
            this.logEvent('builder', 'ledger-staged', {
                runId: request.id, transactionId: tx.id, book: request.book,
                addedCount: validatedDelta.added?.length || 0,
                newNodeCount: validatedDelta.newNodes?.length || 0,
                durationMs: phaseMs(phase),
            }, 'info');
        } catch (error) {
            const current = this.ledger.read(tx.id);
            const terminal = new Set(['committed', 'stale', 'aborted', 'failed', 'cancelled']);
            if (current && !terminal.has(current.state)) {
                try {
                    if (current.state === 'committing') {
                        // Commit/recovery owns this transaction now; a stale UI or
                        // cancelled launch must not terminalize it.
                    } else if (error?.name === 'AbortError' && ['created', 'executing', 'staged'].includes(current.state)) this.ledger.cancel(tx.id, error?.message || 'Lorebook Builder cancelled.');
                    else this.ledger.fail(tx.id, error, { phase });
                } catch {}
            }
            this.logEvent('builder', 'post-gather-failed', {
                runId: request.id, transactionId: tx.id, book: request.book,
                phase, durationMs: phaseMs(phase),
                error: { name: error?.name || 'Error', message: error?.message || String(error) },
            }, error?.name === 'AbortError' ? 'warn' : 'error');
            throw error;
        }

        this.logEvent('builder', 'proposal-staged', {
            runId: request.id,
            transactionId: staged.id,
            book: request.book,
            mode,
            addedCount: staged.staged?.delta?.added?.length || 0,
            newNodeCount: staged.staged?.delta?.newNodes?.length || 0,
        }, 'info');
        return {
            runId: request.id,
            book: request.book,
            mode,
            state: staged.state,
            transactionId: staged.id,
            directorPlan: buildPlan.directorPlan,
            preview: staged.staged?.delta || null,
            mutationProposal: staged.mutationProposal || null,
        };
    }

    async currentAssumptions(book) {
        const inspected = await this.inspect(book);
        return buildBuilderAssumptions({ book, ...inspected });
    }


    async restageEditedTree(transactionId, editedTree, { by = 'operator' } = {}) {
        const ownerKey = String(transactionId || '');
        if (this.restageClaims.has(ownerKey)) {
            const error = new Error(`Lorebook Builder transaction ${transactionId} already has a restage in progress.`);
            error.name = 'TV2BuilderRestageInProgress';
            throw error;
        }
        this.restageClaims.add(ownerKey);
        try {
            const original = this.ledger.read(transactionId);
            if (!original) throw new Error(`Unknown Lorebook Builder transaction ${transactionId}.`);
            if (original.type !== 'lorebook-builder') throw new Error(`Transaction ${transactionId} is not a Lorebook Builder transaction.`);
            if (original.state !== 'staged') throw new Error(`Lorebook Builder transaction ${transactionId} is ${original.state}; only staged proposals can be edited.`);
            const book = original.metadata?.book || original.input?.request?.book;
            const mode = original.metadata?.mode || original.staged?.mode || original.staged?.delta?.mode;
            this.assertWritableBook(book);
    
            const currentAssumptions = await this.currentAssumptions(book);
            const freshness = this.ledger.checkFresh(transactionId, currentAssumptions);
            if (!freshness.fresh) {
                const stale = this.ledger.stale(transactionId, 'Builder preview became stale before operator edits could be restaged.', freshness);
                this.logEvent('builder', 'stale-plan-rejected', { transactionId, book, freshness }, 'warn');
                return stale;
            }
    
            const originalDelta = original.staged?.delta;
            if (!originalDelta?.nextTree?.root) throw new Error('Builder staged transaction has no editable Tree draft.');
            const existingTree = clone(original.snapshot?.tree || null);
            const lorebookInventory = clone(original.snapshot?.inventory || null);
            if (!lorebookInventory?.activeEntries) throw new Error('Builder staged transaction is missing its lorebook inventory snapshot.');
            const { delta, structural } = buildEditedTreeDelta({
                book,
                mode,
                originalDelta,
                existingTree,
                lorebookInventory,
                editedTree,
                now: this.now(),
            });
            const operations = operationsForDelta(delta, book);
            const stagedPlan = createLedgerMutationPlan({
                book,
                mode,
                operations,
                assumptions: original.assumptions,
                delta,
            });
            const replacement = this.ledger.begin({
                type: 'lorebook-builder',
                input: { ...clone(original.input || {}), editedFromTransactionId: transactionId },
                snapshot: clone(original.snapshot || null),
                assumptions: clone(original.assumptions || {}),
                metadata: { ...clone(original.metadata || {}), editedReview: true, editedBy: by },
            });
            this.ledger.executing(replacement.id);
            this.ledger.parsed(replacement.id, { source: 'operator-edited-tree', editedFromTransactionId: transactionId });
            this.ledger.validated(replacement.id, { passed: true, structural, source: 'operator-edited-tree' });
            this.ledger.staged(replacement.id, stagedPlan, {
                mutationProposal: createMutationProposal({
                    transactionId: replacement.id,
                    type: 'lorebook-builder-tree-delta',
                    target: { book, tree: true },
                    draft: { mode, delta, operations },
                    assumptions: clone(original.assumptions || {}),
                    approvalRequired: true,
                    metadata: {
                        builderRunId: original.metadata?.builderRunId || null,
                        directorPlanId: original.input?.buildPlan?.directorPlan?.id || null,
                        editedFromTransactionId: transactionId,
                    },
                }),
            });
            if (typeof this.supersedeReviewTransactionDurably !== 'function') { const error=new Error('Lorebook Builder review supersession durability is unavailable.'); error.name='TV2OperatorReviewDurabilityUnavailable'; throw error; }
            await this.supersedeReviewTransactionDurably(transactionId, replacement.id, `Superseded by operator-edited Builder preview ${replacement.id}.`, { targetLedger: this.ledger });
            this.logEvent('builder', 'proposal-restaged-after-review', {
                book,
                transactionId: replacement.id,
                supersededTransactionId: transactionId,
                addedCount: delta.added?.length || 0,
                newNodeCount: delta.newNodes?.length || 0,
            }, 'info');
            return {
                runId: original.metadata?.builderRunId || null,
                book,
                mode,
                state: 'staged',
                transactionId: replacement.id,
                preview: delta,
                mutationProposal: this.ledger.read(replacement.id)?.mutationProposal || null,
            };
        } finally {
            this.restageClaims.delete(ownerKey);
        }
    }

    async approveAndCommit(transactionId, { by = 'operator' } = {}) {
        const tx = this.ledger.read(transactionId);
        if (!tx) throw new Error(`Unknown Lorebook Builder transaction ${transactionId}.`);
        if (tx.type !== 'lorebook-builder') throw new Error(`Transaction ${transactionId} is not a Lorebook Builder transaction.`);
        const book = tx.metadata?.book || tx.input?.request?.book;
        this.assertWritableBook(book);
        const stagedTree = tx.staged?.delta?.nextTree;
        if (!stagedTree?.root) throw new Error('Builder staged transaction has no next Tree draft.');
        this.ledger.approve(transactionId, { by, metadata: { surface: 'lorebook-builder-preview' } });
        const currentAssumptions = () => this.currentAssumptions(book);
        const nextTree = tx.staged?.delta?.nextTree;
        if (!nextTree?.root) throw new Error('Builder staged transaction has no next Tree draft.');
        const mutation = {
            type: 'tree.replace',
            book,
            loreDependency: true,
            tree: clone(nextTree),
            expectedTree: semanticSnapshot(tx.snapshot?.tree || null),
        };
        const committed = await this.commitMutation(transactionId, mutation, {
            currentAssumptions,
            targetLedger: this.ledger,
            metadata: { source: 'lorebook-builder', mode: tx.metadata?.mode || null },
            committed: result => ({ book, tree: clone(result?.tree || nextTree), delta: clone(tx.staged?.delta || null) }),
        });
        if (committed?.state === 'stale') {
            this.logEvent('builder', 'stale-plan-rejected', { transactionId, book, freshness: committed.freshness }, 'warn');
            return committed;
        }
        this.logEvent('builder', 'committed', { transactionId, book, mode: tx.metadata?.mode, addedCount: tx.staged?.delta?.added?.length || 0 }, 'info');
        return committed;
    }

    cancel(transactionId, reason = 'Lorebook Builder cancelled by operator.') {
        const tx = this.ledger.read(transactionId);
        if (!tx) return null;
        if (['committed', 'stale', 'aborted', 'failed', 'cancelled', 'committing'].includes(tx.state)) return tx;
        if (tx.state === 'staged') {
            const error=new Error('Staged Lorebook Builder review must be cancelled through the durable review boundary.');
            error.name='TV2OperatorReviewDurabilityRequired';
            throw error;
        }
        return this.ledger.cancel(transactionId, reason);
    }

    async cancelDurably(transactionId, reason = 'Lorebook Builder cancelled by operator.') {
        const tx = this.ledger.read(transactionId);
        if (!tx) return null;
        if (['committed', 'stale', 'aborted', 'failed', 'cancelled', 'committing'].includes(tx.state)) return tx;
        if (tx.state !== 'staged') return this.ledger.cancel(transactionId, reason);
        if (typeof this.cancelReviewTransactionDurably !== 'function') { const error=new Error('Lorebook Builder review cancellation durability is unavailable.'); error.name='TV2OperatorReviewDurabilityUnavailable'; throw error; }
        return await this.cancelReviewTransactionDurably(transactionId, reason, { targetLedger: this.ledger });
    }
}
