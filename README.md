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

### Desktop instances (manual management)

`codex-instance list` shows the discovered primary instance (`default`, initially
named Spadrig) even before an instance registry exists. Its paths remain
`~/.codex`, `~/.config/Codex`, `~/.config/codex-account-switcher`, and
`~/.cache/codex-account-switcher`. The first registry change writes
`~/.config/codex-status/instances.json`; it does not move legacy files.

`codex-instance create rosetta Rosetta` creates empty, private directories for
Codex data and the Desktop profile under
`~/.local/share/codex-status/instances/rosetta`, plus separate status config
and runtime directories under `~/.config/codex-status/instances/rosetta` and
`~/.cache/codex-status/instances/rosetta`. The runtime directory reserves its
own status window lock, state and journal namespace. `codex-instance start
rosetta` launches the installed Desktop binary with explicit `CODEX_HOME`,
`CODEX_ELECTRON_USER_DATA_PATH` and `--user-data-dir` in a transient user
systemd unit. `codex-instance stop rosetta` signals only a root verified by
profile path, Codex home, PID and process start identity. It verifies that the
instance's helper processes have exited before reporting success. `I` in the
status window opens the interactive instance manager. The instance list in the
status window shows Desktop running state.

Use `codex-instance rename rosetta "New name"`, `enable`, `disable`, `stop`,
and `delete rosetta --confirm "DELETE rosetta"` for management. Delete refuses
the primary instance, a running instance, or a launch whose outcome has not
been verified. A launch marker can be cleared with `clear-stale-launch` only
after systemd confirms its unit is inactive. Delete removes only the named
instance's derived directories. It never deletes shared accounts or primary
data.

The first status launch, account-management action, or explicit
`codex-instance pool-migrate` creates a shared account pool under
`~/.config/codex-status/account-pool` and
`~/.local/share/codex-status/account-pool`. It copies the default account
snapshots byte-for-byte without changing default auth, registry, threads or
rollouts. The pool has account identities, metadata and monotonic credential
generations; it has no global active account. Each instance keeps its own
`CODEX_HOME/auth.json` and active account in its local codex-auth registry.

In the status window, press `1`–`9` to select an instance, then `1`–`9` to
select an account; Esc or X cancels. `codex-instance switch-key rosetta
<base64url-account-key>` and the instance manager's Change account action use
the same import → switch → verify path. A secondary instance starts with no
auth and no copied default session. An account already active in another
instance is blocked with that instance's name. Operations use a global
assignment lock and a robust per-account lock. A local credential that differs
from the pool is held back from another instance until repair or a future
verified refresh handoff updates the pool. Auth repair updates the pool only
after server verification and increments the generation; older provisioned
copies are marked for reprovisioning rather than changed silently.
The account table reports authentication for the pool's latest snapshot;
the instance list separately reports `credentials stale` when a local copy
is older. `[R]` can repair an account while it is active in an instance.
The repair leaves that instance's live auth untouched. Use `[I]` → `[P]`
or `codex-instance apply-credentials rosetta` to import and activate the
latest snapshot for the same account. A running instance is restarted only
when its own turn observer verifies that no turns are active. The status window's
secondary quota scans do not certify active-turn safety for credential
application. A running secondary instance must still be stopped explicitly
before applying; the command never stops it on an unverified turn state.
Default Apply credentials keeps the existing configured home (`~/.codex`).
Ownership verification accepts the default app-server's own `HOME/.codex` when
`CODEX_HOME` is absent, compares canonical paths, and rejects conflicting homes.
Default manual switches import and verify the target pool generation under the
assignment/account locks; stale current credentials need not be applied first.
Auth files and generation metadata are restored if verification fails before launch.

While the status window is open, it scans each secondary instance's own rollouts
every five seconds and records verified quota exhaustion under that instance's
runtime state. It does not start another Desktop or increase server polling.
Secondary instances still do not have independent status collectors or
AUTO/HEADLESS schedulers. The existing account and AUTO flows belong to
`default`; HEADLESS refuses to stop another Desktop instance. The existing
systemd timer and observer units remain unchanged.

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
