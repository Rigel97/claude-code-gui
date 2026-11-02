# Claude Code GUI

[简体中文](README.md) · [English](README.en.md)

A futuristic desktop GUI for [Claude Code CLI](https://code.claude.com/docs/en/overview): multi-tab parallel conversations, image input, streaming chat, a cinematic 3D Agent execution observatory, tool-call visualization, line-level diffs, a file tree, cross-session search, a token usage dashboard, AI session naming, a Git changes panel, a TodoWrite progress panel, a file previewer, a project management center, an optional live video background, and an interactive whale-girl companion.

---

## Features

### Conversations and execution

- **Multi-tab parallel conversations** — Run several sessions side by side in one window. Each tab has isolated messages, queue, context meter, input draft, and its own CLI process. Background tabs keep streaming and auto-continue their queues.
- **Streaming chat** — Token-by-token rendering from the CLI's `stream-json` output, with expandable thinking blocks. Immutable state updates and `React.memo` keep long conversations smooth.
- **Image input** — Paste screenshots with `⌘V`; they are saved to a temp directory and attached as `@path` references. File drag-and-drop is supported too.
- **Everything is copyable** — Replies, thinking, and tool output are selectable; hovering a message reveals a copy button. Standard Edit menu roles keep `⌘C` / `⌘A` reliable on macOS.
- **Tool-call visualization** — Bash, Read, Write, Edit, and other calls render as collapsible cards with status indicators; sub-agent (`Task` / `Agent`) output nests under its parent call.
- **Interrupt and retry** — `ESC` or the stop button aborts only the active tab. The child process gets `SIGTERM`, then `SIGKILL` after a timeout (tree-kill via `taskkill` on Windows). A failed latest turn can be removed and resent.
- **Message queue** — Messages typed during generation join that tab's queue and auto-send when the turn completes; failed turns drop their queue so it never bleeds into the next instruction.
- **Background notifications** — A system notification with a prompt snippet appears when a task finishes while the window is not focused.

### 3D Agent execution observatory

Open **Agent 执行空间** for a lazy-loaded Three.js command center driven by the real execution graph:

- Stable relationship-driven layout: a central orchestrator, permanent sub-agent sectors, DAG-ranked tool layers, a lower artifact lane, and a separate task rail. Independent calls stay parallel instead of becoming a fake serial chain.
- Live, historical replay, and clearly labeled demo data. Unknown values stay `—`; `LIVE` never invents missing nodes or metrics.
- Distinct call/delegation/dependency/read/write/retry links, directional particles only on active paths, real upstream/downstream highlighting, branch collapse, node search, a detail inspector, timeline replay, and terminal-state protection.
- Camera flights, layered materials, automatic quality scaling, and rendering optimizations for large graphs.

### Project management workbench

The project center turns conversation history into trackable long-term projects. Recognition results are never written automatically; every candidate must be reviewed.

- **Two recognition modes**
  - **LLM semantic recognition** (default): after an explicit scope/privacy/budget confirmation, bounded history excerpts are sent to the model configured for Claude Code. The snapshot is frozen at consent time and single-use.
  - **Local rules mode**: fully offline, no upload, no model cost. Short Q&A and trivial edits never become projects.
- **Controllable scanning**
  - Both preparation and scanning can be cancelled; late results from a cancelled run do not resurrect the review.
  - After a renderer reload, `activeJob` reconnects to a still-running background scan without paying for a new model call.
  - Progress updates for large histories are coalesced, preventing hundreds of IPC updates from overwhelming the renderer.
- **Per-field evidence review**
  - Background, constraints, decisions, and deliverables each show quoted source text, model interpretation, or unknown provenance.
  - Non-empty model interpretations, unknown fields, and newly user-edited values must be explicitly checked as reviewed; clearing unreliable content also counts as an explicit decision.
  - Candidate details include a name/goal/description change preview, sources, tasks, working directory, linked conversations, and potential conflicts.
  - Associating an archived or deleted project requires an explicit restore-and-associate checkbox.
- **Recoverable review drafts**
  - Use “Later” or press `Escape` to close the review overlay. The draft stays in memory and is atomically persisted to `userData/claude-gui-projects-review.json`.
  - After a window reload or app restart, review can continue without another paid model call.
  - Only an explicit “discard review” deletes the draft. A corrupted draft blocks overwriting until it is explicitly discarded.
- **Project lifecycle**
  - Active projects, archived projects, and the recycle bin have independent counts and filters. Archived and recycled projects are read-only until restored.
  - Merging folds sources, files, tasks, and pending items into the target; the source moves to the recycle bin. Restoring the source does not undo merged content and may create duplicates.
  - Permanent purge is allowed only for recycled projects and releases storage capacity.
- **Tasks, acceptance, and workflow**
  - Required and optional tasks are counted separately. If every required task is cancelled or only optional tasks remain, progress reads “not applicable” instead of faking 100%.
  - Goal acceptance is always explicit. Changing the goal, deliverables, or required-task scope automatically invalidates acceptance and records the reason.
  - The workflow view draws a DAG from real dependency edges with branch/merge support, zoom/pan, and viewport culling. An isolated node only means no recorded edge; it does not prove the absence of dependencies.
- **Working directory and conversation links**
  - A project's working directory must be set explicitly. It never silently inherits the global directory or the first historical source directory.
  - “Continue project” only creates a draft with a project brief; it never auto-sends. You can start a task-specific conversation, reopen the most recent linked conversation, or link the current conversation.
  - Each linked run records its status and an excerpt for manual review. A finished run or conversation never auto-completes a task or the project.
- **Concurrency and data ownership**
  - Project writes use a monotonic `revision` plus `expectedRevision` for optimistic concurrency. Conflicts preserve local data and dirty flags instead of overwriting.
  - Task evidence (`records`), source references, lifecycle fields, and review evidence are server-owned; ordinary patches cannot forge or clear them.
  - Recognition and project writes have independent lifecycles: projects remain savable while a scan runs.
- **Storage, capacity, and recovery**
  - Projects live in `userData/claude-gui-projects.json`, written with a temp file + `fsync` + `rename`. The previous valid snapshot is kept as `.bak`.
  - The Data Management panel shows storage usage, project count, recycle-bin count, and backup availability. At 85% it warns but never auto-cleans.
  - Explicit reload and backup restore are available. Before restoring, the current corrupted file is preserved as `.corrupt`; nothing is silently overwritten.
  - Limits: 32MB primary store, 10,000 projects, 8MB review draft.

### Sessions, search, and editing

- **Unsaved-change protection** — Project background, task editing, retrospectives, and project creation each maintain dirty flags. Switching tabs, leaving a project, switching tasks, and closing the window all prompt. A failed write restores the dirty flag so a failed action does not lose the draft.
- **Per-conversation input drafts** — Drafts are bound to a `conversationId`. Switching tabs, creating a conversation, or opening an archived session never overwrites another tab's draft. Sending without a working directory is blocked and the text is preserved.
- **Slash commands** — Type `/` for `/review`, `/fix`, `/test`, `/commit`, `/clear`, and more.
- **Cross-session search** — `⌘F` / `Ctrl+F` searches all open tabs and archived sessions; jumping routes to the right tab and highlights the hit. Navigation is subject to the same unsaved-change guard.
- **Token usage dashboard** — Last 14 days aggregated in the local timezone, with input/output breakdown, totals, and top-consuming sessions.
- **Context meter and compact** — A zero-cost CLI `/context` query shows real context usage; the archive icon next to it compacts the session.
- **File tree and preview** — Browse the project directory and click a file to insert an `@path` reference. Preview syntax-highlighted text (512KB cap, binary detection, truncation notice) and common image formats.
- **Line-level diff** — `Edit` / `Write` / `MultiEdit` calls render red/green diffs with collapsible context. A custom LCS engine degrades gracefully on huge files.
- **Git changes panel** — Shows the current branch and working-tree changes. Files touched by Claude in the active session get an AI badge; expand a unified diff or revert a single file after confirmation.
- **TodoWrite progress** — `TodoWrite` calls become a live checklist with a progress bar, per-item status, and the current in-progress task; the list is rebuilt when reopening an archived session.
- **AI session naming** — After the first completed turn, a low-cost background CLI call generates a concise title. Manual renames are never overwritten.
- **Pinning and persistence** — Pin sessions to the top of the sidebar. Tabs, drafts, history, and settings survive restarts. Interrupted conversations are archived as drafts and remain resumable via `--resume`.

### Appearance and companion

- **Cyberpunk UI** — Particle network background, scan lines, and glow effects (Tailwind CSS).
- **Live video background (opt-in)** — Choose a local video (mp4/webm/mov/m4v/ogv) from **Settings → Dynamic Video Background**. It plays muted, looping, and cover-fitted, with a darkening overlay for readability. A privileged `bgmedia://` protocol provides HTTP Range streaming and only ever serves the selected file. Playback pauses when the window is hidden and falls back to the default background if the file moves or is deleted.
- **Whale-girl companion** — A draggable mascot that reacts to Claude Code sessions launched inside this GUI (working, tool type, completion, errors). It includes original artwork, dialogue, feeding, games, growth, achievements, weather effects, and optional local speech. Configure it from **Settings → 鲸鱼娘** or the mascot context menu.

## Prerequisites

- **Node.js** 18+
- **Claude Code CLI** installed and available in `PATH` (`claude --version` should work)
- macOS is the primary verified packaging target

## Getting started

```bash
git clone https://github.com/Rigel97/claude-code-gui.git
cd claude-code-gui
npm install
```

**Development mode** (Vite dev server + hot reload):

```bash
npm run dev
```

**Production mode** (build, then launch):

```bash
npm start
```

**Run tests**:

```bash
npm test
```

**Package a distributable** (macOS `.dmg` + `.zip`):

```bash
npm run dist        # .dmg and .zip in release/
npm run pack        # unpacked .app only, faster for debugging
```

`npm run pack` writes and ad-hoc signs `release/mac-arm64/Claude GUI.app`. Use `npm run dist` when you also need fresh installer archives.

## Usage

1. Pick a working directory on the welcome screen or in the sidebar. New tabs snapshot it; already-running tabs are unaffected.
2. Click **＋** in the tab bar to open a new conversation tab; tasks in different tabs run in parallel.
3. Type a message and press `Enter`; `Shift+Enter` inserts a newline. Paste screenshots with `⌘V`; type `/` for slash commands; `ESC` interrupts only the active tab.
4. Messages typed during generation join the current tab's queue and auto-send when the turn completes.
5. `⌘F` / `Ctrl+F` searches all tabs and archived sessions.
6. Click a session in the sidebar to open it as a tab; already-open sessions just activate. Hover to rename, export, or delete.
7. Click **TOKENS** in the lower-left to open usage; hover the context meter for details and click the archive icon to compact the session.
8. Open the **Git** sidebar tab to review changes from the current session (AI badge) and revert single files; click the eye icon in the file tree to preview a file.
9. Open the **Project Management Center**:
   - Choose a recognition mode and scope; confirm the send scope, privacy, and budget before starting.
   - Review every field's evidence, edit name/goal/description, and create, associate, or skip each candidate.
   - Use “Later” when interrupted; drafts survive reloads and restarts.
   - Inside a project, maintain background, working directory, tasks, workflow, linked conversations, and retrospectives. Goal acceptance always requires a manual confirmation.
10. Open **Agent 执行空间** for the 3D execution graph. `Live` uses real events; `Demo` uses explicitly labeled fixture data. Drag to rotate, scroll to zoom, click a node for its upstream/downstream path and output, and use the timeline to replay. `Space` pauses/resumes scene animation, `R` resets the camera, `F` focuses the selected node, and `Esc` clears selection.
11. The whale girl floats inside the app window. Click to interact, drag to reposition, or right-click for feeding, games, and settings. Use **Settings → 鲸鱼娘** to control dialogue, effects, tool poses, weather, and opt-in local speech.
12. For an animated backdrop, open **Settings → Dynamic Video Background**, pick a local video, and toggle it on or off. Low-bitrate loopable clips are recommended to keep power draw minimal.

## Project recognition: privacy, cost, and evidence

LLM recognition sends conversation excerpts (user/assistant text and whitelisted tool summaries; never thinking blocks, file contents, or full tool output) to the model service configured for Claude Code. A consent dialog shows data volume, sample excerpts, and a per-run budget cap before anything is sent. The snapshot is frozen at consent time and single-use. Cancelled, timed-out, or failed runs may still incur API costs.

Model output is never trusted blindly: task status, actual file outputs, and dependencies must be backed by locally verifiable structured evidence; everything else is downgraded to “pending confirmation”. Every non-empty model interpretation and unknown field must be checked in the review layer. Local rules mode is fully offline and free.

## Permission modes

In non-interactive (`-p`) mode the CLI needs a permission mode, configurable in **Settings**:

| Mode | Behavior |
|------|----------|
| `bypassPermissions` (default) | All tool calls auto-approved; use only in projects you fully trust |
| `acceptEdits` | File edits auto-approved; shell commands may still be rejected |

## Custom models and endpoints

The model field is passed through verbatim as `--model`, so custom endpoints (GLM, Bedrock, etc.) work by entering the full model ID in **Settings**; leave it empty to follow the CLI default.

## Data and recovery

- Session config: `userData/claude-gui-config.json`
- Project archive: `userData/claude-gui-projects.json`; previous valid snapshot: `claude-gui-projects.json.bak`
- Pending review draft: `userData/claude-gui-projects-review.json`
- Project writes use atomic replacement and refuse to overwrite externally modified or conflicting data.
- A corrupted config enters a read-only hold: the file is never overwritten or cleared, in-memory sessions and drafts stay protected by the close guard, and an explicit reload can merge repaired disk content with memory.
- Before a project backup is restored, the current corrupted file is preserved as `.corrupt`. Restore always requires explicit confirmation.
- Apart from a user-confirmed LLM recognition run, session and project data are not uploaded.

## Tech stack

- **Electron** — The main process spawns the CLI with `-p --output-format stream-json --verbose`; each tab has an independent runner and every stream/status event is tagged with a `conversationId`. `electronFuses` disables `runAsNode`.
  - Security hardening: context isolation, no Node integration in the renderer, intercepted navigation/window-open, and markdown links opened only through the system browser.
  - Single-instance lock; a second launch focuses the existing window.
  - Close guard: renderer `beforeunload` plus a native Electron `will-prevent-unload` confirmation.
- **React 18 + TypeScript** — Renderer UI.
- **Zustand** — State management with per-conversation isolation. Streaming shards of one message merge by `message.id`; events route by `conversationId`.
- **Persistence** — A custom JSON store in `userData` with temp file + `fsync` + `rename`; config writes are throttled to 3 seconds with a trailing write and a pre-close flush.
- **Three.js + @react-three/fiber** — Lazy-loaded 3D execution scene, instanced nodes, metallic/glass materials, bounded particles, post-processing, and quality degradation.
- **Tailwind CSS** — Dark sci-fi theme.
- **Vite** — Renderer build; **Vitest** — unit/integration tests; **Playwright** — optional real-browser regression.

## Repository layout

```
src/
├── main/          # Electron main process: CLI runner, IPC, file tree, persistence, projects backend
└── renderer/      # React app, whale status bridge, public/whale assets
tests/             # Vitest: state machine, diff, runner, whale bridge, agent graph/layout,
                   # projects backend/LLM validation/scan cancellation/job recovery/data recovery,
                   # plus browser regressions
scripts/           # packaging and signing helpers
```

## Testing

**519 unit/integration tests pass**; 17 optional tests that require a real CLI or browser are skipped by default.

- `tests/store.test.ts` — message merging by `message.id`, multi-tab isolation and routing, background queue continuation, close-tab draft archiving, legacy migration, malformed-event hardening, immutable updates.
- `tests/diff.test.ts` — LCS diff correctness, huge-input fallback, context folding.
- `tests/runner.test.js` — real subprocess lifecycle: normal completion, abort/resend isolation, SIGKILL fallback, invalid cwd, parallel runners with per-conversation tagging.
- `tests/whale.test.ts` — Claude Code to mascot status mapping, privacy boundary, completion/abort handling.
- `tests/projects-backend.test.js` — recognition rules, confirmation gating, atomic persistence, task status/dependency validation, protecting user edits on re-recognition, lifecycle and backup restore.
- `tests/projects-llm.test.js` — LLM contract: citation validation, status/IO/dependency grounding in real evidence, cross-batch grouping, cancellation and budget handling.
- `tests/projects-analyzer.test.js` — tool-free Claude CLI invocation: stdin-only prompts, disabled tools/MCP/skills/session persistence, timeout and process-group termination, malformed output rejection.
- `tests/projects-llm-backend.test.js` — consent gating, single-use frozen snapshots, early-cancel races, no silent rules fallback.
- `tests/projects-jobs.test.js` — job lifecycle, prepare/scan cancellation, `activeJob` recovery, progress coalescing, serialized review-draft persistence, corruption protection.
- `tests/projects-links.test.js` — conversation links, run records, strict revision patches, task-evidence ownership, read-only lifecycle, capacity and corrupt-disk recovery.
- `tests/projects-scan-cancel.test.js` — immediate cancellation during large-file reads, limits, monotonic progress, and handle closing.
- `tests/project-store.test.ts` / `tests/project-model.test.ts` — renderer gating, revision conflicts, review-draft recovery, progress/acceptance derivation, workflow DAG layout.
- `tests/agent-model.test.ts` / `tests/agent-layout.test.ts` — real CLI event adaptation, relationship edges, terminal-state protection, stable DAG ranks, collision-free layout.
- `tests/config-store.test.js` — atomic config writes, corrupted-file read-only protection, explicit recovery, write-failure preservation.
- `tests/e2e-partial.test.ts` — opt-in (`RUN_E2E=1`) real Claude CLI tool-loop verification.
- `tests/project-ui.test.ts` — opt-in (`RUN_PROJECT_UI=1`) real-browser E2E: review, lifecycle, conversation links, draft recovery, and write-failure protection.
- `tests/config-ui.test.ts` — opt-in (`RUN_CONFIG_UI=1`) config persistence, per-tab draft isolation, close guard, and recovery.

Run the optional real-CLI test:

```bash
RUN_E2E=1 npx vitest run tests/e2e-partial.test.ts
```

It launches the real Claude CLI and may incur API costs. Type checking and build:

```bash
npm run typecheck
npm run build
```

## Notes and limitations

- The model field is passed through as `--model`; leave it empty to use the CLI default.
- Project recognition uses Claude Code CLI credentials and may incur API costs; the consent dialog enforces a per-run budget cap.
- Primary store limits: 32MB and 10,000 projects; review draft limit: 8MB. Capacity thresholds only warn; data is never auto-deleted.
- macOS is the primary verified platform; Linux/Windows are not fully verified for the mascot and live video background. Windows keeps the `.cmd` shim and `taskkill` handling.
- The mascot only follows Claude Code sessions launched inside this GUI. It does not read prompts, tool arguments, or tool output. Its growth and achievements live under `whale-moe:*` in renderer storage, separate from session history.

## License

The GUI is MIT-licensed. Whale artwork and original mascot scripts are adapted from [Sutera-Diffusus/dsh-whale-musume](https://github.com/Sutera-Diffusus/dsh-whale-musume) (MIT); the original copyright notice and license are preserved in [`src/renderer/public/whale/LICENSE`](src/renderer/public/whale/LICENSE).
