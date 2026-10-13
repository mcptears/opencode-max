import io

lines = io.open(r'src/__tests__/qwenSignin.test.ts', encoding='utf-8', newline='').read().split('\r\n')
for i, l in enumerate(lines, start=1):
    low = l.lower()
    if 'credential' in low or 'apikey' in low or 'set-cookie' in low or 'token' in low:
        print(i, repr(l))
