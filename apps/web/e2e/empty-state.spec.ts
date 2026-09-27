import {test, expect} from '@playwright/test';

test.skip(process.env.E2E_EMPTY_DB !== '1', 'Runs only against a freshly migrated empty database');

test('shows the initial connection state after admin login', async ({page, request}) => {
  const email = process.env.E2E_ADMIN_EMAIL;
  const password = process.env.E2E_ADMIN_PASSWORD;
  if (!email || !password) throw new Error('Set temporary admin credentials');

  expect((await request.get('/api/overview')).status()).toBe(401);
  await page.goto('/login');
  await page.getByLabel('이메일').fill(email);
  await page.getByLabel('비밀번호').fill(password);
  await page.getByRole('button', {name: '로그인'}).click();
  await expect(page.getByRole('heading', {name: '개요'})).toBeVisible();
  await expect(page.getByText('등록된 사이트가 없습니다.')).toBeVisible();
  await expect(page.getByText('첫 수집 대기 중')).toBeVisible();
  await expect(page.getByText('시작 전')).toBeVisible();

  const response = await page.request.get('/api/overview');
  expect(response.status()).toBe(200);
  expect(await response.json()).toMatchObject({sites: [], clientCount: 0, onlineCount: null,
    rawCounterCount: null, latestRun: null, hasMeasuredUsage: false, traffic: null});
  await page.goto('/settings');
  await expect(page.getByText('수집 기록이 없습니다.')).toBeVisible();
});
