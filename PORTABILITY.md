# Portability notes

## Offline-validated startup hardening

Validated offline against the Nexus portability fault harness:

- blocked IndexedDB does not hang startup indefinitely;
- silent IndexedDB open is bounded;
- late IndexedDB success after failed authority is closed/discarded;
- durability stays fail-closed after IndexedDB initialization failure;
- settings template/container/attachment failure reports failed initialization;
- retry after partial initialization rebuilds resources/subscriptions;
- missing optional `deleteWIOriginalDataValue` no longer causes module-link failure;
- renamed installation folder preserves host-relative imports.

## CP004 storage-access hardening

CP004 additionally hardens two browser-storage property-access paths found by the public-release portability audit:

- embedding credential lookup now catches exceptions thrown while obtaining `localStorage` or `sessionStorage` themselves, before calling storage methods;
- observability session persistence now catches denied/throwing `sessionStorage` access and continues diagnostics in memory.

These fixes prevent storage-denial policy from aborting module evaluation or Nexus error reporting. They do **not** make every storage-dependent workflow functional without persistence; durable mutation paths still fail closed when their required authority cannot be established.

## Required browser capabilities for full operation

Full Nexus operation currently assumes a **trusted HTTPS origin** (or the browser's trusted localhost treatment on the host machine). In particular:

- Post-turn, Summary-to-Lore, Builder PlanStore CAS, backup import, and operator-review ownership paths rely on the Web Locks API to preserve single-owner mutation authority.
- Lore and memory vector paging use `crypto.subtle.digest('SHA-256', ...)` for deterministic identity hashing.

Ordinary plain-HTTP LAN-IP access is therefore **not currently certified for full functionality**. Do not remove the Web Locks requirement merely to make HTTP LAN calls proceed; a replacement must preserve the same concurrency and mutation-authority guarantees. Likewise, vector hashing needs an explicit supported cryptographic path before non-secure-context vector paging can be claimed.

## Public-release acceptance still required

Offline source/module checks are not a substitute for real browser acceptance. Before broad public release, verify at minimum:

- clean supported SillyTavern install: module linking, settings mount, enable/disable/reload, one complete turn;
- Windows Chrome, Edge, and Firefox from clean profiles;
- iPhone/iPad Safari over trusted HTTPS, including narrow portrait/landscape dialogs, keyboard, scrolling, uploads/downloads, and touch controls;
- Android Chrome over trusted HTTPS, including background/screen-lock/resume behavior during work;
- storage unavailable/full degraded behavior and recovery;
- competing two-tab mutation/review/Builder/import paths;
- same-chat use from two devices and host conflict behavior;
- provider CORS/mixed-content, invalid key/endpoint, offline/timeout/429 recovery;
- required 20–30-turn medium run and representative endurance run.

A build working on developer localhost is not by itself evidence of phone/browser portability.
