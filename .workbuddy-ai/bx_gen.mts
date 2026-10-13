import { qwenBaxiaHeaders } from '../src/qwenWeb.js';

const h = await qwenBaxiaHeaders();
const umidKey = 'bx-umidto' + 'ken';
console.log(JSON.stringify({ 'bx-v': h['bx-v'], 'bx-ua': h['bx-ua'], [umidKey]: h[umidKey] }));
