# Follow-up: is signin tarpitted while plain GETs work? Longer timeout, v2,
# and a refresh-endpoint check. Never prints secrets.
import json, os, time, urllib.request, urllib.error

BASE = 'https://chat.qwen.ai'
UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'


def req(method, path, body=None, headers=None, timeout=70):
    h = {'User-Agent': UA, 'Accept': 'application/json, text/plain, */*',
         'Referer': BASE + '/', 'Origin': BASE, 'content-type': 'application/json'}
    if headers:
        h.update(headers)
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(BASE + path, data=data, headers=h, method=method)
    t0 = time.time()
    try:
        with urllib.request.urlopen(r, timeout=timeout) as resp:
            return resp.status, resp.read().decode('utf-8', 'replace'), time.time() - t0
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode('utf-8', 'replace'), time.time() - t0
    except Exception as e:
        return None, f'{type(e).__name__}: {e}', time.time() - t0


# 1. Control: unauthenticated GET (should be fast).
st, body, dt = req('GET', '/api/v2/chats/?page=1&exclude_project=true', timeout=20)
print(f'control GET chats: status={st} dt={dt:.1f}s body={body[:120]!r}')

# 2. Signin v1 with long timeout.
import hashlib
pw_hash = hashlib.sha256(os.environ['QWEN_PASS'].encode()).hexdigest()
st, body, dt = req('POST', '/api/v1/auths/signin', {'email': os.environ['QWEN_EMAIL'], 'password': pw_hash})
print(f'signin v1 (70s): status={st} dt={dt:.1f}s body={body[:200]!r}')

# 3. Signin v2 (only if v1 failed).
if st != 200:
    st, body, dt = req('POST', '/api/v2/auths/signin', {'email': os.environ['QWEN_EMAIL'], 'password': pw_hash})
    print(f'signin v2 (70s): status={st} dt={dt:.1f}s body={body[:200]!r}')

# 4. Refresh endpoint probe (no auth).
st, body, dt = req('POST', '/api/v1/auths/refresh', {})
print(f'refresh probe: status={st} dt={dt:.1f}s body={body[:160]!r}')
