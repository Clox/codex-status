import os, tempfile, json, base64, subprocess, pty, select, time, pathlib, shlex
root = pathlib.Path(tempfile.mkdtemp(prefix='codex-manager-integration-'))
authbin = subprocess.check_output(['which','codex-auth'], text=True).strip()
repo = pathlib.Path(__file__).resolve().parent.parent
env = dict(os.environ, HOME=str(root), CODEX_STATUS_TEST_ROOT=str(root), CODEX_HOME=str(root/'home'), XDG_CONFIG_HOME=str(root/'config'), XDG_CACHE_HOME=str(root/'cache'), XDG_DATA_HOME=str(root/'data'), USAGE_CACHE=str(root/'cache'/'usage.json'), CODEX_OPERATION_LOCK_DIR=str(root/'cache'/'exclusive-codex-operation.lock'), CODEX_AUTH_BIN=authbin, CODEX_INSTANCE_MANAGER=str(repo/'bin'/'codex-instance'), CODEX_AUTH_SKIP_SERVICE_RECONCILE='1', CODEX_AUTH_DISABLE_BACKGROUND_ACCOUNT_NAME_REFRESH='1')
(root/'home').mkdir()
(root/'fakebin').mkdir()
# Deliberately invalid synthetic credentials: no real account or network login.
fake = root/'fakebin'/'codex'
fake.write_text('''#!/usr/bin/env python3
import os,json,base64,pathlib
name=os.environ['TEST_LOGIN_NAME']
claims={'email':name+'@example.test','https://api.openai.com/auth':{'chatgpt_account_id':name,'chatgpt_user_id':'user-'+name,'chatgpt_plan_type':'plus'}}
payload=base64.urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip('=')
auth={'tokens':{'account_id':name,'id_token':'test.'+payload+'.test','access_token':'','refresh_token':''},'OPENAI_API_KEY':None}
p=pathlib.Path(os.environ['CODEX_HOME']);p.mkdir(parents=True,exist_ok=True);(p/'auth.json').write_text(json.dumps(auth))
''')
fake.chmod(0o755)
(root/'fakebin'/'notify-send').write_text('#!/bin/sh\nexit 0\n')
(root/'fakebin'/'notify-send').chmod(0o755)
env.update(CODEX_LOGIN_BIN=str(fake),PATH=str(fake.parent)+':'+env['PATH'],TEST_LOGIN_NAME='alpha')
def run(args):
    subprocess.run([authbin]+args,env=env,check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=15)
run(['config','api','disable'])
run(['login'])
authbefore=(root/'home'/'auth.json').read_bytes()
def registry(): return json.loads((root/'home'/'accounts'/'registry.json').read_text())
def session(actions, login='beta'):
    master,slave=pty.openpty()
    proc=subprocess.Popen([str(repo/'bin'/'codex-account-manager')],stdin=slave,stdout=slave,stderr=slave,env=dict(env,TEST_LOGIN_NAME=login),start_new_session=True)
    os.close(slave); out=b''
    try:
        for needle,response in actions:
            deadline=time.time()+15
            while needle.encode() not in out:
                if time.time()>deadline: raise AssertionError('timeout: '+out.decode(errors='replace'))
                if select.select([master],[],[],0.1)[0]:
                    try: chunk=os.read(master,65536)
                    except OSError: chunk=b''
                    if not chunk: raise AssertionError('early exit: '+out.decode(errors='replace'))
                    out+=chunk
            os.write(master,(response+'\n').encode());out=b''
        while proc.poll() is None:
            if select.select([master],[],[],0.1)[0]:
                try: out+=os.read(master,65536)
                except OSError: break
        code=proc.wait(timeout=10)
        return code,out.decode(errors='replace')
    finally:
        if proc.poll() is None: proc.kill();proc.wait()
        os.close(master)
try:
    code,out=session([('[Enter] Avbryt:','l'),('[j/N]:','j')])
    assert code==0,(code,out)
    assert len(registry()['accounts'])==2
    assert (root/'home'/'auth.json').read_bytes()==authbefore
    print('PASS: add via real codex-auth login/import, active auth unchanged')
    code,out=session([('[Enter] Avbryt:','l')])
    assert code==1 and 'redan' in out,(code,out)
    assert len(registry()['accounts'])==2
    print('PASS: duplicate login rejected')
    code,out=session([('[Enter] Avbryt:','t'),('Kontonummer','1')])
    assert code==1 and 'aktiva' in out,(code,out)
    print('PASS: active removal rejected')
    code,out=session([('[Enter] Avbryt:','t'),('Kontonummer','2'),('[j/N]:','n')])
    assert code==0 and len(registry()['accounts'])==2,(code,out)
    print('PASS: removal cancelled without mutation')
    code,out=session([('[Enter] Avbryt:','t'),('Kontonummer','2'),('[j/N]:','j')])
    assert code==0 and len(registry()['accounts'])==1,(code,out)
    assert (root/'home'/'auth.json').read_bytes()==authbefore
    print('PASS: remove via real codex-auth, active auth unchanged')
    for name in ['gamma', 'delta', 'epsilon']:
        code,out=session([('[Enter] Avbryt:','l'),('[j/N]:','j')], name)
        assert code==0,(code,out)
    listing=subprocess.check_output(['script','-qefc','stty cols 160; '+shlex.quote(authbin)+' list --skip-api','/dev/null'],env=env,text=True)
    mapping=subprocess.check_output([str(repo/'bin'/'codex-usage-annotate'),'--switch-map'],input=listing,env=env,text=True)
    keys=[base64.urlsafe_b64decode(line.split()[3]+'===').decode() for line in mapping.splitlines()]
    assert set(keys)=={a['account_key'] for a in registry()['accounts']},mapping
    print('PASS: all four accounts receive stable status shortcuts')
    conf=root/'config'/'codex-account-switcher';conf.mkdir(parents=True)
    settings={'CODEX_HOME':env['CODEX_HOME'],'NODE_BIN_DIR':str(pathlib.Path(subprocess.check_output(['which','node'],text=True).strip()).parent),'CODEX_AUTH_BIN':authbin,'ACCOUNT_STATE_CHECKER':str(repo/'bin'/'codex-account-state')}
    (conf/'accounts.conf').write_text(''.join(k+'='+shlex.quote(v)+'\n' for k,v in settings.items()))
    key='user-epsilon::epsilon'
    encoded=base64.urlsafe_b64encode(key.encode()).decode().rstrip('=')
    result=subprocess.run([str(repo/'bin'/'codex-account'),'--key',encoded],env=dict(env,XDG_CONFIG_HOME=str(root/'config')),capture_output=True,text=True)
    assert result.returncode==0,result.stderr
    assert registry()['active_account_key']==key
    missing=base64.urlsafe_b64encode(b'user-beta::beta').decode().rstrip('=')
    result=subprocess.run([str(repo/'bin'/'codex-account'),'--key',missing],env=dict(env,XDG_CONFIG_HOME=str(root/'config')),capture_output=True,text=True)
    assert result.returncode!=0 and registry()['active_account_key']==key
    print('PASS: fourth account switches; stale removed key is rejected')
finally:
    import shutil
    shutil.rmtree(root)
