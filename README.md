# codex-status

Machine-local account status, switching, quota observation, and conservative
continuation controls for Codex Desktop on Linux. This repository contains code,
systemd unit templates, and tests. It does not contain credentials, account
registries, Codex sessions, databases, journals, or user preferences.

## Layout

- `bin/`: status UI, account commands, usage/reset helpers, observer, AUTO
  controller, continuation, Desktop accessibility and restore helpers.
- `lib/`: account ranking, ownership, quota and continuation state machines,
  process classification, and protocol helpers.
- `systemd/`: user units for the turn observer, AUTO timer/controller, and
  five-hour activation worker.
- `test/`: Node unit/regression tests and an isolated account-manager integration
  test using synthetic credentials.
- `docs/codex-multi-account.md`: detailed behavior and fresh setup instructions.

## Dependencies

The tested workstation used Node.js 22.21.1, Python 3 with GTK 3 and `pyatspi`,
GNOME Terminal, `systemd --user`, the ChatGPT Desktop bundled Codex binary, and
the external npm package [`@loongphy/codex-auth`](https://github.com/Loongphy/codex-auth)
version **0.2.10**. The package is installed globally, not vendored or a
submodule. Read its current upstream README and inspect the installed Codex and
Desktop versions before a fresh installation. Its account switch command is a
dependency; this repository owns the status, observer, and continuation logic.

## Installation and verification

On an existing installation, inspect without changing anything:

```bash
./install.sh --verify
```

The default `./install.sh` operation is also read-only verification. It compares
all tracked `bin/`, `lib/`, and `systemd/` payload files to their installed
counterparts under `~/.local` and `~/.config/systemd/user`. A nonzero exit means
at least one file differs. It does not inspect or print credentials.

When an update is deliberately wanted, `./install.sh --update` atomically
replaces only differing payload files and backs up previous versions under
`~/.local/state/codex-auth-setup-backups`. It does not change `accounts.conf`,
preferences, journals, `~/.codex`, systemd enabled/active states, or a running
status window. Review changed unit files and reload systemd separately if
needed. `~/.local/bin/codex-usage-resets` is a legacy local file outside this
repository; the installer leaves it alone.

For a **new** machine with no `accounts.conf`, follow
[the fresh setup guide](docs/codex-multi-account.md) and invoke
`./install.sh --fresh` explicitly. That path installs units but does not enable
or start them. In particular, it does not start AUTO. Never use `--fresh` to
upgrade an existing installation.

Run the non-live tests with:

```bash
env -u CODEX_STATUS_ISOLATED node --test test/*.test.js
python3 test/codex-account-manager.integration.py
```

The status launcher tests must control `CODEX_STATUS_ISOLATED` themselves; unset
an inherited value when running the suite from inside the live status window.

## Runtime and safety boundaries

Installed programs load sibling libraries from `~/.local/lib`. They do not load
source files from this checkout. Configuration lives in
`~/.config/codex-account-switcher`; observer, usage, AUTO, retry and continuation
state lives in `~/.cache/codex-account-switcher`; account credentials and thread
history remain in the shared `CODEX_HOME` (normally `~/.codex`). None of those
paths should be copied into Git.

The observer classifies exact interrupted `(threadId, failedTurnId)` pairs.
`OFF` and `HEADLESS` select one continuation owner per pair. AUTO
checks quota and account identity, uses a shared operation lock, and persists
retry barriers. HEADLESS additionally checks local thread availability and
requires verified App Server exclusivity before its controller or commit. A
manual account switch cannot silently take ownership of a HEADLESS candidate.

Extraction from Spadrig preserved the path-relevant commit history in this
repository. The installed runtime and its private state are independent of
either source checkout.
