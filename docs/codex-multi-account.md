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

The usage columns show remaining percentages, a rounded eighth-block indicator (` `, `▁` through `█`), and time until reset as `HH:MM`. `W%/H` shows weekly percentage remaining per hour until the weekly reset, which is the same urgency value used by the ranking. Usage data remains a cached local observation, not a live server poll. An inactive account commonly remains stale until that account is used and a suitable local rate-limit event is written. Saved-reset data is presentation-only and does not affect ranking or recommendation.

After an automatic weekly reset, Codex can report `100%` with `0:00` until the account is used once. The status window treats this as `NEEDS_ACTIVATION`, shows `START` instead of a false W%/H value, and temporarily prioritizes one minimal use of that account. Once Codex reports a normal future weekly reset, ordinary ranking resumes automatically.

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
- `$HOME/.local/bin/codex-usage-watch`
- `$HOME/.local/bin/codex-usage-annotate`
- `$HOME/.local/bin/codex-reset-credits-refresh`
- `$HOME/.local/lib/codex-account-ranking.js`
- `$HOME/.local/lib/codex-reset-credits.js`
- `$HOME/.local/lib/codex-usage-format.js`
- `$HOME/.cache/codex-account-switcher/reset-credits.json` — mode `0600`, token-free reset count/expiration cache
- `$HOME/.local/share/applications/codex-account{1,2,3}.desktop`
- `$HOME/.local/share/applications/codex-usage-watch.desktop`
- GNOME Terminal profile `Codex-status`

Backups created by the installer are local-only under `$HOME/.local/state/codex-auth-setup-backups/`.
