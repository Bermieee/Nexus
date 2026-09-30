# Task 3 — system hand-offs

Scene -> Hot, Scene cast -> Green Room, Hot -> Sensory ActiveContinuity, and Walker -> Hot were already wired on the merged baseline. Each now has an executable integration check; they were not duplicated with another path.

Sensory -> Truth now passes the CandidateBusEnvelope directly into assessWorldTreeCandidates. Envelope candidates retain fused ids, claims/references, provenance and channel nominations; the assessment retains its input envelope, candidate-set identity and fusion receipt. Canonical evidence identity/representation resolves the owner's temporal status rather than attempting to resolve a hashed fusion id as a node id. Legacy Memory arrays remain supported without changing their behavior.

Conversion into renderer-compatible book/uid rows occurs after Truth assessment. Truth labels still reach the existing Lore review/rendering path. Candidate ordering is shared between the ranked envelope and its exposed candidate array, preserving pre-change rendering order. Hot continuity selection moved into a reusable core function without changing its existing 24-row bound.

Verification: all five hand-off tests pass, with actual Scene/Hot/Green Room adapter code and mocked host/provider dependencies; real canonical Lore and Walker traversal feed the actual Hot adapter. Total focused node-test checks: 26 passing. Core port, Truth, Sensory/Walker, Hot, Green Room, Scene and Scatter/Gather focused scripts pass. Syntax and diff checks pass. No real SillyTavern/provider acceptance claimed. Existing tests were not weakened.

Task 4 Diagnostics wiring is not part of this commit. Old port names outside the changed integration surface remain for a coordinated migration; this task does not rename stored keys.
