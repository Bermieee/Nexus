# Activity Feed: story log (Part 2)

The feed is a turn-by-turn story log. It shows what changed in the story, what the player
received, and what needs the player. Engine internals are in Diagnostics.

## What is a row

| Event | In the feed | How |
|---|---|---|
| Learned: new memories, World Tree growth, character memory | Yes | Inside the turn row |
| Injected: lore and memory in the prompt, with the token total | Yes | One line inside the turn row |
| A new scene | Yes | Inside the turn row (with its place when known) |
| Proposals that need the player | Yes | Own highlighted row, outside the turns, pinned at the top |
| Problems that affect the story | Yes | Inside the turn row, in plain words, and in the Problems tab |
| Gather counts | Only on a problem | Late, stale or invalid greater than zero |
| Scatter, Scheduler, Jev records, retrieval channels, Walker, Truth, Sensory, sidecar requests, budget plans, World Tree "Processing details", growth "Wait" | No | Diagnostics only |

`src/ui-core/activity-story.js` is the complete list of what can become a feed item; any event it does
not name produces no row. Lore imports, owner edits and no-op World Tree writes are not story learning.

## Row format

One collapsed row per turn: label `Turn N`, a one-line summary (for example
`Scene + 3 lore added · 2 learned · 1 problem`), time, and the existing expand arrow. Expanded, it
shows child rows in the same layout (icon, label, one-line summary, time): Added, Learned, Problem.
Each child links to its trace in Diagnostics. There are no cards or text blocks.

`N` is the player's message count when the event was recorded, so it is stable across reloads. A
swipe or regeneration of the same turn stays one row. Events that name no turn attach to the nearest
turn of the same chat by time. If no event carries a turn number, rows are numbered in order.

## Tabs and header

Story (default), Memory, Proposals (badge while one is waiting), Problems. There is no All or System
tab; "View system events" opens Diagnostics. One status dot replaces the Main / A / B / Running /
Queued strip; its tooltip holds the same details. "Main disabled" is a configuration, not a problem,
so it never changes the dot.

## Proposals

Pending proposals (those that need the player: pending or recovery-required) come from the proposal
store and stay pinned until the player acts. A proposal being committed, or already resolved, is not
shown. Clearing the visible feed never hides one.

## Identity on events

So that turns group by fact and not by guesswork, the story events carry `chatId`, `generationId`
and `turn`: retrieval and memory-recall `injection-complete`, World Tree intake `applied` and
`applied-deterministic`, and the scene `scanner-observed` event (which also carries the place).

## Limits

- The Diagnostics link opens the Diagnostics workspace and publishes the trace target (chat, generation,
  turn, event ids). It does not pre-select that turn inside Diagnostics.
- Character state changes appear as Learned only through World Tree intake from character memory and
  card sources. Other character writes are not separately reported.
- Events emitted without chat or turn identity (for example a memory summary created in the
  background) are attached by time, which can place a late post-turn event on the next turn.
- The rendering is covered by tests against a fake DOM. A live chat is needed to judge how it reads.
