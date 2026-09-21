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

Open **Codex-kontostatus** for the compact status window. It refreshes every ten seconds without clearing the visible terminal buffer. Accounts are automatically ranked by weekly urgency, with 5H availability breaking near-ties. The active account is green and explicitly marked `ACTIVE`; a recommendation below the table says whether to stay or switch. Pressing `1`, `2`, or `3` selects the account at that current rank. An inactive account is immediately marked yellow and launches the existing safe switcher; it becomes green once `codex-auth` reports it active. Selecting the already-active account opens ChatGPT or asks its existing single-instance process to show the app. Input other than those digits is ignored and the cursor, menu bar, and unnecessary scrollbar are hidden.

The status window and ChatGPT have independent lifetimes. Account switches and ChatGPT launches started from the status window run in a detached session, so closing the terminal does not terminate Desktop. Opening the status window by itself does not open ChatGPT.

The `RESETS` column shows saved Codex resets as `XX×HHH:MM`: the available count and the countdown until the earliest expiration. A dash means no saved reset. Reset details are refreshed at most once every five minutes from Codex's read-only reset-credit endpoint and cached locally without tokens; all returned expiration times are retained in the private cache. If the service reports a count but omits one or more detail rows, the countdown is shown as unknown rather than guessing. Countdown hours are allowed to exceed 999 and the column expands only when necessary.

The usage columns show remaining percentages, a rounded eighth-block indicator (` `, `▁` through `█`), and time until reset as `HH:MM`. `W%/H` shows weekly percentage remaining per hour until the weekly reset, which is the same urgency value used by the ranking. Usage is fetched independently for every saved account from Codex's read-only usage endpoint and cached locally without tokens. Server refresh runs at most once per minute while the UI can continue redrawing every ten seconds. A successful observation up to three minutes old is `VERIFIED`; one between three and fifteen minutes old is marked `~`/`STALE` when only a transient refresh error exists. Data older than fifteen minutes, a 401/403, missing credentials, protocol errors, three consecutive failures, or a dead refresh heartbeat is `UNVERIFIED`. Its old percentages may remain visible only as red historical context, `W%/H` becomes `AUTH` or `ERROR`, a problem section explains the failure, and the values are excluded from ranking and recommendation. Local `last_usage` is only an unverified fallback. Saved-reset data is presentation-only and does not affect ranking or recommendation.

The token-free usage cache also keeps a bounded history of raw 5H and weekly window fields plus local and server observation times. A 5H window is shown as `100% █ READY` only after two fresh verified observations prove that its full five-hour deadline moves forward with the server clock. A single `100% (5:00)` or rounded zero usage is never enough, and a fixed deadline remains an active countdown. The display layer itself never triggers a turn, account switch, or auth change; the separately supervised 5H worker described below may act only on the underlying VERIFIED two-observation classification. Weekly activation keeps its existing rule while the raw history is collected for a future empirically verified model.

An optional private `activation-holds.json` can hold a stable `chatgpt_account_id` during a weekly-reset observation experiment. A hold blocks automatic 5H and both manual activation turns for that account, but leaves server usage refresh, raw history, ranking and other accounts untouched. The status window shows it under `ACCOUNT INFO`, not as an error. When a weekly observation changes from 0% remaining to 100% with zero raw usage, the cache also pins the preceding observation and the first two post-reset observations with server timestamps and raw weekly fields in `weeklyResetEvidence`; this evidence survives the rolling history limit. Keep the hold until that evidence has been inspected. To release it, set that account's `enabled` to `false` or remove only its account-ID entry from the private hold file; do not delete the usage cache.

After an automatic weekly reset, Codex can report `100%` with `0:00` until the account is used once. The status window treats this as `NEEDS_ACTIVATION`, shows `START` instead of a false W%/H value, and temporarily prioritizes one minimal use of that account. Once Codex reports a normal future weekly reset, ordinary ranking resumes automatically.

An account with an explicit `AUTH ERROR` offers `Press [R] to repair authentication`. Repair runs the normal interactive ChatGPT browser login in a private temporary `CODEX_HOME`; it never copies tokens through command arguments, environment variables, logs, or user-visible output. The returned identity must match both the existing account ID and stable account key, and fresh server usage must succeed before codex-auth's supported import path updates the existing snapshot. The target must be inactive, so Desktop and global auth remain on the current verified account. Repair holds the same per-account lock as manual and automatic activation, preventing the target credential from changing during an activation attempt. A wrong-account login, cancellation, failed usage check, or postcondition mismatch changes no persistent state or rolls back the snapshot, registry, global auth, and usage cache. If the broken account is active, switch to another verified account before pressing `R`.

For controlled testing, `codex-weekly-activate <1|2|3>` performs only a read-only preflight: it verifies fresh server usage and checks the installed App Server schema. Adding `--execute` still does not immediately send a turn; it requires an exact interactive confirmation phrase. Only then does it start a private temporary App Server, provide external ChatGPT tokens over JSON-RPC stdin, create an ephemeral read-only/no-approval thread, send exactly one minimal turn, and verify a new weekly deadline near 168 hours. It never switches the global account or restarts Desktop, it does not retry a real turn, and it verifies hashes of the global auth files before and after. This is a manual diagnostic path, not an automatic worker. A 401 requires a fresh interactive login; the tool does not work around stale credentials.

`codex-five-hour-activate <1|2|3>` is the corresponding manual 5H diagnostic. Its initial preflight requires the cache's VERIFIED two-observation `fiveHourDormant=true` classification and then revalidates that classification with fresh server data; `READY`, `100%`, or one observation is insufficient. The confirmation prompt may remain open without making that initial state usable for a later turn. After the exact confirmation phrase, the command repeats the App Server capability check, discards the old 5H observation history for decision purposes, and requires two newly fetched observations to prove VERIFIED dormant state again before it can reuse the isolated App Server turn. It then makes exactly two post-turn usage observations and accepts success only if the dormant classification has disappeared, the new deadline is roughly five hours away, `reset_at` remains fixed, and the countdown decreases. An ambiguous result is reported without retrying the real turn. This command is not an automatic worker.

Verified dormant 5H windows are also activated by the supervised `codex-five-hour-activation.timer` user unit. The timer runs independently of the status window and first forces the ordinary read-only usage refresh. Ranking, recommendation, active account, and user activity are not inputs. A target must have VERIFIED `fiveHourDormant=true`; after selection, two entirely new server observations must prove the same state before the shared isolated App Server mechanism can send exactly one turn. A per-account lock prevents overlap with the manual diagnostic or another worker.

The isolated turn passes no dynamic tools or environments, uses a private empty working directory with a read-only sandbox and no approvals, and explicitly instructs the model not to use tools. The current experimental App Server schema has no verified switch that removes every built-in Codex tool from the model schema. The client therefore also treats any started tool, command, file-change, web-search, image-generation, or MCP item as a protocol violation and terminates the process. This layered guard is capability-checked against the installed App Server version, but it is not presented as a stable upstream guarantee that built-in tools are absent.

The token-free `five-hour-activation.json` state is the worker's safety journal. It persists an attempt before the turn boundary and records `turn-committed` immediately before App Server is called. Success, timeout, crash, or ambiguous postconditions after that boundary can never trigger an automatic retry for the same dormant window. The block is cleared only after VERIFIED server data proves an active/non-dormant window, or when a later dormant observation is unambiguously after the successfully recorded fixed deadline. Pre-turn failures use a cooldown and consume no turn. Worker heartbeat, fatal state, and per-account activation errors are shown in the status window's problem section; no credentials, response bodies, or prompts are stored. Weekly windows are never activated by this worker.

Ranking uses `weekly remaining / hours until weekly reset` as its primary signal. Accounts within 10% of the best weekly urgency form a group whose internal order is decided by current 5H quota plus a small bonus for a reset within the next hour. Recommendation is deliberately more conservative than ranking: it has separate 10% weekly hysteresis, and a 5H advantage can only trigger a switch between weekly-near-equals when the active account's reset-aware 5H score is at or below 10 and the alternative still has both a 10-point and 10% relative advantage. These constants live together in `tools/workstation/codex-auth/lib/codex-account-ranking.js`.

The digit shortcuts intentionally act immediately. Do not programmatically restart or focus the status terminal while active Codex work is in progress: an accidentally delivered digit can initiate a real account switch and close Desktop.

For VS Code, select the account with the same launcher or run:

```bash
codex-account 2
```

Then run **Developer: Reload Window** in VS Code. The extension and Desktop share `$HOME/.codex`, but each long-running client must reload credentials after the switch.

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
- `$HOME/.local/bin/codex-usage-annotate`
- `$HOME/.local/bin/codex-usage-refresh`
- `$HOME/.local/bin/codex-weekly-activate`
- `$HOME/.local/bin/codex-five-hour-activate`
- `$HOME/.local/bin/codex-five-hour-activation-worker`
- `$HOME/.local/bin/codex-reset-credits-refresh`
- `$HOME/.local/lib/codex-account-ranking.js`
- `$HOME/.local/lib/codex-account-state.js`
- `$HOME/.local/lib/codex-auth-repair.js`
- `$HOME/.local/lib/codex-reset-credits.js`
- `$HOME/.local/lib/codex-status-render.js`
- `$HOME/.local/lib/codex-usage-cache.js`
- `$HOME/.local/lib/codex-weekly-activation.js`
- `$HOME/.local/lib/codex-five-hour-activation.js`
- `$HOME/.local/lib/codex-five-hour-worker.js`
- `$HOME/.local/lib/codex-activation-lock.js`
- `$HOME/.local/lib/codex-activation-account.js`
- `$HOME/.local/lib/codex-activation-hold.js`
- `$HOME/.local/lib/codex-usage-format.js`
- `$HOME/.cache/codex-account-switcher/usage.json` — mode `0600`, token-free per-account usage cache
- `$HOME/.cache/codex-account-switcher/five-hour-activation.json` — mode `0600`, token-free worker heartbeat, idempotency and error state
- `$HOME/.cache/codex-account-switcher/reset-credits.json` — mode `0600`, token-free reset count/expiration cache
- `$HOME/.config/codex-account-switcher/activation-holds.json` — optional mode-`0600` per-account observation holds keyed by stable account ID; contains no credentials
- `$HOME/.local/share/applications/codex-account{1,2,3}.desktop`
- `$HOME/.local/share/applications/codex-usage-watch.desktop`
- GNOME Terminal profile `Codex-status`
- user units `codex-five-hour-activation.service` and `codex-five-hour-activation.timer`

Backups created by the installer are local-only under `$HOME/.local/state/codex-auth-setup-backups/`.
