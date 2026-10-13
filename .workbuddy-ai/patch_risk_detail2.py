# riskControlError: always carry the upstream verdict (any JSON shape / raw text).
import io

NL = '\r\n'
p = r'E:\opencode-max\opencode-max\src\qwenWeb.ts'
lines = io.open(p, encoding='utf-8', newline='').read().split(NL)

old = [
    'function riskControlError(text: string): QwenWebError | null {',
    '  if (RISK_PATTERNS.test(text)) {',
    '    const j = parseUpstreamJson(text);',
    "    const detail = j && j.success === false ? ` (upstream: ${upstreamErrorText(j)})` : '';",
    '    return new QwenWebError(`qwen risk control triggered — account parked in cooldown${detail}`, 429);',
    '  }',
    '  return null;',
    '}',
]
new = [
    'function riskControlError(text: string): QwenWebError | null {',
    '  if (RISK_PATTERNS.test(text)) {',
    '    const j = parseUpstreamJson(text);',
    "    const detail = j ? ` (upstream: ${upstreamErrorText(j)})` : ` (upstream: ${text.slice(0, 120).replace(/\\s+/g, ' ')})`;",
    '    return new QwenWebError(`qwen risk control triggered — account parked in cooldown${detail}`, 429);',
    '  }',
    '  return null;',
    '}',
]
n = len(old)
hits = [i for i in range(len(lines) - n + 1) if lines[i:i + n] == old]
assert len(hits) == 1, hits
lines[hits[0]:hits[0] + n] = new
io.open(p, 'w', encoding='utf-8', newline='').write(NL.join(lines))
print('ok')
