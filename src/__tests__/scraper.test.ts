import { describe, it, expect } from 'vitest';
import { parseProxies, parseSpysProxies, parseFplProxies, parseProxynovaProxies, DEFAULT_PROVIDERS } from '../scraper.js';

describe('scraper parseProxies', () => {
  it('parses text lists (ip:port and full URLs)', () => {
    const out = parseProxies('1.2.3.4:8080\nhttp://5.6.7.8:3128\n\nnot-a-proxy\n', 'text');
    expect(out).toEqual(['http://1.2.3.4:8080', 'http://5.6.7.8:3128']);
  });

  it('parses GeoNode JSON', () => {
    const json = JSON.stringify({
      data: [
        { ip: '1.1.1.1', port: 8080, protocols: ['http', 'https'] },
        { ip: '2.2.2.2', port: '3128', protocols: ['socks5'] },
        { ip: '3.3.3.3', port: 80, protocols: ['https'] },
      ],
    });
    expect(parseProxies(json, 'geonode')).toEqual(['http://1.1.1.1:8080', 'http://3.3.3.3:80']);
  });

  it('returns empty on malformed input', () => {
    expect(parseProxies('garbage{{{', 'geonode')).toEqual([]);
    expect(parseProxies('', 'text')).toEqual([]);
  });

  it('ships curated default providers', () => {
    expect(DEFAULT_PROVIDERS.length).toBeGreaterThanOrEqual(7);
    for (const p of DEFAULT_PROVIDERS) {
      expect(p.id).toBeTruthy();
      expect(p.url).toMatch(/^https:\/\//);
      expect(['text', 'geonode', 'spys', 'fpl', 'proxynova']).toContain(p.format);
    }
  });

  it('decodes spys.one obfuscated ports', () => {
    // packed-script fixture: the payload passes through, rows carry (A^B) port pairs.
    // (single backslashes: the fixture's decode regex no-ops so the payload survives)
    const unpacker = `eval(function(p,r,o,x,y,s){y=function(c){return(c<r?'':y(parseInt(c/r)))+((c=c%r)>35?String.fromCharCode(c+29):c.toString(36))};if(!''.replace(/^/,String)){while(o--){s[y(o)]=x[o]||y(o)}x=[function(y){return s[y]}];y=function(){return'\\w+'};o=1};while(o--){if(x[o]){p=p.replace(new RegExp('\\b'+y(o)+'\\b','g'),x[o])}}return p}('Six=808;Zero=0;',62,0,'',0,{}))`;
    const html =
      `<script type="text/javascript">${unpacker}</script>` +
      `<font class=spy14>1.2.3.4<script>document.write(":"+(Six^Zero))</script></font></td><td colspan=1><font class=spy1>HTTP</font>` +
      `<font class=spy14>5.6.7.8<script>document.write(":"+(Six^Zero))</script></font></td><td colspan=1><font class=spy1>SOCKS</font>`;
    expect(parseSpysProxies(html)).toEqual(['http://1.2.3.4:808']);
  });

  it('parses free-proxy-list.net table rows', () => {
    const html = `<table><tr><td>65.108.159.129</td><td>8081</td><td>DE</td></tr>` +
      `<tr><td>165.154.162.73</td><td>8888</td><td>US</td></tr></table>`;
    expect(parseFplProxies(html)).toEqual(['http://65.108.159.129:8081', 'http://165.154.162.73:8888']);
  });

  it('evaluates proxynova obfuscated IP expressions', () => {
    const html = `<tr data-proxy-id="1"><td align="left"><script>document.write("1.07.947.91.120.191.07".substring(10-4, 9+9))</script></td><td>1234</td></tr>` +
      `<tr data-proxy-id="2"><td align="left"><script>document.write("8.".repeat(3).substring(4).concat("219.229.53".repeat(1).substring(0)))</script></td><td>80</td></tr>`;
    expect(parseProxynovaProxies(html)).toEqual(['http://47.91.120.19:1234', 'http://8.219.229.53:80']);
  });
});
