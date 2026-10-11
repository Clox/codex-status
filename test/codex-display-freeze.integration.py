#!/usr/bin/env python3
"""Exercise display freeze in an isolated pseudo-terminal with fake data sources."""

import os
import pathlib
import pty
import select
import signal
import tempfile
import time

ROOT = pathlib.Path(__file__).resolve().parent.parent


def write_executable(path, source):
    path.write_text(source)
    path.chmod(0o755)


def collect(fd, seconds):
    end = time.monotonic() + seconds
    chunks = bytearray()
    while time.monotonic() < end:
        ready, _, _ = select.select([fd], [], [], min(0.05, end - time.monotonic()))
        if ready:
            try:
                chunks.extend(os.read(fd, 65536))
            except OSError:
                break
    return bytes(chunks)


def collect_until(fd, expected, seconds):
    end = time.monotonic() + seconds
    chunks = bytearray()
    while expected not in chunks and time.monotonic() < end:
        chunks.extend(collect(fd, 0.1))
    assert expected in chunks, bytes(chunks[-700:])
    return bytes(chunks)


with tempfile.TemporaryDirectory(prefix='codex-display-freeze-') as directory:
    home = pathlib.Path(directory)
    config = home / '.config' / 'codex-account-switcher'
    cache = home / '.cache' / 'codex-account-switcher'
    tools = home / 'tools'
    config.mkdir(parents=True)
    cache.mkdir(parents=True)
    tools.mkdir()
    auto = cache / 'auto-continue.json'
    auto.write_text('BEFORE')
    (cache / 'manual-resume.json').write_text('{}')
    (cache / 'turn-events.json').write_text('{}')
    (cache / 'status-raw-frame.txt').write_text('ACCOUNT  5H USAGE WEEKLY USAGE\n')
    quota_calls = home / 'quota-calls'
    quota_calls.write_text('')
    # Keep collection isolated from this UI test: the cached raw frame is the
    # input, and a failed synthetic collector never starts a quota transition.
    write_executable(tools / 'auth', '#!/bin/sh\nexit 1\n')
    write_executable(tools / 'usage', '#!/bin/sh\nexit 0\n')
    write_executable(tools / 'quota', '#!/bin/sh\nprintf x >> "$QUOTA_CALLS"\nprintf "null\\n"\n')
    write_executable(tools / 'annotate', '''#!/bin/sh
case "$1" in
  --switch-map) printf '1\\t1\\tactive\\tkey\\n' ;;
  --attention-state) printf '{"worthy":false}\\n' ;;
  --availability-state) printf '{}\\n' ;;
  *) printf 'ACCOUNT  5H USAGE WEEKLY USAGE\\naccount-a OK\\n\\nRECOMMENDATION: stay\\n\\nAUTO: HEADLESS · %s\\n' "$(cat "$CODEX_AUTO_CONTINUE_STATE")" ;;
esac
''')
    (config / 'accounts.conf').write_text('\n'.join([
        f'CODEX_HOME={home / "codex"}',
        'ACCOUNT_1=a ACCOUNT_2=b ACCOUNT_3=c',
        'NODE_BIN_DIR=/usr/bin',
        f'CODEX_AUTH_BIN={tools / "auth"}',
        f'USAGE_ANNOTATOR={tools / "annotate"}',
        f'RESET_CREDITS_REFRESHER={tools / "usage"}',
        f'USAGE_REFRESHER={tools / "usage"}',
        f'RESET_CREDITS_CACHE={cache / "reset.json"}',
        f'CODEX_QUOTA_TRANSITION_BIN={tools / "quota"}',
        f'CODEX_STATUS_VIEWPORT_BIN={ROOT / "bin" / "codex-status-viewport"}',
        f'ACCOUNT_SWITCHER={tools / "usage"}',
        f'CHATGPT_LAUNCHER={tools / "usage"}',
    ]) + '\n')
    pid, fd = pty.fork()
    if pid == 0:
        os.environ.update(HOME=str(home), XDG_CONFIG_HOME=str(home / '.config'),
                          XDG_CACHE_HOME=str(home / '.cache'), TERM='xterm',
                          XDG_SESSION_TYPE='wayland', QUOTA_CALLS=str(quota_calls))
        os.execv(str(ROOT / 'bin' / 'codex-usage-watch'), ['codex-usage-watch'])
    try:
        collect_until(fd, b'BEFORE', 3.0)
        os.write(fd, b'f')
        collect_until(fd, b'DISPLAY FROZEN', 2.0)
        collect(fd, 0.2)
        calls_before = len(quota_calls.read_text())
        auto.write_text('AFTER-LOCAL-STATE-CHANGED')
        assert collect(fd, 1.1) == b'', 'terminal wrote bytes while frozen'
        os.write(fd, b'f')
        collect_until(fd, b'AFTER-LOCAL-STATE-CHANGED', 2.0)
        assert len(quota_calls.read_text()) == calls_before, 'unfreeze triggered quota transition'
    finally:
        os.kill(pid, signal.SIGTERM)
        os.waitpid(pid, 0)
        os.close(fd)
