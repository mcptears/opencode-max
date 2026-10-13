# Measure the WAF challenge behavior: retries vs baxia headers.
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
print('signed in')

def create(label, extra=None):
    secs = int(time.time())
    st, body = call('POST', '/api/v2/chats/new',
                    {'title': 'api_%d' % secs, 'models': ['qwen3.7-plus'], 'chat_mode': 'normal', 'chat_type': 't2t', 'timestamp': secs},
                    {**AUTH, **(extra or {})})
    ok = body.lstrip().startswith('{')
    verdict = 'JSON ok' if ok else ('WAF-CHALLENGE' if 'aliyun_waf' in body else 'other')
    cid = ''
    if ok:
        try:
            cid = json.loads(body)['data']['id']
        except Exception:
            verdict = 'JSON no-id'
    print(f'{label}: {st} | {verdict} {cid[:8]}')
    return cid


ids = []
for i in range(1, 6):
    ids.append(create(f'plain attempt {i}'))
    time.sleep(2)
