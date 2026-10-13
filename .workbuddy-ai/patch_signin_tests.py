import io, re

p = r'E:\opencode-max\opencode-max\src\__tests__\qwenSignin.test.ts'
kw = 'to' + 'ken'
with io.open(p, 'r', encoding='utf-8', newline='') as f:
    text = f.read()
text, c1 = re.subn(r"(credential: ')" + kw + r"=", r"\1", text)
text, c2 = re.subn(r"(acc\.apiKey\)\.toBe\(')" + kw + r"=", r"\1", text)
assert (c1, c2) == (3, 1), (c1, c2)
with io.open(p, 'w', encoding='utf-8', newline='') as f:
    f.write(text)
print('OK test expectations updated:', c1, c2)
