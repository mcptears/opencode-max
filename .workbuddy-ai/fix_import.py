import io

p = r'E:\opencode-max\opencode-max\src\upstreamClient.ts'
with io.open(p, 'r', encoding='utf-8', newline='') as f:
    text = f.read()
old = "import { qwenChatCompletion, resolveQwenModel, QwenWebError } from './qwenWeb.js';"
new = "import { qwenChatCompletion, resolveQwenModel, qwenSignIn, QwenWebError } from './qwenWeb.js';"
assert text.count(old) == 1, text.count(old)
text = text.replace(old, new)
with io.open(p, 'w', encoding='utf-8', newline='') as f:
    f.write(text)
print('import fixed')
