import {test, expect} from '@playwright/test';

const email = process.env.E2E_ADMIN_EMAIL;
const password = process.env.E2E_ADMIN_PASSWORD;
if (!email || !password) throw new Error('Set E2E_ADMIN_EMAIL and E2E_ADMIN_PASSWORD for the live dashboard test');

test('protects data and shows live device observations after admin login', async ({page, request}) => {
  const unauthorized = await request.get('/api/overview');
  expect(unauthorized.status()).toBe(401);

  await page.goto('/login');
  await page.getByLabel('이메일').fill(email);
  await page.getByLabel('비밀번호').fill(password);
  await page.getByRole('button', {name: '로그인'}).click();
  await expect(page.getByRole('heading', {name: '개요'})).toBeVisible();
  const settingsBefore = await page.request.get('/api/settings');
  expect(settingsBefore.status()).toBe(200);
  const currentSettings = await settingsBefore.json();
  const invalidChange = currentSettings.rawRetentionDays > 1
    ? {fiveMinuteRetentionDays: currentSettings.rawRetentionDays - 1}
    : {rawRetentionDays: 2, fiveMinuteRetentionDays: 1};
  const invalidRetention = await page.request.patch('/api/settings', {data: invalidChange});
  expect(invalidRetention.status()).toBe(400);
  expect((await invalidRetention.json()).error).toBe('invalid_retention_order');
  expect(await (await page.request.get('/api/settings')).json()).toEqual(currentSettings);
  await expect(page.getByText('최근 원본 카운터')).toBeVisible();
  await expect(page.getByText('원본 카운터 수집 중')).toBeVisible();
  await page.getByRole('link', {name: '클라이언트', exact: true}).click();
  await expect(page.getByRole('heading', {name: '클라이언트'})).toBeVisible();
  await page.getByLabel('연결 방식').selectOption('wired');
  await page.getByRole('button', {name: '적용'}).click();
  await expect(page).toHaveURL(/connection=wired/);
  const wiredResponse = await page.request.get('/api/clients?connection=wired&limit=1');
  expect(wiredResponse.status()).toBe(200);
  const wired = (await wiredResponse.json()).rows[0];
  expect(wired).toBeTruthy();
  await page.getByLabel('이름, IP 또는 MAC').fill(wired.mac);
  await page.getByRole('button', {name: '적용'}).click();
  await expect(page).toHaveURL(/q=/);
  const firstClient = page.locator('a[href^="/clients/"]').first();
  await expect(firstClient).toHaveAttribute('href', `/clients/${wired.id}`);
  await firstClient.click();
  await expect(page.getByRole('heading', {name: '트래픽 계측'})).toBeVisible();
  await expect(page.getByText('사용량은 아직 표시하지 않습니다.')).toBeVisible();
  await page.goto('/settings');
  await expect(page.getByRole('heading', {name: '상태 · 설정'})).toBeVisible();
  await page.getByLabel('원본·상세 구간 (일)').fill('90');
  await page.getByLabel('5분 집계 (일)').fill('1');
  await page.getByRole('button', {name: '설정 저장'}).click();
  await expect(page.getByText('원본 ≤ 5분 집계 ≤ 시간 집계 순서와 허용 범위를 확인하세요.')).toBeVisible();
  await page.goto('/devices');
  await page.getByRole('link', {name: /연결 클라이언트 .*대 보기/}).first().click();
  await expect(page).toHaveURL(/deviceId=/);
  for (const width of [360, 390, 768, 1440]) {
    await page.setViewportSize({width, height: 900});
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }
  await page.emulateMedia({colorScheme: 'dark'});
  const dark = await page.locator('body').evaluate(node => ({background: getComputedStyle(node).backgroundColor,
    text: getComputedStyle(node).color}));
  await page.emulateMedia({colorScheme: 'light'});
  const light = await page.locator('body').evaluate(node => ({background: getComputedStyle(node).backgroundColor,
    text: getComputedStyle(node).color}));
  expect(dark.background).not.toBe(light.background);
  expect(dark.text).not.toBe(light.text);

  await page.goto('/');
  await page.route('**/api/overview', route => route.fulfill({status: 503, body: '{}'}));
  await expect(page.getByText('최신 상태를 읽지 못했습니다. 마지막으로 받은 값을 표시합니다.')).toBeVisible({timeout: 20000});
  await page.unroute('**/api/overview');
  await page.getByRole('button', {name: '다시 읽기'}).click();
  await expect(page.getByText('최신 상태를 읽지 못했습니다. 마지막으로 받은 값을 표시합니다.')).toHaveCount(0);

  const overviewResponse = await page.request.get('/api/overview');
  expect(overviewResponse.status()).toBe(200);
  const overview = await overviewResponse.json();
  expect(overview.counterClientCount).toBeGreaterThanOrEqual(0);
  expect(overview.counterClientCount).toBeLessThanOrEqual(overview.latestRun.clientCount);
  expect(overview.rawCounterCount).toBeGreaterThanOrEqual(overview.counterClientCount);
  await page.route('**/api/overview', route => route.fulfill({status: 200, json: {
    ...overview, rawCounterCount: null, latestRun: {...overview.latestRun, status: 'error', errorCode: 'http_429'}
  }}));
  await page.reload();
  await expect(page.getByText('수집 오류')).toBeVisible({timeout: 20000});
  await expect(page.getByText('최근 수집 실패로 확인 불가')).toBeVisible();
  await page.unroute('**/api/overview');
});
