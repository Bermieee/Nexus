# Summary Digest + Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Unstick Summary→Lore recovery after quota exhaustion and make Summary Bank a temporary staging layer that is removed after durable digestion.

**Architecture:** Preserve canonical mutation ownership and recovery evidence. Compact bulky terminal Operator Review authority and Summary→Lore saga snapshots without deleting unresolved authority. Add durable Summary deletion and destination actions; Lore deletion only occurs after canonical digestion is proven, while permanent memories remain protected.

**Tech Stack:** JavaScript ES modules, Node offline regression tests, SillyTavern chat metadata/localStorage.

**Spec:** Current chat requirements and `Nexus-diagnostics-2026-09-17T03-22-23-307Z.json`.

## Global Constraints

- Sidecars remain transport only; destination subsystems own semantics and mutation authority.
- Work Director/Coordinator ownership remains intact.
- No unresolved recovery evidence is silently deleted.
- Demo and Developer receive the same shared production fix; Demo remains stripped of Developer harness/tests.

---

### Task 1: Compact durable recovery authority
**Files:** Modify `memory/lore-routing-saga.js`, `nexus/operator-review-store.js`, `nexus/transaction-service.js`; test `tests/nexus-065-hotfix46-15-summary-digest-recovery-regression.mjs` and existing saga/recovery tests.
- [ ] Write failing tests for compact saga persistence and compact terminal review receipts.
- [ ] Run tests and verify RED.
- [ ] Implement compact saga schema/migration and terminal review receipt compaction.
- [ ] Run focused recovery/quota tests and verify GREEN.

### Task 2: Forward-reconcile quota-stuck Summary→Lore saga
**Files:** Modify `memory/lore-router.js`; test existing `tests/nexus-lane-b-summary-lore-recovery-regression.mjs` plus new regression.
- [ ] Add failing test reproducing approved/applied child + pre-route Memory + recovery-required parent.
- [ ] Verify RED.
- [ ] Make startup reconciliation prefer proven forward settlement and avoid impossible rollback of approved child.
- [ ] Verify GREEN.

### Task 3: Summary lifecycle simplification and durable deletion
**Files:** Modify `memory/store.js`, `memory/ui.js`, `memory/lore-review-queue.js` as needed; test new regression.
- [ ] Write failing tests for `Digest…`, `Make Permanent`, `Delete`, and hidden maintenance controls.
- [ ] Add durable memory deletion API and permanent=locked semantics from the UI.
- [ ] Auto-delete summaries only after proven direct Lore digestion; keep review-mode proposals until canonical approval.
- [ ] Verify focused tests.

### Task 4: Notebook destination
**Files:** Modify `memory/notebook.js`, `memory/ui.js`; test new regression.
- [ ] Write failing test that selected Summary can update Notebook and is deleted only after durable Notebook save.
- [ ] Implement summary-to-Notebook digestion using the Notebook subsystem.
- [ ] Verify focused tests.

### Task 5: Full gate and packaging
**Files:** `manifest.json`, `core/build-info.js`, package ZIPs.
- [ ] Run standalone Developer tests.
- [ ] Run JS/MJS syntax checks for Developer and Demo.
- [ ] Merge shared production files into Demo without Developer harness files.
- [ ] Seal Developer HOTFIX46.15 and Demo 14.8 packages.
- [ ] Extract sealed ZIPs and rerun focused regressions/syntax.
