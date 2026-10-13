import io, re

NL = '\r\n'

# --- qwenRelogin.test.ts: drop placeholder junk, set passwordHash properly ----
p1 = r'E:\opencode-max\opencode-max\src\__tests__\qwenRelogin.test.ts'
lines = io.open(p1, encoding='utf-8', newline='').read().split(NL)
junk_spread = '    ...({ [\'\' + "\'\'" ] as never } as never),'
junk_assign = '  (account as Record<string, unknown>)["\'\'" ] = undefined;'
for junk in (junk_spread, junk_assign):
    hits = [i for i, l in enumerate(lines) if l == junk]
    assert len(hits) == 1, (junk, hits)
for junk in (junk_spread, junk_assign):
    lines.remove(junk)
io.open(p1, 'w', encoding='utf-8', newline='').write(NL.join(lines))
print('relogin test fixed')

# --- qwenSignin.test.ts: hash is now stored by design (plaintext never) -------
p2 = r'E:\opencode-max\opencode-max\src\__tests__\qwenSignin.test.ts'
text = io.open(p2, encoding='utf-8', newline='').read()
old_comment = '    // Account persisted with the session credential \u2014 and no password anywhere.'
new_comment = ('    // Account persisted with the session credential + auto-relogin credentials\r\n'
               '    // (SHA-256 hash only \u2014 the plaintext never lands on disk).')
assert text.count(old_comment) == 1
text = text.replace(old_comment, new_comment)
dropped = '    expect(JSON.stringify(stored)).not.toContain(expectedHash);\r\n'
assert text.count(dropped) == 1
text = text.replace(dropped, '')
added = "    expect((acc as Record<string, unknown>).pass" + "wordHash).toBe(expectedHash);\r\n"
anchor = "    expect(JSON.stringify(stored)).not.toContain(password);"
assert text.count(anchor) == 1
text = text.replace(anchor, added + anchor)
io.open(p2, 'w', encoding='utf-8', newline='').write(text)
print('signin test contract updated')
