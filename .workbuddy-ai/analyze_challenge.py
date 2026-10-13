import io, re

t = io.open(r'.workbuddy-ai/challenge.html', encoding='utf-8').read()
for m in re.finditer(r'<meta name="(aliyun_waf_[a-z]+)" content="([^"]+)"', t):
    print('meta:', m.group(1), '=', m.group(2)[:44])

for pat in ['aliyun_waf_aa', 'aliyun_waf_bb', 'getElementsByTagName', 'location', 'fromCharCode']:
    idx = t.find(pat)
    if idx < 0:
        print('---', pat, ': not found')
        continue
    seg = t[max(0, idx - 150):idx + 200].replace('\n', ' ')
    print('---', pat, '---')
    print(seg[:340])
