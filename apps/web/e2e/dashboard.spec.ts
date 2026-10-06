import {test, expect} from '@playwright/test';

test('overview, clients, devices and settings work with live data', async ({page}) => {
  // A signed-in visitor skips the login page.
  await page.goto('/login');
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('heading', {name: '네트워크 한눈에 보기'})).toBeVisible();
  await expect(page.getByText('최근 트래픽 정보')).toBeVisible();

  await page.getByRole('link', {name: '클라이언트', exact: true}).click();
  await expect(page.getByRole('heading', {name: '클라이언트', level: 1})).toBeVisible();
  await page.getByRole('button', {name: /연결 방식/}).click();
  await page.getByRole('option', {name: '유선'}).click();
  await page.getByRole('button', {name: '필터 적용'}).click();
  await expect(page).toHaveURL(/connection=wired/);
  const wired = (await (await page.request.get('/api/clients?connection=wired&limit=1')).json()).rows[0];
  expect(wired).toBeTruthy();
  await page.getByLabel('이름, IP 또는 MAC').fill(wired.mac);
  await page.getByRole('button', {name: '필터 적용'}).click();
  await expect(page).toHaveURL(/q=/);
  const first = page.locator('a[href^="/clients/"]').first();
  await expect(first).toHaveAttribute('href', `/clients/${wired.id}`);
  await first.click();
  await expect(page.getByRole('heading', {name: '연결 정보'})).toBeVisible();
  await expect(page.getByText(wired.mac)).toBeVisible();

  // A hand-edited list URL falls back to the defaults.
  expect((await page.goto('/clients?limit=500&page=abc&connection=foo&q=a&q=b'))?.status()).toBe(200);
  await expect(page.getByRole('heading', {name: '클라이언트', level: 1})).toBeVisible();

  await page.goto('/devices');
  await page.getByRole('link', {name: /연결 클라이언트 .*대 보기/}).first().click();
  await expect(page).toHaveURL(/deviceId=/);

  await page.goto('/settings');
  await expect(page.getByRole('heading', {name: '상태 · 설정'})).toBeVisible();
  const settings = await (await page.request.get('/api/settings')).json();
  await page.getByLabel('원본·상세 구간 (일)').fill('90');
  await page.getByLabel('5분 집계 (일)').fill('1');
  await page.getByRole('button', {name: '설정 저장'}).click();
  await expect(page.getByText('원본 ≤ 5분 집계 ≤ 시간 집계 순서와 허용 범위를 확인하세요.')).toBeVisible();
  const rejected = await page.request.patch('/api/settings', {data: {rawRetentionDays: 10, fiveMinuteRetentionDays: 5}});
  expect(rejected.status()).toBe(400);
  expect((await rejected.json()).error).toBe('invalid_retention_order');
  expect(await (await page.request.get('/api/settings')).json()).toEqual(settings);

  for (const width of [360, 390, 768, 1440]) {
    await page.setViewportSize({width, height: 900});
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `width ${width}`).toBe(true);
  }
  await page.emulateMedia({colorScheme: 'dark'});
  const dark = await page.locator('body').evaluate(node => ({background: getComputedStyle(node).backgroundColor,
    text: getComputedStyle(node).color}));
  await page.emulateMedia({colorScheme: 'light'});
  const light = await page.locator('body').evaluate(node => ({background: getComputedStyle(node).backgroundColor,
    text: getComputedStyle(node).color}));
  expect(dark.background).not.toBe(light.background);
  expect(dark.text).not.toBe(light.text);
});

test('overview keeps the last values when the API fails and explains a failed collection', async ({page}) => {
  await page.goto('/');
  await expect(page.getByRole('heading', {name: '네트워크 한눈에 보기'})).toBeVisible();
  // The page refetches when a collection finishes; trigger that directly.
  const refetch = () => page.evaluate(() => window.dispatchEvent(new Event('utm:collection')));
  const banner = page.getByText('최신 상태를 읽지 못했습니다. 마지막으로 받은 값을 표시합니다.');
  await page.route('**/api/overview', route => route.fulfill({status: 503, body: '{}'}));
  await refetch();
  await expect(banner).toBeVisible({timeout: 15000});
  await page.unroute('**/api/overview');
  await page.getByRole('button', {name: '다시 읽기'}).click();
  await expect(banner).toHaveCount(0);

  const overview = await (await page.request.get('/api/overview')).json();
  expect(overview.counterClientCount).toBeLessThanOrEqual(overview.latestRun.clientCount);
  await page.route('**/api/overview', route => route.fulfill({status: 200, json: {
    ...overview, rawCounterCount: null, latestRun: {...overview.latestRun, status: 'error', errorCode: 'http_401'}
  }}));
  await refetch();
  await expect(page.getByText('최근 수집 실패로 확인할 수 없습니다')).toBeVisible({timeout: 15000});
  await expect(page.getByText(/API 키 확인 · 마지막 성공/)).toBeVisible();
  await page.unroute('**/api/overview');
});
