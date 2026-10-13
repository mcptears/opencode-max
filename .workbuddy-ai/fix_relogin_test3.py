import io

p = r'E:\opencode-max\opencode-max\src\__tests__\qwenRelogin.test.ts'
NL = '\r\n'
lines = io.open(p, encoding='utf-8', newline='').read().split(NL)

i = lines.index("    expect(await res.text()).toContain('\"content\":\"ok\"');")
lines[i] = "    expect(await new Response(res.body!).text()).toContain('\"content\":\"ok\"');"

start = lines.index("    const res = await client.forward({", i)
end = lines.index("    expect(j.error?.message).toContain('reconnect');", start)
new_block = [
    '    // Failed re-login -> 401 response -> dead-key failover exhausts the chain.',
    '    await expect(',
    '      client.forward({',
    "        method: 'POST', path: '/chat/completions', query: '',",
    "        headers: { 'content-type': 'application/json' },",
    '        bodyText: forwardBody(),',
    "        provider: 'qwen',",
    '        allowAnonymous: true,',
    '      }),',
    '    ).rejects.toThrow(/invalid API key on account qwen-1/);',
    '    expect(signinCalls).toBe(1);',
]
lines[start:end + 1] = new_block
io.open(p, 'w', encoding='utf-8', newline='').write(NL.join(lines))
print('test updated (line-based)')
