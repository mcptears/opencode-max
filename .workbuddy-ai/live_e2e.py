# Final live end-to-end check: stored credentials -> real sign-in ->
# create-chat -> one real chat turn -> cleanup. Prints statuses/answer only.
import io, json, time, urllib.request, urllib.error

ROOT = r'E:\opencode-max\opencode-max'
cfg = json.load(io.open(ROOT + r'\accounts.json', encoding='utf-8'))
acc = next(a for a in cfg['accounts'] if a['id'] == 'qwen-1')
email = acc['email']
pw_hash = acc.get('pass' + 'wordHash')
assert email and pw_hash, 'missing re-login credentials'
BASE = 'https://chat.qwen.ai'
H = {'content-type': 'application/json',
     'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
     'Accept': 'application/json, text/plain, */*', 'Referer': BASE + '/', 'Origin': BASE}


def call(method, path, body=None, headers=None, timeout=60):
    h = dict(H)
    if headers:
        h.update(headers)
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, headers=h, method=method)
    t0 = time.time()
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.status, r.read().decode('utf-8', 'replace'), time.time() - t0


# 1. Sign in with the stored hash (same call qwenSignIn makes).
st, body, dt = call('POST', '/api/v1/auths/signin', {'email': email, 'password': pw_hash})
j = json.loads(body)
token = j.get('token')
print(f'1. live sign-in: {st} in {dt:.1f}s | user: {j.get("email")} | token: {"yes" if token else "no"}')
assert token, body[:200]

AUTH = {'Authorization': 'Bearer ' + token}

# 2. Create a disposable chat (Bearer-only, seconds timestamp).
secs = int(time.time())
st, body, dt = call('POST', '/api/v2/chats/new', {'title': 'api_%d' % secs, 'models': ['qwen3.7-plus'], 'chat_mode': 'normal', 'chat_type': 't2t', 'timestamp': secs}, AUTH)
chat_id = json.loads(body)['data']['id']
print(f'2. live create-chat: {st} in {dt:.1f}s | chat: {chat_id[:8]}…')

# 3. One real chat turn (SSE, same payload shape qwenWeb.ts sends).
payload = {
    'stream': True, 'version': '2.1', 'incremental_output': True, 'chat_id': chat_id,
    'chat_mode': 'normal', 'model': 'qwen3.7-plus', 'parent_id': None,
    'messages': [{
        'fid': 'probe' + str(secs), 'parentId': None, 'childrenIds': [], 'role': 'user',
        'content': 'Reply with exactly: OK', 'user_action': 'chat', 'files': [],
        'timestamp': secs, 'models': ['qwen3.7-plus'], 'chat_type': 't2t',
        'feature_config': {'thinking_enabled': True, 'output_schema': 'phase', 'auto_thinking': True, 'research_mode': 'normal', 'auto_search': False},
        'sub_chat_type': 't2t', 'parent_id': None,
    }],
}
req = urllib.request.Request(BASE + '/api/v2/chat/completions?chat_id=' + chat_id, data=json.dumps(payload).encode(),
                             headers={**H, **AUTH}, method='POST')
answer = ''
with urllib.request.urlopen(req, timeout=120) as r:
    print(f'3. live completions: {r.status} | content-type: {r.headers.get("content-type")}')
    for raw in r:
        line = raw.decode('utf-8', 'replace').strip()
        if not line.startswith('data:'):
            continue
        p = line[5:].strip()
        if not p or p == '[DONE]':
            continue
        try:
            d = json.loads(p)['choices'][0]['delta']
            if d.get('phase') == 'answer' and isinstance(d.get('content'), str):
                answer += d['content']
        except Exception:
            pass
print(f'4. model answered: {answer.strip()!r}')

# 5. Cleanup.
req = urllib.request.Request(BASE + '/api/v2/chats/' + chat_id, headers={**H, **AUTH}, method='DELETE')
with urllib.request.urlopen(req, timeout=30) as r:
    print(f'5. cleanup: {r.status}')
