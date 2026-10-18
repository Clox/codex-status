#!/usr/bin/env python3
"""Exercise the C key in an isolated status PTY with fake clipboard/data sources."""

import os
import pathlib
import pty
import select
import signal
import tempfile
import time

ROOT = pathlib.Path(__file__).resolve().parent.parent


def executable(path, source):
    path.write_text(source)
    path.chmod(0o755)


def until(fd, expected, seconds=3):
    end = time.monotonic() + seconds
    output = bytearray()
    while expected not in output and time.monotonic() < end:
        ready, _, _ = select.select([fd], [], [], 0.05)
        if ready:
            try:
                output.extend(os.read(fd, 65536))
            except OSError:
                break
    assert expected in output, bytes(output[-800:])


with tempfile.TemporaryDirectory(prefix='codex-copy-pty-') as directory:
    home = pathlib.Path(directory)
    config = home / '.config' / 'codex-account-switcher'
    cache = home / '.cache' / 'codex-account-switcher'
    tools = home / 'tools'
    for folder in (config, cache, tools):
        folder.mkdir(parents=True)
    auto = cache / 'auto-continue.json'
    auto.write_text('BEFORE')
    (cache / 'manual-resume.json').write_text('{}')
    (cache / 'turn-events.json').write_text('{}')
    (cache / 'status-raw-frame.txt').write_text('ACCOUNT │ STATUS\n')
    clipboard = home / 'clipboard.txt'
    quota_calls = home / 'quota-calls'
    quota_calls.write_text('')
    executable(tools / 'auth', '#!/bin/sh\nexit 1\n')
    executable(tools / 'usage', '#!/bin/sh\nexit 0\n')
    executable(tools / 'quota', '#!/bin/sh\nprintf x >> "$QUOTA_CALLS"\nprintf "null\\n"\n')
    executable(tools / 'xclip', '#!/bin/sh\ncat > "$CLIPBOARD_OUTPUT"\n')
    executable(tools / 'annotate', '''#!/bin/sh
case "$1" in
  --switch-map) printf '1\\t1\\tactive\\tkey\\n' ;;
  --attention-state) printf '{"worthy":false}\\n' ;;
  --availability-state) printf '{}\\n' ;;
  *) printf 'ACCOUNT │ STATUS\\n────────┼───────\\naccount-a │ OK\\n\\nRECOMMENDATION: stay\\n\\nACCOUNT PROBLEMS:\\n';
     seq 0 39 | sed 's/^/problem-/';
     printf '\\nAUTO: HEADLESS · %s\\n' "$(cat "$CODEX_AUTO_CONTINUE_STATE")" ;;
esac
''')
    (config / 'accounts.conf').write_text('\n'.join([
        f'CODEX_HOME={home / "codex"}',
        'ACCOUNT_1=a ACCOUNT_2=b ACCOUNT_3=c',
        f'NODE_BIN_DIR={tools}',
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
        os.environ.update(HOME=str(home), CODEX_HOME=str(home / 'codex'),
                          CODEX_STATUS_TEST_ROOT=str(home),
                          XDG_CONFIG_HOME=str(home / '.config'),
                          XDG_CACHE_HOME=str(home / '.cache'),
                          XDG_DATA_HOME=str(home / '.local' / 'share'), TERM='xterm',
                          CODEX_AUTO_CONTINUE_STATE=str(auto),
                          XDG_SESSION_TYPE='x11', DISPLAY=':test', WAYLAND_DISPLAY='',
                          PATH=f'{tools}:{os.environ["PATH"]}',
                          QUOTA_CALLS=str(quota_calls), CLIPBOARD_OUTPUT=str(clipboard))
        os.execv(str(ROOT / 'bin' / 'codex-usage-watch'), ['codex-usage-watch'])
    try:
        until(fd, b'BEFORE')
        # Let the initial cached-frame transition finish before measuring C.
        time.sleep(1.5)
        baseline = quota_calls.read_text()
        os.write(fd, b'c')
        until(fd, b'Status copied')
        copied = clipboard.read_text()
        assert 'ACCOUNT │ STATUS\n────────┼───────\naccount-a │ OK' in copied
        assert 'problem-0' in copied and 'problem-39' in copied
        assert '\x1b' not in copied
        assert auto.read_text() == 'BEFORE'
        assert quota_calls.read_text() == baseline
    finally:
        os.kill(pid, signal.SIGTERM)
        os.waitpid(pid, 0)
        os.close(fd)
