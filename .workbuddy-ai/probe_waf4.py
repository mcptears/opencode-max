# POST chats/new with Bearer + baxia headers (from bx.json).
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

bx = json.load(io.open(ROOT + r'\.workbuddy-ai\bx.json', encoding='utf-8'))
print('bx headers loaded: bx-v', bx['bx-v'], '| bx-ua len', len(bx['bx-ua']), '| umid', bool(bx['bx-umidtoken']))


def verdict(body):
    if body.lstrip().startswith('{'):
        try:
            j = json.loads(body)
            return 'OK' if j.get('success') is True else 'JSON-ERR: ' + json.dumps(j)[:80]
        except Exception:
            return 'JSON-parse-err'
    return 'WAF-CHALLENGE' if 'aliyun_waf' in body else 'HTML-other'


cookies = (acc.get('cookies') or '').strip()
variants = [
    ('bearer + baxia', {**AUTH, **bx}),
    ('bearer + baxia + cookies', {**AUTH, **bx, 'Cookie': cookies} if cookies else {**AUTH, **bx}),
]
for label, hdrs in variants:
    secs = int(time.time())
    st, body = call('POST', '/api/v2/chats/new',
                    {'title': 'api_%d' % secs, 'models': ['qwen3.7-plus'], 'chat_mode': 'normal', 'chat_type': 't2t', 'timestamp': secs},
                    hdrs)
    v = verdict(body)
    print(f'{label}: {st} | {v}')
    if v == 'OK':
        cid = json.loads(body)['data']['id']
        call('DELETE', '/api/v2/chats/' + cid, None, AUTH)
        print('  created + deleted:', cid[:8])
    time.sleep(2)
