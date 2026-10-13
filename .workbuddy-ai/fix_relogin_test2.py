import io

p = r'E:\opencode-max\opencode-max\src\__tests__\qwenRelogin.test.ts'
NL = '\r\n'
text = io.open(p, encoding='utf-8', newline='').read()

old1 = "    expect(res.status).toBe(200);\r\n    expect(await res.text()).toContain('\"content\":\"ok\"');"
new1 = "    expect(res.status).toBe(200);\r\n    expect(await new Response(res.body!).text()).toContain('\"content\":\"ok\"');"
assert text.count(old1) == 1, text.count(old1)
text = text.replace(old1, new1)

old2 = """    const res = await client.forward({
      method: 'POST', path: '/chat/completions', query: '',
      headers: { 'content-type': 'application/json' },
      bodyText: forwardBody(),
      provider: 'qwen',
      allowAnonymous: true,
    });
    expect(res.status).toBe(401);"""
new2 = """    // Failed re-login -> 401 response -> dead-key failover exhausts the chain.
    await expect(
      client.forward({
        method: 'POST', path: '/chat/completions', query: '',
        headers: { 'content-type': 'application/json' },
        bodyText: forwardBody(),
        provider: 'qwen',
        allowAnonymous: true,
      }),
    ).rejects.toThrow(/invalid API key on account qwen-1/);"""
assert text.count(old2) == 1, text.count(old2)
text = text.replace(old2, new2)

io.open(p, 'w', encoding='utf-8', newline='').write(text)
print('test updated')
