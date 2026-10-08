import { describe, it, expect } from 'vitest';
import { parseProxies, DEFAULT_PROVIDERS } from '../scraper.js';

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
    expect(DEFAULT_PROVIDERS.length).toBeGreaterThanOrEqual(4);
    for (const p of DEFAULT_PROVIDERS) {
      expect(p.id).toBeTruthy();
      expect(p.url).toMatch(/^https:\/\//);
      expect(['text', 'geonode']).toContain(p.format);
    }
  });
});
