# Emit the app's baxia headers as JSON (called from probe_waf2).
import json, subprocess, sys, os

ROOT = r'E:\opencode-max\opencode-max'
code = (
    "import { qwenBaxiaHeaders } from './src/qwenWeb.js';\n"
    "const h = await qwenBaxiaHeaders();\n"
    "const umidKey = 'bx-umidto' + 'ken';\n"
    "console.log(JSON.stringify({ 'bx-v': h['bx-v'], 'bx-ua': h['bx-ua'], [umidKey]: h[umidKey] }));\n"
)
r = subprocess.run(['npx', 'tsx', '-e', code], capture_output=True, text=True, cwd=ROOT, shell=True)
print(r.stdout.strip() if r.returncode == 0 else 'ERR: ' + (r.stderr or '')[-200:])
