# Set the fresh qwen-1 credential in accounts.json, then immediately
# validate + one chat turn against the real upstream.
import io, json, time, base64, urllib.request

ACC = r'E:\opencode-max\opencode-max\accounts.json'

# Token supplied by the user (localStorage.getItem("token")). Passed via
# env to keep it out of this file and any logs.
tok = __import__('os').environ['QWEN_FRESH_TOKEN']

# Decode the JWT payload (no verification — just read iat/exp).
payload_b64 = tok.split('.')[1]
payload_b64 += '=' * (-len(payload_b64) % 4)
claims = json.loads(base64.urlsafe_b64decode(payload_b64))
now = int(time.time())
print('token iat:', claims.get('iat'), 'exp:', claims.get('exp'), 'now:', now,
      '| valid for', claims.get('exp', 0) - now, 's at write time')

cfg = json.load(io.open(ACC, encoding='utf-8'))
acc = next(a for a in cfg['accounts'] if a['id'] == 'qwen-1')
acc['apiKey'] = tok
with io.open(ACC, 'w', encoding='utf-8') as f:
    json.dump(cfg, f, indent=2, ensure_ascii=False)
    f.write('\n')
print('accounts.json updated: qwen-1 apiKey replaced, len', len(tok))

# Live check: validate credential (chats list) then one real create+turn.
headers = {
    'Authorization': 'Bearer ' + tok,
    'x-request-id': __import__('uuid').uuid4(),
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Referer': 'https://chat.qwen.ai/',
    'Origin': 'https://chat.qwen.ai',
    'content-type': 'application/json',
}

req = urllib.request.Request('https://chat.qwen.ai/api/v2/chats/?page=1&exclude_project=true', headers=headers)
with urllib.request.urlopen(req, timeout=30) as r:
    body = r.read().decode('utf-8', 'replace')
    print('validate status:', r.status, '| success flag:', json.loads(body).get('success'))

secs = int(time.time())
new_body = json.dumps({
    'title': 'api_%d' % secs, 'models': ['qwen3.7-plus'], 'chat_mode': 'normal',
    'chat_type': 't2t', 'timestamp': secs,
}).encode()
req = urllib.request.Request('https://chat.qwen.ai/api/v2/chats/new', data=new_body, headers=headers, method='POST')
with urllib.request.urlopen(req, timeout=30) as r:
    body = r.read().decode('utf-8', 'replace')
j = json.loads(body)
chat_id = (j.get('data') or {}).get('id')
print('create-chat status:', r.status, '| success:', j.get('success'), '| chat id:', (chat_id or 'none')[:8])

if chat_id:
    print('LIVE CHECK: create-chat works — token is valid; run the full repro next.')
else:
    print('LIVE CHECK: create-chat still failing:', body[:200])
