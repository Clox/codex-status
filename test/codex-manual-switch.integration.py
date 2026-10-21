#!/usr/bin/env python3
"""Exercise two-stage status selection with isolated fake instance commands."""

import base64
import os
import pathlib
import pty
import select
import signal
import tempfile
import time

REPO = pathlib.Path(__file__).resolve().parent.parent


def executable(path, content):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content)
    path.chmod(0o755)


def until(fd, expected, seconds=5):
    deadline = time.monotonic() + seconds
    output = bytearray()
    while expected not in output and time.monotonic() < deadline:
        if select.select([fd], [], [], 0.05)[0]:
            try:
                output.extend(os.read(fd, 65536))
            except OSError:
                break
    assert expected in output, bytes(output[-1200:])
    return bytes(output)


with tempfile.TemporaryDirectory(prefix='codex-manual-switch-') as directory:
    home = pathlib.Path(directory)
    config = home / '.config' / 'codex-account-switcher'
    cache = home / '.cache' / 'codex-account-switcher'
    tools = home / 'tools'
    for folder in (config, cache, tools, home / '.local' / 'bin'):
        folder.mkdir(parents=True, exist_ok=True)
    mode = home / 'mode'
    mode.write_text('stale')
    calls = home / 'calls'
    calls.write_text('')
    (cache / 'status-raw-frame.txt').write_text('cached frame\n')
    executable(tools / 'auth', '#!/bin/sh\nexit 1\n')
    executable(tools / 'usage', '#!/bin/sh\nexit 0\n')
    executable(tools / 'quota', '#!/bin/sh\nprintf "null\\n"\n')
    executable(tools / 'annotate', '''#!/bin/sh
case "$1" in
  --switch-map) printf '1\\t1\\t-\\tYWxleC1rZXk\\n' ;;
  --attention-state) printf '{"worthy":false}\\n' ;;
  --availability-state) printf '{}\\n' ;;
  *) printf 'INSTANCES:\\n1  Spadrig · ogggan@example.test · running\\n2  Rosetta · linus@example.test · running\\n\\nACCOUNTS:\\nACCOUNT │ STATUS\\n────────┼───────\\n'
     if [ -n "$CODEX_PENDING_SOURCE_ROW" ]; then printf '01 alex@example.test │ WAIT/\\n';
     else printf '01 alex@example.test │ OK\\n'; fi
     if [ -n "$CODEX_SELECTED_INSTANCE_ID" ]; then
       printf '\\nSelected instance: %s\\nChoose account [1-1] · Esc cancel\\n' "$CODEX_SELECTED_INSTANCE_ID"
       [ -z "$CODEX_INSTANCE_SELECTION_ERROR" ] || printf '%s\\n' "$CODEX_INSTANCE_SELECTION_ERROR"
     fi
     [ -z "$CODEX_INSTANCE_SWITCH_FEEDBACK" ] || printf '\\nACCOUNT SWITCH FAILED: %s\\n' "$CODEX_INSTANCE_SWITCH_FEEDBACK"
     printf '\\nAUTO: OFF\\n' ;;
esac
''')
    executable(home / '.local' / 'bin' / 'codex-instance', '''#!/bin/sh
case "$1" in
  pool-migrate) exit 0 ;;
  switch-state-path) printf '%s\\n' "$HOME/no-switch-state.json" ;;
  resolve-index) case "$2" in 1) echo default;; 2) echo rosetta;; *) exit 1;; esac ;;
  availability)
    printf 'availability:%s:%s\\n' "$2" "$3" >> "$TEST_CALLS"
    case "$(cat "$TEST_MODE")" in
      stale) echo 'CREDENTIAL_REPROVISION_NEEDED:Spadrig' >&2; exit 1 ;;
      same) echo 'in-use:Rosetta' ;;
      *) echo available ;;
    esac ;;
  switch-key)
    printf 'switch:%s:%s\\n' "$2" "$3" >> "$TEST_CALLS"
    sleep 0.3
    case "$(cat "$TEST_MODE")" in
      fail) echo 'EXCLUSIVE_CODEX_OPERATION_IN_PROGRESS' >&2; exit 75 ;;
      *) echo 'Account switched and verified.' ;;
    esac ;;
esac
''')
    (config / 'accounts.conf').write_text('\n'.join([
        f'CODEX_HOME={home / "codex"}',
        'ACCOUNT_1=a ACCOUNT_2=b ACCOUNT_3=c',
        f'NODE_BIN_DIR={pathlib.Path(os.environ.get("NODE_BIN_DIR", "/usr/bin"))}',
        f'CODEX_AUTH_BIN={tools / "auth"}',
        f'USAGE_ANNOTATOR={tools / "annotate"}',
        f'RESET_CREDITS_REFRESHER={tools / "usage"}',
        f'USAGE_REFRESHER={tools / "usage"}',
        f'CODEX_QUOTA_TRANSITION_BIN={tools / "quota"}',
        f'CODEX_STATUS_VIEWPORT_BIN={REPO / "bin" / "codex-status-viewport"}',
        f'ACCOUNT_SWITCHER={tools / "usage"}',
        f'CHATGPT_LAUNCHER={tools / "usage"}',
    ]) + '\n')
    pid, fd = pty.fork()
    if pid == 0:
        os.environ.update(HOME=str(home), CODEX_HOME=str(home / 'codex'),
                          CODEX_STATUS_TEST_ROOT=str(home),
                          XDG_CONFIG_HOME=str(home / '.config'),
                          XDG_CACHE_HOME=str(home / '.cache'),
                          XDG_DATA_HOME=str(home / '.local' / 'share'),
                          TERM='xterm', XDG_SESSION_TYPE='wayland',
                          TEST_MODE=str(mode), TEST_CALLS=str(calls),
                          PATH=f'{tools}:{os.environ["PATH"]}')
        os.execv(str(REPO / 'bin' / 'codex-usage-watch'), ['codex-usage-watch'])
    try:
        until(fd, b'INSTANCES:')
        os.write(fd, b'1')
        until(fd, b'Selected instance: default')
        os.write(fd, b'1')
        until(fd, b'CREDENTIAL_REPROVISION_NEEDED:Spadrig')
        assert 'switch:' not in calls.read_text()
        print('PASS: stale precondition stays in selection with its actual reason')

        mode.write_text('same')
        os.write(fd, b'1')
        until(fd, b'Account in use by Rosetta')
        assert 'switch:' not in calls.read_text()
        print('PASS: same-account block names the holding instance')

        mode.write_text('fail')
        os.write(fd, b'1')
        until(fd, b'WAIT/')
        until(fd, b'EXCLUSIVE_CODEX_OPERATION_IN_PROGRESS', seconds=8)
        assert 'switch:default:YWxleC1rZXk' in calls.read_text()
        print('PASS: launched default switch shows WAIT and durable command failure')

        mode.write_text('available')
        os.write(fd, b'2')
        until(fd, b'Selected instance: rosetta')
        os.write(fd, b'1')
        until(fd, b'Account switched and verified', seconds=8)
        assert 'switch:rosetta:YWxleC1rZXk' in calls.read_text()
        os.write(fd, b'2')
        until(fd, b'Selected instance: rosetta')
        os.write(fd, b'x')
        until(fd, b'Instance selection cancelled')
        print('PASS: B uses the same switch command, X cancels without another switch')
    finally:
        os.kill(pid, signal.SIGTERM)
        os.waitpid(pid, 0)
        os.close(fd)
