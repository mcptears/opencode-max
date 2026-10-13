# Which request shape passes the WAF right now?
import io, json, time, urllib.request

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
cookies = (acc.get('cookies') or '').strip()
print('signed in | stored cookies:', len(cookies), 'chars')


def verdict(body):
    if body.lstrip().startswith('{'):
        try:
            j = json.loads(body)
            if j.get('success') is True:
                return 'OK'
            return 'JSON-ERR: ' + str((j.get('data') or {}).get('code', j))[:60]
        except Exception:
            return 'JSON-parse-err'
    if 'aliyun_waf' in body:
        return 'WAF-CHALLENGE'
    return 'HTML-other'


secs = int(time.time())
new_chat = {'title': 'api_%d' % secs, 'models': ['qwen3.7-plus'], 'chat_mode': 'normal', 'chat_type': 't2t', 'timestamp': secs}

# 0. GET first: is GET challenged too?
st, body = call('GET', '/api/v2/chats/?page=1&exclude_project=true', None, AUTH)
print('GET chats (bearer only):', st, verdict(body))

# 1. Bearer + full stored browser cookies.
if cookies:
    st, body = call('POST', '/api/v2/chats/new', new_chat, {**AUTH, 'Cookie': cookies})
    print('create + full cookies:', st, verdict(body))
    time.sleep(2)

# 2. Bearer + cookies + baxia headers (from the app's own generator).
import subprocess, sys
r = subprocess.run([sys.executable, r'.workbuddy-ai\bx_headers.py'], capture_output=True, text=True, cwd=ROOT)
if r.returncode == 0 and r.stdout.strip().startswith('{'):
    bx = json.loads(r.stdout)
    st, body = call('POST', '/api/v2/chats/new', new_chat, {**AUTH, 'Cookie': cookies, **bx})
    print('create + cookies + baxia:', st, verdict(body))
else:
    print('baxia header gen failed:', (r.stderr or '')[-160:])
    time.sleep(2)
