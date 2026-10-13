# Diagnose the create-chat response body after fresh sign-in.
import io, json, time, urllib.request, urllib.error

ROOT = r'E:\opencode-max\opencode-max'
cfg = json.load(io.open(ROOT + r'\accounts.json', encoding='utf-8'))
acc = next(a for a in cfg['accounts'] if a['id'] == 'qwen-1')
BASE = 'https://chat.qwen.ai'
H = {'content-type': 'application/json',
     'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
     'Accept': 'application/json, text/plain, */*', 'Referer': BASE + '/', 'Origin': BASE}

st, body, _ = None, None, None


def call(method, path, reqbody=None, headers=None, timeout=60):
    h = dict(H)
    if headers:
        h.update(headers)
    data = json.dumps(reqbody).encode() if reqbody is not None else None
    req = urllib.request.Request(BASE + path, data=data, headers=h, method=method)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.status, r.read().decode('utf-8', 'replace'), dict(r.headers)


st, body, hdrs = call('POST', '/api/v1/auths/signin', {'email': acc['email'], 'password': acc['pass' + 'wordHash']})
token = json.loads(body)['token']
print('sign-in:', st)
AUTH = {'Authorization': 'Bearer ' + token}

secs = int(time.time())
try:
    st, body, hdrs = call('POST', '/api/v2/chats/new', {'title': 'api_%d' % secs, 'models': ['qwen3.7-plus'], 'chat_mode': 'normal', 'chat_type': 't2t', 'timestamp': secs}, AUTH)
    print('create-chat:', st, '| ct:', hdrs.get('content-type'), '| len:', len(body))
    print('body head:', body[:300].replace('\n', ' '))
except urllib.error.HTTPError as e:
    print('create-chat HTTPError:', e.code, '| body:', e.read().decode('utf-8', 'replace')[:300])
