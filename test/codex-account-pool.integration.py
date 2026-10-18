import base64
import hashlib
import json
import os
import pathlib
import shutil
import subprocess
import tempfile

root = pathlib.Path(tempfile.mkdtemp(prefix='codex-pool-integration-'))
repo = pathlib.Path(__file__).resolve().parent.parent
codex_auth = shutil.which('codex-auth')
assert codex_auth, 'codex-auth is required'
home = root / 'codex'
home.mkdir()
fake_dir = root / 'fakebin'
fake_dir.mkdir()
fake = fake_dir / 'codex'
fake.write_text('''#!/usr/bin/env python3
import os,json,base64,pathlib
name=os.environ['TEST_LOGIN_NAME']
claims={'email':name+'@example.test','https://api.openai.com/auth':{'chatgpt_account_id':name,'chatgpt_user_id':'user-'+name,'chatgpt_plan_type':'plus'}}
payload=base64.urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip('=')
auth={'tokens':{'account_id':name,'id_token':'test.'+payload+'.test','access_token':'','refresh_token':''},'OPENAI_API_KEY':None}
p=pathlib.Path(os.environ['CODEX_HOME']);p.mkdir(parents=True,exist_ok=True);(p/'auth.json').write_text(json.dumps(auth))
''')
fake.chmod(0o755)
env = dict(os.environ, HOME=str(root), CODEX_HOME=str(home),
    CODEX_STATUS_TEST_ROOT=str(root),
    XDG_CONFIG_HOME=str(root / 'config'), XDG_CACHE_HOME=str(root / 'cache'),
    XDG_DATA_HOME=str(root / 'data'), CODEX_LOGIN_BIN=str(fake),
    CODEX_AUTH_BIN=codex_auth, TEST_LOGIN_NAME='alpha',
    PATH=str(fake_dir) + ':' + os.environ.get('PATH', ''),
    CODEX_AUTH_SKIP_SERVICE_RECONCILE='1',
    CODEX_AUTH_DISABLE_BACKGROUND_ACCOUNT_NAME_REFRESH='1')

def run(command, extra=None):
    return subprocess.run(command, env=dict(env, **(extra or {})),
        capture_output=True, text=True, timeout=30)

def state():
    registry = json.loads((home / 'accounts' / 'registry.json').read_text())
    return registry, {a['chatgpt_account_id']: a for a in registry['accounts']}

def protected_hashes():
    paths = [home / 'auth.json', home / 'accounts' / 'registry.json']
    paths += sorted((home / 'accounts').glob('*.auth.json'))
    return {str(p): hashlib.sha256(p.read_bytes()).hexdigest() for p in paths}

try:
    assert run([codex_auth, 'config', 'api', 'disable']).returncode == 0
    assert run([codex_auth, 'login']).returncode == 0
    assert run([codex_auth, 'login'], {'TEST_LOGIN_NAME': 'beta'}).returncode == 0
    registry, by_id = state()
    alpha = by_id['alpha']
    beta = by_id['beta']
    assert registry['active_account_key'] == beta['account_key']
    before = protected_hashes()
    manager = str(repo / 'bin' / 'codex-instance')
    created = run([manager, 'create', 'rosetta', 'Rosetta'])
    assert created.returncode == 0, created.stderr
    blocked_key = base64.urlsafe_b64encode(beta['account_key'].encode()).decode().rstrip('=')
    blocked = run([manager, 'switch-key', 'rosetta', blocked_key])
    assert blocked.returncode != 0 and 'ACCOUNT_IN_USE_BY:Spadrig' in blocked.stderr, blocked.stderr
    alpha_key = base64.urlsafe_b64encode(alpha['account_key'].encode()).decode().rstrip('=')
    switched = run([manager, 'switch-key', 'rosetta', alpha_key])
    assert switched.returncode == 0, switched.stderr
    b_home = root / 'data' / 'codex-status' / 'instances' / 'rosetta' / 'codex-home'
    b_registry = json.loads((b_home / 'accounts' / 'registry.json').read_text())
    b_auth = json.loads((b_home / 'auth.json').read_text())
    assert b_registry['active_account_key'] == alpha['account_key']
    assert b_auth['tokens']['account_id'] == 'alpha'
    assert protected_hashes() == before
    pool = json.loads((root / 'config' / 'codex-status' / 'account-pool' / 'registry.json').read_text())
    assert len(pool['accounts']) == 2 and 'active_account_key' not in pool
    assert all(a['generation'] == 1 for a in pool['accounts'])
    print('PASS: real codex-auth import and switch stay in B; A bytes unchanged')
    print('PASS: an account active in A is blocked for B')
finally:
    shutil.rmtree(root)
