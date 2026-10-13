# Preserve re-login credentials across dashboard account edits (PUT).
import io

p = r'E:\opencode-max\opencode-max\src\adminRoutes.ts'
NL = '\r\n'
lines = io.open(p, encoding='utf-8', newline='').read().split(NL)

old = [
    '    const v = validateAccount({ ...body, id: req.params.id });',
    '    if (!v.ok) {',
    '      res.status(400).json({ error: { message: v.error, status: 400 } });',
    '      return;',
    '    }',
    '    accounts[i] = v.account;',
]
new = [
    '    const v = validateAccount({ ...body, id: req.params.id });',
    '    if (!v.ok) {',
    '      res.status(400).json({ error: { message: v.error, status: 400 } });',
    '      return;',
    '    }',
    '    // Preserve the Qwen auto-relogin credentials across edits (they are never',
    '    // sent to the UI) unless the request explicitly supplies new ones.',
    '    const prev = accounts[i];',
    '    v.account.email =',
    "      typeof body.email === 'string' && body.email.trim() ? body.email.trim() : prev.email;",
    '    v.account.passwordHash =',
    "      typeof body.passwordHash === 'string' && body.passwordHash.trim() ? body.passwordHash.trim() : prev.passwordHash;",
    '    accounts[i] = v.account;',
]
n = len(old)
hits = [k for k in range(len(lines) - n + 1) if lines[k:k + n] == old]
assert len(hits) == 1, hits
k = hits[0]
lines[k:k + n] = new
io.open(p, 'w', encoding='utf-8', newline='').write(NL.join(lines))
print('PUT preservation added')
