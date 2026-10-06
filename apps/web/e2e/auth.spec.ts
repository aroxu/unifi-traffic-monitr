import {test, expect} from '@playwright/test';

// These requests come from a visitor without a session.
test.use({storageState: {cookies: [], origins: []}});

// The router state a browser sends when it navigates away from /devices. The
// server then renders only segments that differ, without the shared layout.
const fromDevices = encodeURIComponent(JSON.stringify(
  ['', {children: ['(dashboard)', {children: ['devices', {children: ['__PAGE__', {}]}]}]}]));

test('every page and API needs a session, including client navigation requests', async ({request}) => {
  for (const path of ['/', '/clients', '/devices', '/settings']) {
    const response = await request.get(path, {maxRedirects: 0});
    expect(response.status(), path).toBe(307);
    expect(response.headers().location, path).toContain('/login');
  }
  for (const path of ['/', '/clients', '/settings']) {
    const response = await request.get(path, {headers: {RSC: '1', 'Next-Router-State-Tree': fromDevices}});
    // An HTML response would mean the navigation headers were lost and the
    // ordinary page redirect was tested instead.
    expect(response.headers()['content-type'], path).toContain('text/x-component');
    const body = await response.text();
    expect(body, path).toContain('/login');
    // Page data such as client counts, retention settings or LAN addresses.
    expect(body, path).not.toMatch(/전체 \d+대|보존 설정|clientLabels|\b(?:10|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d+\.\d+/);
  }
  for (const path of ['/api/overview', '/api/clients', '/api/devices', '/api/settings', '/api/collector/status']) {
    expect((await request.get(path)).status(), path).toBe(401);
  }
});
