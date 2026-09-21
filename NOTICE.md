# TV-2 attribution

TV-2 is a new framework derived from ideas and selected implementation patterns in **TunnelVision**, authored by Coneja-Chibi and distributed under the GNU AGPL v3.

The goal of TV-2 is not to patch TunnelVision indefinitely. TunnelVision is treated as a donor/reference implementation while TV-2 moves to a smaller set of explicit architectural primitives: one scheduler, normalized Sidecar transports, proposal-first canon mutations, and a first-class hierarchical Tree.


The TV-2 v0.4 recursive Summary Bank is informed by the **Summaryception** by Lodactio (v5.5.3 reference source), a layered recursive summarization design distributed under AGPL-3.0. TV-2 reimplements the delta-summary/layer-promotion concepts around its own deterministic Lifecycle Scheduler, Sidecar Bus, Tree-aware historical recall, and proposal-first Lore Router; it does not use Summaryception's separate connection/retry orchestration.
