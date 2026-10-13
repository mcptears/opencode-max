# Insert the missing closing brace for the unauth block in the GET handler.
import io

p = r'E:\opencode-max\opencode-max\src\__tests__\qwenWeb.test.ts'
NL = '\r\n'
lines = io.open(p, encoding='utf-8', newline='').read().split(NL)

old = [
    "        if (mode === 'unauth') {",
    "          res.writeHead(401).end('{}');",
    '          return;',
    "        if (mode === 'expired') {",
]
new = [
    "        if (mode === 'unauth') {",
    "          res.writeHead(401).end('{}');",
    '          return;',
    '        }',
    "        if (mode === 'expired') {",
]
n = len(old)
hits = [i for i in range(len(lines) - n + 1) if lines[i:i + n] == old]
assert len(hits) == 1, f'hits={hits}'
i = hits[0]
lines[i:i + n] = new
io.open(p, 'w', encoding='utf-8', newline='').write(NL.join(lines))
print('brace inserted at line', i + 4)
