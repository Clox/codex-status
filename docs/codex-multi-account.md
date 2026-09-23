# Codex multi-account workstation setup

This directory records the reproducible, machine-local setup used to switch among three ChatGPT/Codex accounts while retaining one shared Codex conversation history. It contains no account names, tokens, authentication files, session data, or other Codex state.

The setup was last verified on Linux Mint on 2026-09-17 with:

- ChatGPT/Codex Desktop at `/usr/lib/chatgpt/ChatGPT`, launched through `/usr/bin/chatgpt`
- the Desktop-bundled backend at `/usr/lib/chatgpt/resources/codex`
- the OpenAI Codex VS Code extension
- `CODEX_HOME=$HOME/.codex`
- `@loongphy/codex-auth` 0.2.10 and Node.js 22.21.1
- GNOME Terminal for the compact account-status window

Treat these versions and paths as observations, not permanent requirements. Before installing on another computer, read the current [codex-auth README](https://github.com/Loongphy/codex-auth), inspect the installed clients, and adapt only the local configuration values.

## Design and safety rules

All clients use the same `CODEX_HOME`, so the existing conversations and state under `$HOME/.codex` remain shared. `codex-auth` manages account credentials inside that one home and changes the active account. Desktop and VS Code must be restarted or reloaded after a switch.

Do not recreate the old design with separate `CODEX_HOME` directories or SQLite/session synchronization. In particular:

- never copy an old or backed-up `auth.json`; sign in interactively so refresh tokens are fresh
- never copy tokens, `auth.json`, `$CODEX_HOME/accounts`, rollout files, SQLite files, or session state into Git
- do not delete old experimental homes such as `$HOME/.codex-account2` or `$HOME/.config/Codex-account2` during installation
- do not invoke an old `codex-account-script` that swaps `auth.json`
- back up existing launcher/config files before replacing them
- keep `codex-auth` experimental automatic switching disabled for this workflow

The scripts here terminate Codex Desktop politely and wait up to 15 seconds. They deliberately do not use `kill -KILL`, keyboard shortcuts, simulated logout/lock keys, or session-manager commands.

## Fresh installation

1. Inspect the local installation before changing it:

   ```bash
   command -v node npm codex codex-auth chatgpt gnome-terminal
   node --version
   npm --version
   find /usr/lib/chatgpt -maxdepth 3 -type f -name 'codex*' -o -name 'ChatGPT' 2>/dev/null
   ```

2. Read the latest upstream README. Stop before changing Desktop integration if upstream now marks the intended method experimental or the installed Desktop layout is incompatible. This setup does **not** use `codex-auth app`; version 0.2.10 documents switching followed by a client restart for Codex App, VS Code, and CLI.

3. Back up relevant files. Never print or inspect authentication contents in terminal output:

   ```bash
   backup_dir="$HOME/.local/state/codex-auth-setup-backups/$(date +%Y%m%d-%H%M%S)"
   mkdir -p "$backup_dir"
   cp -a "$HOME/.codex/config.toml" "$backup_dir/" 2>/dev/null || true
   cp -a "$HOME/.local/bin/codex-account" "$backup_dir/" 2>/dev/null || true
   cp -a "$HOME/.local/bin/codex-usage-watch" "$backup_dir/" 2>/dev/null || true
   cp -a "$HOME/.local/bin/codex-usage-annotate" "$backup_dir/" 2>/dev/null || true
   cp -a "$HOME/.local/share/applications/codex-account1.desktop" "$backup_dir/" 2>/dev/null || true
   cp -a "$HOME/.local/share/applications/codex-account2.desktop" "$backup_dir/" 2>/dev/null || true
   cp -a "$HOME/.local/share/applications/codex-account3.desktop" "$backup_dir/" 2>/dev/null || true
   cp -a "$HOME/.local/share/applications/codex-usage-watch.desktop" "$backup_dir/" 2>/dev/null || true
   ```

   If an authentication backup is required for disaster recovery, copy it directly into a private directory with mode `0700`; never display it or place it in this repository. Do not restore stale authentication into a new installation.

4. Install Node.js at a version accepted by the current package. Version 0.2.10 requires Node 22.21.0+ or 24.0.0+ for its API-backed usage refresh. Then use the upstream npm installation:

   ```bash
   npm install -g @loongphy/codex-auth
   codex-auth status
   ```

5. Disable the experimental watcher. For the privacy-oriented/local status mode used on the original machine, also disable direct usage API refresh:

   ```bash
   codex-auth config auto disable
   codex-auth config api disable
   codex-auth status
   ```

   Local-only usage can lag by hours because it reads rate-limit events from local rollout files. To deliberately opt into fresher API-backed usage, read the upstream warning first and run `codex-auth config api enable`.

6. Add each account through a fresh interactive login. Do this three times and complete the browser/device flow for the intended account each time:

   ```bash
   codex-auth login --device-auth
   ```

   Do not import old auth backups. Confirm the three accounts with `codex-auth list` in a wide terminal.

7. Run the repository installer. It asks for the exact unique selector of each account in the same top-to-bottom order shown by `codex-auth list`:

   ```bash
   tools/workstation/codex-auth/install.sh
   ```

   The installer only writes user-local utilities, launchers, a private selector config, and a dedicated GNOME Terminal profile. It first backs up files it will replace under `$HOME/.local/state/codex-auth-setup-backups/`. It does not copy or modify conversation files.

## Daily workflow

Open **Codex - Konto 1**, **Codex - Konto 2**, or **Codex - Konto 3** from the application menu. If Desktop is running, the launcher sends it `TERM`, waits for a clean exit, switches with `codex-auth`, and starts Desktop again. Closing an Electron window with its X may leave the process alive; Ctrl+Q normally exits the whole app, but the launcher handles the running process itself.

Open **Codex-kontostatus** for the compact status window. It renders immediately from its last credential-free local frame cache (or an explicit loading state on the first run), then collects the local `codex-auth list --skip-api` view asynchronously. A cheap 200 ms UI tick animates a pending switch without triggering extra account, usage, reset, or server requests; the local account snapshot is collected about every two seconds, while usage/reset background refresh launch remains throttled to the existing ten-second cadence and server usage retains its one-minute cache policy. Accounts are automatically ranked by weekly urgency, with 5H availability breaking near-ties. The active account is identified by `*` and a bold row without an active-specific color; quota and status foreground colors retain their own meaning. The centered `ACCOUNT` heading uses all width left after the fixed metadata columns. The fixed five-cell `STATU` column shows verified account-level exhaustion as `EXHAU`; a selected switch target cycles through yellow `WAIT/`, `WAIT-`, `WAIT\`, and `WAIT|` at five frames per second until the postcondition verifies the new active account. Pressing `1`, `2`, or `3` selects the account at that current rank. Selecting the already-active account opens ChatGPT or asks its existing single-instance process to show the app. The cursor, menu bar, and unnecessary scrollbar are hidden.

The status window and ChatGPT have independent lifetimes. Account switches and ChatGPT launches started from the status window run in a detached session, so closing the terminal does not terminate Desktop. Opening the status window by itself does not open ChatGPT.

The renderer skips terminal writes while the complete rendered frame is unchanged, preserving an in-progress terminal selection across ordinary refresh ticks. Press `P` to freeze status rendering explicitly when copying changing output; the status window shows `PAUSED`, and any switch spinner remains visually frozen, while observer, usage refresh, activation workers and attention continue independently. Press `P` again to resume with an immediate current render.

The fixed eight-cell `RESETS` column shows saved Codex resets as `X×HHH:MM`: the available count and the countdown until the earliest expiration. Counts above nine are presented as `9` so the table remains stable; the underlying reset count is unchanged. A dash means no saved reset. Reset details are refreshed at most once every five minutes from Codex's read-only reset-credit endpoint and cached locally without tokens; all returned expiration times are retained in the private cache. If the service reports a count but omits one or more detail rows, the countdown is shown as unknown rather than guessing. Countdown hours above 999 use the compact `>999h` overflow marker rather than widening the table.

A controlled no-turn experiment verified the semantics of manually redeeming one saved reset. The available credit count fell by exactly one, and both the 5H and weekly windows were restored to fully unused regardless of which pool had been exhausted. Both previous fixed deadlines were replaced by the ordinary dormant representation: `used_percent=0`, full `reset_after_seconds` (`18000` and `604800`), and a synthetic `reset_at` that advances with server observation time. Redeem itself therefore starts neither countdown. The same generic two-observation dormant classifier remains authoritative after a redeem; there is no banked-reset-specific inference path. Saved resets are never redeemed automatically.

The fixed-width usage columns show remaining percentages, a five-cell bar with eighth-cell partial blocks (`▏` through `▉`), and time until reset as `HH:MM`: 15 cells for 5H and 17 for weekly. Percentage and bar use a green-to-yellow/orange-to-red foreground scale; the countdown remains neutral. `PRIOR` is the existing weekly urgency (`weekly remaining / hours until reset`) multiplied by 100 and rounded to an integer for display only; ranking and tolerances still use the unscaled value. `ACTIVITY` occupies eight cells, and `ACCOUNT` receives all remaining terminal width. Usage is fetched independently for every saved account from Codex's read-only usage endpoint and cached locally without tokens. Server refresh runs at most once per minute; terminal animation and local rendering never increase that frequency. A successful observation up to three minutes old is `VERIFIED`; one between three and fifteen minutes old is marked `~`/`STALE` when only a transient refresh error exists. Data older than fifteen minutes, a 401/403, missing credentials, protocol errors, three consecutive failures, or a dead refresh heartbeat is `UNVERIFIED`. Its old percentages may remain visible only as error-marked historical context, `PRIOR` becomes `AUTH` or `ERROR`, a problem section explains the failure, and the values are excluded from ranking and recommendation. Local `last_usage` is only an unverified fallback. Saved-reset data is presentation-only and does not affect ranking or recommendation.

The token-free usage cache also keeps a bounded history of raw 5H and weekly window fields plus local and server observation times. Dormant windows use an empirically verified synthetic rolling deadline: `used_percent=0`, the full `limit_window_seconds` and `reset_after_seconds` (`18000` for 5H or `604800` for weekly), and `reset_at` approximately equal to server observation time plus that full duration. Two fresh VERIFIED observations must show `reset_at` moving forward with the server clock before the state is classified dormant. This distinguishes it from a newly active but still rounded-to-zero window whose deadline remains fixed and countdown decreases. A 5H dormant window is shown as `100% █████ READY`; a dormant weekly window becomes `NEEDS_ACTIVATION` and shows `START`. The display layer itself never triggers a turn, account switch, or auth change; the separately supervised 5H worker described below may act only on the underlying VERIFIED two-observation classification.

The supervised `codex-turn-observer.service` follows append-only rollout lifecycle records without attaching to Desktop's private App Server stdio. A newly observed `task_started` is bound once to the stable registry account identity at observation time; that binding is retained even if the active account later changes. Rollout `session_meta.id` identifies the actual thread; for subagents, `session_meta.session_id` is the parent thread and must not be used as the child identity. Active, pending-error, and terminal events are matched by `(threadId, turnId)`. Guardian/subagent turns keep their distinct child thread IDs and are labeled in the status window. Old records present at first installation are checkpointed at EOF, so restart, suspend, or historical rollout files cannot create ghost-active turns. Upgrading the observer's identity schema discards uncertain old active/pending records and marks old terminal identities unverified rather than treating them as future resume candidates. `task_complete` removes only the matching turn for completed, interrupted, and failed outcomes. Rollout `turn_aborted` is likewise terminal for exactly its `(threadId, turnId)`, clears any pending error for that pair, and is journaled as `aborted`; it never creates verified exhaustion or a resumable candidate. The status window redraws every two seconds and lists credential-free active account/thread/title/state data under `ACTIVE CODEX TURNS`.

Formatted `0%` remaining is never treated as proof of exhaustion. Verified exhaustion requires the terminal App Server semantics: `usageLimitExceeded`, no further retry, and the matching failed completion for the same thread and turn. In the external rollout observer this is represented by Codex's persisted terminal `task_complete` record with `error.codex_error_info=usage_limit_exceeded`, which exists only after the turn has finished its retry lifecycle. Because that record does not identify whether 5H or weekly caused the refusal, neither quota column is labeled exhausted; the account row instead shows `EXHAU` in `STATU` while both trustworthy reset countdowns remain visible. The marker clears only after a later account-bound successful turn or a newer VERIFIED server observation explicitly shows no reached limit and positive remaining capacity in both windows.

Verified terminal exhaustion is also a hard activation exclusion. The 5H worker skips such accounts before it starts the isolated activation path, and both manual 5H and weekly diagnostics check the same persistent observer invariant before setup and again after fresh revalidation immediately before the turn boundary. A displayed `0%` never activates this guard. Activation errors created after the matching verified exhaustion may be reconciled to a non-error `exhausted-skip` state; earlier unrelated failures and uncertain `turn-committed` records remain untouched.

A verified terminal exhaustion on a main user thread is also retained in the credential-free lifecycle state as an `INTERRUPTED CODEX TURNS` candidate. It survives Desktop restarts and account switches independently of Desktop's visual failure marker. Guardian and subagent threads are excluded. A later real turn on the same thread resolves the candidate; a changed or ambiguous identity never creates one.

The status window retains quota-interrupted thread identity as diagnostics but no longer exposes the headless `4`–`9` continuation action as a normal manual workflow. `codex-manual-resume` remains installed for invariant testing and future explicit automation. It requires a healthy observer, no active Codex turns, a fresh VERIFIED and usable target account, the exact persisted `(threadId, turnId)`, and no prior resume commit. It then gracefully closes Desktop and kernel-pauses every VS Code extension host that owns an OpenAI Codex App Server together with its descendants. A detached watchdog restores these clients if the controller exits unexpectedly. The paused processes keep VS Code's in-memory extension state and cannot race the single controlled App Server.

The installed Desktop accepts `codex://threads/<threadId>?prompt=...` and has been observed to populate an unsent composer draft, but it exposes no supported semantic acknowledgement that proves the same exact thread is active after navigation. AT-SPI verification was not stable across Chromium renderer replacement, and clipboard/global-key approaches are intentionally rejected. The status switcher therefore does not yet automate the OFF-mode draft flow; it sends no continuation turn and does not pretend navigation was verified.

The status window always shows `AUTO-CONTINUE: OFF [A] toggle` or `AUTO-CONTINUE: ON [A] toggle`. Pressing `A` changes a private mode-0600 preference under `$XDG_CONFIG_HOME/codex-account-switcher/` and the choice survives status-window restarts. This is deliberately only a persisted policy input until verified automatic exhaustion failover is implemented: `OFF` is the fail-closed default, no current observer or switch path consumes the setting, and banked resets remain excluded from all automatic behavior. Future `OFF` semantics are switch/reopen/navigate without sending; future `ON` semantics may call only the already verified exclusive controller-resume path and must retain its exact-once and fail-closed invariants.

With exclusive ownership established, the controlled server performs `thread/read`, checks that the thread is idle and the quota-failed turn is still the latest turn, and then calls `thread/resume` with the exact original thread ID. Immediately before the sole `turn/start`, it atomically persists `RESUME_COMMITTED`. The continuation message asks Codex to inspect existing work and continue without repeating completed side effects. The controller waits for terminal `turn/completed`, then restores the paused VS Code clients and relaunches Desktop if it had been running. Any uncertainty before commit sends zero turns. Any uncertainty after commit becomes `MANUAL_REQUIRED_AFTER_COMMIT` and is never retried automatically. Approval prompts for command/file actions are shown in the resume terminal; unsupported requests fail closed. This feature never performs account switching, automatic failover, or banked-reset use.

An optional private `activation-holds.json` can hold a stable `chatgpt_account_id` during a weekly-reset observation experiment. A hold blocks automatic 5H and both manual activation turns for that account, but leaves server usage refresh, raw history, ranking and other accounts untouched. The status window shows it under `ACCOUNT INFO`, not as an error. When a weekly observation changes from 0% remaining to 100% with zero raw usage, the cache also pins the preceding observation and the first two post-reset observations with server timestamps and raw weekly fields in `weeklyResetEvidence`; this evidence survives the rolling history limit. Keep the hold until that evidence has been inspected. To release it, set that account's `enabled` to `false` or remove only its account-ID entry from the private hold file; do not delete the usage cache.

After an automatic weekly reset, `/backend-api/wham/usage` reports weekly as 100% remaining with a synthetic rolling 168-hour deadline, not a literal `0:00`: `used_percent=0`, `limit_window_seconds=reset_after_seconds=604800`, and each fresh response moves `reset_at` so it remains approximately 168 hours after the server timestamp. The status window treats the VERIFIED two-observation moving-deadline state as `NEEDS_ACTIVATION`, shows `START` instead of a false score, and temporarily prioritizes one minimal use of that account. Once first use starts a real fixed weekly deadline, the moving-deadline classification disappears and ordinary ranking resumes automatically. Formatted `100%`, `0:00`, or one observation alone never establishes this state.

An account with an explicit `AUTH ERROR` offers `Press [R] to repair authentication`. Repair runs the normal interactive ChatGPT browser login in a private temporary `CODEX_HOME`; it never copies tokens through command arguments, environment variables, logs, or user-visible output. The returned identity must match both the existing account ID and stable account key, and fresh server usage must succeed before codex-auth's supported import path updates the existing snapshot. The target must be inactive, so Desktop and global auth remain on the current verified account. Repair holds the same per-account lock as manual and automatic activation, preventing the target credential from changing during an activation attempt. A wrong-account login, cancellation, failed usage check, or postcondition mismatch changes no persistent state or rolls back the snapshot, registry, global auth, and usage cache. If the broken account is active, switch to another verified account before pressing `R`.

For controlled testing, `codex-weekly-activate <1|2|3>` performs only a read-only preflight: two fresh server observations must prove the VERIFIED moving weekly deadline, and the installed App Server schema is checked. Adding `--execute` still does not immediately send a turn; it requires an exact interactive confirmation phrase. Only then does it start a private temporary App Server, provide external ChatGPT tokens over JSON-RPC stdin, create an ephemeral read-only/no-approval thread, send exactly one minimal turn, and use two fresh post-turn observations to distinguish a real fixed weekly deadline near 168 hours from the dormant rolling deadline. It never switches the global account or restarts Desktop, it does not retry a real turn, and it verifies hashes of the global auth files before and after. This is a manual diagnostic path, not an automatic worker. A 401 requires a fresh interactive login; the tool does not work around stale credentials.

`codex-five-hour-activate <1|2|3>` is the corresponding manual 5H diagnostic. Its initial preflight requires the cache's VERIFIED two-observation `fiveHourDormant=true` classification and then revalidates that classification with fresh server data; `READY`, `100%`, or one observation is insufficient. The confirmation prompt may remain open without making that initial state usable for a later turn. After the exact confirmation phrase, the command repeats the App Server capability check, discards the old 5H observation history for decision purposes, and requires two newly fetched observations to prove VERIFIED dormant state again before it can reuse the isolated App Server turn. It then makes exactly two post-turn usage observations and accepts success only if the dormant classification has disappeared, the new deadline is roughly five hours away, `reset_at` remains fixed, and the countdown decreases. An ambiguous result is reported without retrying the real turn. This command is not an automatic worker.

Verified dormant 5H windows are also activated by the supervised `codex-five-hour-activation.timer` user unit. The timer runs independently of the status window and first forces the ordinary read-only usage refresh. Ranking, recommendation, active account, and user activity are not inputs. A target must have VERIFIED `fiveHourDormant=true`; after selection, two entirely new server observations must prove the same state before the shared isolated App Server mechanism can send exactly one turn. A per-account lock prevents overlap with the manual diagnostic or another worker.

The isolated turn passes no dynamic tools or environments, uses a private empty working directory with a read-only sandbox and no approvals, and explicitly instructs the model not to use tools. It overrides only that ephemeral turn to `gpt-5.6-luna`, reasoning effort `low`, and the `default` service tier; the user's global model and effort settings are never changed. The current experimental App Server schema has no verified switch that removes every built-in Codex tool from the model schema. The client therefore also treats any started tool, command, file-change, web-search, image-generation, or MCP item as a protocol violation and terminates the process. This layered guard and the required turn-level override fields are capability-checked against the installed App Server version, but it is not presented as a stable upstream guarantee that built-in tools are absent.

The token-free `five-hour-activation.json` state is the worker's safety journal. It persists an attempt before the turn boundary and records `turn-committed` immediately before App Server is called. Success, timeout, crash, or ambiguous postconditions after that boundary can never trigger an automatic retry for the same dormant window. The block is cleared only after VERIFIED server data proves an active/non-dormant window, or when a later dormant observation is unambiguously after the successfully recorded fixed deadline. Pre-turn failures use a cooldown and consume no turn. Worker heartbeat, fatal state, and per-account activation errors are shown in the status window's problem section; no credentials, response bodies, or prompts are stored. Weekly windows are never activated by this worker.

Ranking uses `weekly remaining / hours until weekly reset` as its primary signal. Accounts within 10% of the best weekly urgency form a group whose internal order is decided by current 5H quota plus a small bonus for a reset within the next hour. Recommendation follows the highest-ranked usable VERIFIED account even when the advantage is small; it is paused when the active account is STALE or UNVERIFIED. A separate attention policy determines when a switch is worth interrupting the user: ordinary weekly advantage keeps the prior approximately 10% threshold, while a 5H-only advantage requires the active account's reset-aware 5H score to be at or below 10 and the alternative to have both a 10-point and 10% relative advantage. Ordinary attention requires two distinct fresh VERIFIED server observations. VERIFIED `NEEDS_ACTIVATION` and exhausted active quota are immediate special cases. No new arbitrary critical-deadline threshold has been introduced.

On this workstation the status launcher creates a dedicated GNOME Terminal server/window with `CodexStatus` WM_CLASS and `codex-status` role. It deliberately bypasses Linux Mint's `/usr/bin/gnome-terminal` Python wrapper, which can return success without opening the requested isolated-class window, and assigns each server a unique D-Bus app ID. The status process writes a private per-launch readiness marker after its first render. Only failure before that marker is a launch failure; closing an already rendered window later is normal lifecycle and never produces the “kunde inte starta” notification. A singleton lock prevents duplicate status windows. Its X11 controller watches `_NET_ACTIVE_WINDOW` events and sets `_NET_WM_STATE_DEMANDS_ATTENTION` on that exact window without raising or focusing it. Cinnamon briefly flashes the grouped taskbar item and then leaves an attention marker until the window is focused. Focus acknowledges the stable `active account → recommended account : situation class` fingerprint; unchanged recommendations do not re-alert on blur. Two distinct fresh observations of a resolved situation re-arm it. Stale cached usage after suspend cannot trigger attention. This is X11/Cinnamon-specific; on other display stacks the status UI still works but does not request taskbar attention.

The status runtime separately tracks the verified transition from total quota exhaustion to newly available quota. Total exhaustion is armed only when every account has fresh VERIFIED state and is unavailable through verified terminal exhaustion or the server's explicit `ordinary_usage_allowed=false`; displayed `0%` alone never qualifies. A recovery requires fresh VERIFIED `ordinary_usage_allowed=true`, positive usable windows, and no retained terminal exhaustion for at least one account. The transition emits one `notify-send` message naming all recovered accounts and latches the same taskbar-attention mechanism until the status window is focused. It re-arms only after another verified total-exhaustion state; stale or unverified data changes neither state nor notifications.

The digit shortcuts intentionally act immediately. Do not programmatically restart or focus the status terminal while active Codex work is in progress: an accidentally delivered digit can initiate a real account switch and close Desktop.

For VS Code, select the account with the same launcher or run:

```bash
codex-account 2
```

Then run **Developer: Reload Window** in VS Code. The extension and Desktop share `$HOME/.codex`, but each long-running client must reload credentials after the switch.

The machine-controlled VS Code normalization path uses a targeted local extension-host restart and leaves the VS Code root process, windows, open files, and editor state intact. VS Code 1.107.0 exposes `workbench.action.restartExtensionHost` inside the workbench, but neither its installed CLI nor its external URI protocol provides a supported non-UI command channel for invoking that action. The normalizer therefore drains the Codex-owning extension host and App Server only after checking the owning window's real extension-host crash history. VS Code automatically restarts at most two unexpectedly terminated extension hosts in a rolling five-minute window; a third is deliberately suppressed. If another controlled termination would hit that guard, normalization keeps the existing chain running and waits fail-closed until the rolling budget is safe, rechecking observer-idle and target-auth state throughout. It then still requires new host/App Server PIDs, ordinary `CODEX_HOME`, no injected credentials, and a matching read-only `account/rateLimits/read` account ID.

Recovery must treat account state and VS Code process health as separate postconditions. Correct global auth/registry state is not success when the target window lacks a unique healthy Codex extension host/App Server. A recovery controller must normalize or explicitly restore that chain and repeat the read-only account probe even when the requested account was already active.

The targeted account rebind itself was live-verified in both directions on 2026-09-23: primary to alternate and back to primary each produced new extension-host and App Server PIDs, retained ordinary `$HOME/.codex` without injected credentials, and returned the expected target account ID from read-only `account/rateLimits/read`. This does **not** establish safe end-to-end VS Code automation. Several seconds after that test reported both transitions successful, the VS Code root exited with a `watcher.node` core dump and normal VS Code operation was no longer present. Further shutdown/core-dump investigation is deliberately parked.

Automatic exhaustion failover must therefore treat any running or expected VS Code Codex client as an unsupported/unsafe ownership state and fail closed before switching or resuming. It must not claim that VS Code was restored merely because auth was changed or a temporary App Server probe succeeded. The existing manual account-switch and exclusive manual-resume workflows remain the supported fallback; no automatic failover is currently enabled. The root classifier, crash-budget guard, process draining, and account postconditions remain useful safety layers for diagnostics, but are not authorization to automate failover around VS Code.

## Verification

Verify without reading or logging any auth file:

1. Open an existing task under account 1 and add a harmless message.
2. Quit Desktop completely or use the account-2 launcher.
3. Confirm `codex-auth list` marks account 2 active, open the same existing task, and continue it.
4. Repeat for account 3 and then return to account 1.
5. In VS Code, switch once, reload the window, and confirm the extension works with the selected account.

Conversation visibility comes from the shared local state, not from copying authentication. Desktop does not reliably reopen the exact task that was visible before restart; select it again from the task list. This setup intentionally avoids fragile deep-link or UI-automation workarounds.

## Files installed outside the repository

- `$HOME/.config/codex-account-switcher/accounts.conf` — mode `0600`, contains local account selectors and paths
- `$HOME/.local/bin/codex-account`
- `$HOME/.local/bin/codex-account-state`
- `$HOME/.local/bin/codex-auth-repair`
- `$HOME/.local/bin/codex-usage-launch`
- `$HOME/.local/bin/codex-usage-watch`
- `$HOME/.local/bin/codex-status-attention`
- `$HOME/.local/bin/codex-status-preferences`
- `$HOME/.local/bin/codex-quota-transition`
- `$HOME/.local/bin/codex-usage-annotate`
- `$HOME/.local/bin/codex-usage-refresh`
- `$HOME/.local/bin/codex-weekly-activate`
- `$HOME/.local/bin/codex-five-hour-activate`
- `$HOME/.local/bin/codex-five-hour-activation-worker`
- `$HOME/.local/bin/codex-turn-observer`
- `$HOME/.local/bin/codex-vscode-normalize`
- `$HOME/.local/bin/codex-reset-credits-refresh`
- `$HOME/.local/lib/codex-account-ranking.js`
- `$HOME/.local/lib/codex-attention-policy.js`
- `$HOME/.local/lib/codex-account-state.js`
- `$HOME/.local/lib/codex-auth-repair.js`
- `$HOME/.local/lib/codex-reset-credits.js`
- `$HOME/.local/lib/codex-status-render.js`
- `$HOME/.local/lib/codex-status-preferences.js`
- `$HOME/.local/lib/codex-quota-transition.js`
- `$HOME/.local/lib/codex-usage-cache.js`
- `$HOME/.local/lib/codex-weekly-activation.js`
- `$HOME/.local/lib/codex-five-hour-activation.js`
- `$HOME/.local/lib/codex-five-hour-worker.js`
- `$HOME/.local/lib/codex-activation-lock.js`
- `$HOME/.local/lib/codex-activation-account.js`
- `$HOME/.local/lib/codex-activation-hold.js`
- `$HOME/.local/lib/codex-turn-observer.js`
- `$HOME/.local/lib/codex-manual-resume.js`
- `$HOME/.local/lib/codex-vscode-normalize.js`
- `$HOME/.local/lib/codex-usage-format.js`
- `$HOME/.cache/codex-account-switcher/usage.json` — mode `0600`, token-free per-account usage cache
- `$HOME/.cache/codex-account-switcher/five-hour-activation.json` — mode `0600`, token-free worker heartbeat, idempotency and error state
- `$HOME/.cache/codex-account-switcher/reset-credits.json` — mode `0600`, token-free reset count/expiration cache
- `$HOME/.cache/codex-account-switcher/status-window-v2.lock` — singleton lock for the status window; detached Desktop/switch/refresh children explicitly close its descriptor
- `$HOME/.cache/codex-account-switcher/turn-events.json` — mode `0600`, credential-free active-turn, terminal-exhaustion, interrupted-candidate, checkpoint, and observer-health state
- `$HOME/.cache/codex-account-switcher/manual-resume.json` — mode `0600`, crash-safe `RESUME_COMMITTED`/terminal state; contains IDs and error kinds but no credentials
- `$HOME/.cache/codex-account-switcher/vscode-normalize-result.json` — mode `0600`, credential-free VS Code normalization result and diagnostics
- `$HOME/.cache/codex-account-switcher/quota-transition.json` — mode `0600`, credential-free total-exhaustion/recovery notification state
- `$HOME/.config/codex-account-switcher/status-preferences.json` — mode `0600`, persistent fail-closed `AUTO-CONTINUE` preference
- `$HOME/.config/codex-account-switcher/activation-holds.json` — optional mode-`0600` per-account observation holds keyed by stable account ID; contains no credentials
- `$HOME/.local/share/applications/codex-account{1,2,3}.desktop`
- `$HOME/.local/share/applications/codex-usage-watch.desktop`
- GNOME Terminal profile `Codex-status`
- user units `codex-five-hour-activation.service` and `codex-five-hour-activation.timer`
- user unit `codex-turn-observer.service`

Backups created by the installer are local-only under `$HOME/.local/state/codex-auth-setup-backups/`.
