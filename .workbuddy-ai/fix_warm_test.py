import io

p = r'E:\opencode-max\opencode-max\src\__tests__\qwenWeb.test.ts'
with io.open(p, encoding='utf-8', newline='') as f:
    t = f.read()
old1 = "credential: 'tok', model: 'qwen3.7-plus', messages: [{ role: 'user', content: 'hi' }], stream: false });"
new1 = "credential: 'warm-a', model: 'qwen3.7-plus', messages: [{ role: 'user', content: 'hi' }], stream: false });"
assert t.count(old1) == 1, t.count(old1)
t = t.replace(old1, new1)
old2 = "credential: 'tok2', model: 'qwen3.7-plus'"
assert t.count(old2) == 1
t = t.replace(old2, "credential: 'warm-b', model: 'qwen3.7-plus'")
with io.open(p, 'w', encoding='utf-8', newline='') as f:
    f.write(t)
print('ok')
