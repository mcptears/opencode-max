# Fix mock GET handler nesting in qwenWeb.test.ts: hoist the expired branch
# out of the unauth block and close the handler if correctly.
import io

p = r'E:\opencode-max\opencode-max\src\__tests__\qwenWeb.test.ts'
NL = '\r\n'
lines = io.open(p, encoding='utf-8', newline='').read().split(NL)

old = [
    "        if (mode === 'unauth') {",
    "          res.writeHead(401).end('{}');",
    '          return;',
    '        }',
    "        if (mode === 'expired') {",
    "          res.writeHead(200, { 'content-type': 'application/json' }).end('{\"success\":false,\"request_id\":\"r\",\"data\":{\"code\":\"unauthorized\",\"details\":\"Token has expired, please log in again.\"}}');",
    '          return;',
    '        }',
    '        }',
]
new = [
    "        if (mode === 'unauth') {",
    "          res.writeHead(401).end('{}');",
    '          return;',
    '        }',
    '      }',
    "      if (mode === 'expired') {",
    "        res.writeHead(200, { 'content-type': 'application/json' }).end('{\"success\":false,\"request_id\":\"r\",\"data\":{\"code\":\"unauthorized\",\"details\":\"Token has expired, please log in again.\"}}');",
    '        return;',
    '      }',
]
n = len(old)
hits = [i for i in range(len(lines) - n + 1) if lines[i:i + n] == old]
assert len(hits) == 1, f'hits={hits}'
i = hits[0]
lines[i:i + n] = new
io.open(p, 'w', encoding='utf-8', newline='').write(NL.join(lines))
print('fixed at line', i + 1)
