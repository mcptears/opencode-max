# Capture the current WAF response for a plain POST (cheap, no real account use).
import io, json, time, urllib.request, urllib.error

BASE = 'https://chat.qwen.ai'
H = {'content-type': 'application/json',
     'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
     'Accept': 'application/json, text/plain, */*', 'Referer': BASE + '/', 'Origin': BASE}

secs = int(time.time())
body = json.dumps({'title': 'api_%d' % secs, 'models': ['qwen3.7-plus'], 'chat_mode': 'normal', 'chat_type': 't2t', 'timestamp': secs}).encode()
req = urllib.request.Request(BASE + '/api/v2/chats/new', data=body, headers={**H, 'Authorization': 'Bearer probe-invalid'}, method='POST')
try:
    with urllib.request.urlopen(req, timeout=45) as r:
        text = r.read().decode('utf-8', 'replace')
        print('status:', r.status, '| ct:', r.headers.get('content-type'), '| len:', len(text))
except urllib.error.HTTPError as e:
    text = e.read().decode('utf-8', 'replace')
    print('HTTPError:', e.code, '| ct:', e.headers.get('content-type'), '| len:', len(text))

if text.lstrip().startswith('{'):
    print('JSON:', text[:220])
else:
    io.open(r'.workbuddy-ai\challenge.html', 'w', encoding='utf-8').write(text)
    print('HTML saved. head:', text[:150].replace('\n', ' '))
    for marker in ('aliyun_waf_aa', 'aliyun_waf_bb', 'acw_sc__v2', 'arg1', 'unsbox', '_0x'):
        print(f'  contains {marker}:', marker in text)
