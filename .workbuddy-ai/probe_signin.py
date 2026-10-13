# Probe the real Qwen sign-in REST flow. Credentials come from env; the
# script prints statuses, cookie NAMES, and token claims only — never secrets.
import io, json, os, time, base64, hashlib, urllib.request, urllib.error

EMAIL = os.environ['QWEN_EMAIL']
PASSWORD = os.environ['QWEN_PASS']
BASE = 'https://chat.qwen.ai'


def jwt_claims(tok):
    try:
        p = tok.split('.')[1]
        p += '=' * (-len(p) % 4)
        return json.loads(base64.urlsafe_b64decode(p))
    except Exception as e:
        return {'err': str(e)}


def post(path, body, headers=None):
    data = json.dumps(body).encode()
    h = {'content-type': 'application/json', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
         'Accept': 'application/json, text/plain, */*', 'Referer': BASE + '/', 'Origin': BASE}
    if headers:
        h.update(headers)
    req = urllib.request.Request(BASE + path, data=data, headers=h, method='POST')
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, r.read().decode('utf-8', 'replace'), r.headers
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode('utf-8', 'replace'), e.headers


pw_hash = hashlib.sha256(PASSWORD.encode()).hexdigest()

# Attempt 1: SHA-256 hash (what the web frontend sends).
st, body, hdrs = post('/api/v1/auths/signin', {'email': EMAIL, 'password': pw_hash})
print('signin v1 sha256 ->', st, '| body:', body[:260].replace('\n', ' '))
cookies = []
try:
    cookies = [c.split(';')[0] for c in hdrs.get_all('Set-Cookie') or []]
except Exception:
    pass
print('set-cookie names:', [c.split('=')[0] for c in cookies])

token = None
j = None
try:
    j = json.loads(body)
except Exception:
    pass
if isinstance(j, dict):
    t = j.get('token') or (j.get('data') or {}).get('token')
    if isinstance(t, str) and t:
        token = t
if not token:
    for c in cookies:
        if c.startswith('token='):
            token = c[6:]
if token:
    cl = jwt_claims(token)
    print('got token: len', len(token), '| iat', cl.get('iat'), 'exp', cl.get('exp'), '| lifetime_s', (cl.get('exp', 0) - cl.get('iat', 0)))

    # Immediately verify the fresh token works Bearer-only on create-chat.
    h2 = {'Authorization': 'Bearer ' + token, 'content-type': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Accept': 'application/json, text/plain, */*', 'Referer': BASE + '/', 'Origin': BASE}
    secs = int(time.time())
    req = urllib.request.Request(BASE + '/api/v2/chats/new',
                                 data=json.dumps({'title': 'api_%d' % secs, 'models': ['qwen3.7-plus'], 'chat_mode': 'normal', 'chat_type': 't2t', 'timestamp': secs}).encode(),
                                 headers=h2, method='POST')
    with urllib.request.urlopen(req, timeout=30) as r:
        cj = json.loads(r.read().decode())
    chat_id = (cj.get('data') or {}).get('id')
    print('create-chat with signed-in token:', r.status, '| success:', cj.get('success'), '| id:', (chat_id or 'none')[:8])
    if chat_id:
        d = urllib.request.Request(BASE + '/api/v2/chats/' + chat_id, headers=h2, method='DELETE')
        with urllib.request.urlopen(d, timeout=30) as r:
            print('cleanup:', r.status)
else:
    # Attempt 2: some deployments expect the plaintext password.
    if st in (400, 401, 403):
        st2, body2, _ = post('/api/v1/auths/signin', {'email': EMAIL, 'password': PASSWORD})
        print('signin v1 plaintext ->', st2, '| body:', body2[:260].replace('\n', ' '))
    else:
        # captcha / challenge / other shape — show structure with values redacted
        def redact(o):
            if isinstance(o, dict):
                return {k: ('<redacted>' if any(s in k.lower() for s in ('token', 'captcha', 'password', 'sig')) else redact(v)) for k, v in o.items()}
            if isinstance(o, list):
                return [redact(x) for x in o]
            return o
        print('unparsed response structure:', json.dumps(redact(j))[:400] if j else body[:400])
