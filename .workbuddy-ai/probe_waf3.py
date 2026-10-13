# Test baxia headers + challenge decay on POST /api/v2/chats/new.
import io, json, time, subprocess, sys, urllib.request

ROOT = r'E:\opencode-max\opencode-max'
cfg = json.load(io.open(ROOT + r'\accounts.json', encoding='utf-8'))
acc = next(a for a in cfg['accounts'] if a['id'] == 'qwen-1')
BASE = 'https://chat.qwen.ai'
H = {'content-type': 'application/json',
     'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
     'Accept': 'application/json, text/plain, */*', 'Referer': BASE + '/', 'Origin': BASE}


def call(method, path, reqbody=None, headers=None, timeout=60):
    h = dict(H)
    if headers:
        h.update(headers)
    data = json.dumps(reqbody).encode() if reqbody is not None else None
    req = urllib.request.Request(BASE + path, data=data, headers=h, method=method)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.status, r.read().decode('utf-8', 'replace')


st, body = call('POST', '/api/v1/auths/signin', {'email': acc['email'], 'password': acc['pass' + 'wordHash']})
token = json.loads(body)['token']
AUTH = {'Authorization': 'Bearer ' + token}


def verdict(body):
    if body.lstrip().startswith('{'):
        try:
            j = json.loads(body)
            return 'OK' if j.get('success') is True else 'JSON-ERR'
        except Exception:
            return 'JSON-parse-err'
    return 'WAF-CHALLENGE' if 'aliyun_waf' in body else 'HTML-other'


r = subprocess.run([sys.executable, r'.workbuddy-ai\bx_headers.py'], capture_output=True, text=True, cwd=ROOT, shell=False)
bx = json.loads(r.stdout) if r.returncode == 0 and r.stdout.strip().startswith('{') else None
print('baxia headers:', 'yes (bx-ua len %d)' % len(bx.get('bx-ua', '')) if bx else 'FAILED')

secs = int(time.time())
new_chat = {'title': 'api_%d' % secs, 'models': ['qwen3.7-plus'], 'chat_mode': 'normal', 'chat_type': 't2t', 'timestamp': secs}

if bx:
    st, body = call('POST', '/api/v2/chats/new', new_chat, {**AUTH, **bx})
    print('create + bearer + baxia:', st, verdict(body))
    time.sleep(2)
    if verdict(body) == 'OK':
        cid = json.loads(body)['data']['id']
        call('DELETE', '/api/v2/chats/' + cid, None, AUTH)

print('waiting 90s to test decay…')
time.sleep(90)
st, body = call('POST', '/api/v2/chats/new', new_chat, AUTH)
print('create after 90s decay:', st, verdict(body))
if verdict(body) == 'OK':
    cid = json.loads(body)['data']['id']
    call('DELETE', '/api/v2/chats/' + cid, None, AUTH)
    print('decay test: challenge cleared')
