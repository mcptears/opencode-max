# Remove the duplicate closing brace left over from the mis-nesting.
import io

p = r'E:\opencode-max\opencode-max\src\__tests__\qwenWeb.test.ts'
NL = '\r\n'
lines = io.open(p, encoding='utf-8', newline='').read().split(NL)

old = [
    '        }',
    '        }',
    "        res.writeHead(200, { 'content-type': 'application/json' }).end('{\"success\":true,\"data\":[]}');",
]
new = [
    '        }',
    "        res.writeHead(200, { 'content-type': 'application/json' }).end('{\"success\":true,\"data\":[]}');",
]
n = len(old)
hits = [i for i in range(len(lines) - n + 1) if lines[i:i + n] == old]
assert len(hits) == 1, f'hits={hits}'
i = hits[0]
lines[i:i + n] = new
io.open(p, 'w', encoding='utf-8', newline='').write(NL.join(lines))
print('dedup brace done')
