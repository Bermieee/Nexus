# Nexus

**Nexus 0.7.5** is an experimental memory, lore, retrieval, lifecycle, and context-orchestration extension for **SillyTavern**.

Nexus is built for long-running chats and roleplay where context becomes too large and too dynamic to manage by hand. It maintains structured memory, selects relevant lore, tracks scene state, coordinates background model work, and presents proposed mutations for review instead of blindly rewriting your data.

> **Alpha software:** back up your SillyTavern data before testing. This release is intended for testers and active development feedback, not a finished 1.0 distribution.

## Install through SillyTavern

Nexus is distributed as a Git-installed third-party extension so future alpha updates can be pulled through SillyTavern's extension manager.

1. Open **Extensions** in SillyTavern.
2. Choose **Install Extension**.
3. Enter this Git repository URL:

   `https://github.com/Bermieee/Nexus`

4. Install the extension from the default **`main`** branch and reload SillyTavern if requested.
5. Open **Nexus** and enable it for testing.

To update later, open **Extensions → Manage Extensions**, find Nexus, and use the normal update action. The public tester/update channel is the default **`main`** branch.

## First-run model access

You do **not** need Sidecars to begin testing Nexus.

On a fresh install, **Main LLM access is enabled by default for Nexus model-worker tasks**. Once Nexus itself is enabled, it can use the model already connected through SillyTavern when no eligible Sidecar is available.

You can turn Main access off at any time in Nexus settings. Existing installations that already saved Main access as **Off** keep that choice; this alpha does not overwrite an explicit saved setting.

### Optional Sidecars

Sidecar A and Sidecar B are optional worker connections for users who want Nexus background work separated from the foreground RP model or distributed across additional models/providers.

- Sidecars ship **disabled and unconfigured**.
- No OpenRouter, provider, embedding, or Decision Core API keys are included in the repository or release ZIP.
- Configure your own endpoint, model, and credentials in Nexus if you want to use Sidecars.
- Reasoning defaults to **Auto**, allowing Nexus to choose an appropriate reasoning level for supported worker tasks.

Decision Core/Jev is also optional. Nexus correctness must not depend on configuring Jev.

## What Nexus currently does

The 0.7.5 release includes the current integrated Nexus runtime, including:

- scene scanning and Change Gate lifecycle decisions;
- Tree-based lore retrieval and bounded lore injection;
- Summary and Memory Banks;
- Notebook/world-state continuity;
- Smart Context warming and vector paging;
- Character Banks;
- Lorebook Builder / Builder 2 workflows;
- proposal review, mutation ownership, and transaction safeguards;
- provider-neutral Decision Core integration;
- dual Sidecar scheduling and batching;
- diagnostics, telemetry, lifecycle inspection, and export tools.

Some developer/test harness surfaces are still present in this alpha. They will be cleaned up for the 1.0 distribution after the runtime has had broader real-world testing.

## Current testing target

The primary alpha target is:

- current SillyTavern;
- desktop browser;
- SillyTavern accessed through **localhost** or another trusted secure origin.

Remote and phone usage is **experimental**. If you access SillyTavern remotely, use trusted **HTTPS**.

Plain HTTP LAN-IP access such as `http://192.168.x.x:...` is not currently a full-functionality supported environment. Some Nexus mutation coordination requires the browser **Web Locks API**, and vector identity work uses **`crypto.subtle`**; browsers may withhold those capabilities on insecure origins.

See [`PORTABILITY.md`](./PORTABILITY.md) for the technical portability boundary.

## Backups and mutation safety

Nexus performs durable state and lore operations. During the alpha:

- keep normal SillyTavern backups;
- review proposals before applying destructive or structural changes;
- do not bypass Nexus warnings about unavailable durability or mutation authority;
- if a workflow fails closed, export diagnostics before repeatedly retrying the same mutation.

Nexus full-backup exports omit provider API keys by default. Secret credentials are only included when you explicitly choose the backup option that includes provider keys.

## Reporting a bug

Good alpha reports are much more useful than screenshots of a red toast by itself.

When something goes wrong:

1. Note what you were doing and what you expected to happen.
2. Export **Nexus Diagnostics** as soon as practical.
3. If the problem involves a particular worker, use **Export A** or **Export B** for that Sidecar's request log.
4. Include the Nexus version/release name (`0.7.5`) and your SillyTavern version.
5. Describe whether the problem reproduces after a normal page reload.

Please remove any private story text, credentials, or other material you do not want to share before posting diagnostics publicly.

Use the repository's **Issues** page for reproducible bugs and tester feedback:

`https://github.com/Bermieee/Nexus/issues`

## Alpha release identity

Public artifact:

`Nexus-0.7.5.zip`

Nexus 0.7.5 is promoted from the validated Development integration line containing the Prompt Loader adapters, tasks #192/#193/#196, task #197 UI/wiring cleanup, and the retained performance speed pass.

## License

No open-source license has been granted at this time. Source is public for alpha testing and inspection; public visibility by itself does not grant permission to redistribute, relicense, or incorporate Nexus into another project.

## Credits

Nexus is built from the TunnelVision lineage and has evolved into a broader multi-lane memory, retrieval, lifecycle, and decision architecture for SillyTavern.
