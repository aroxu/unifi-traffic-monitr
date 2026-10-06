import {test, expect} from '@playwright/test';

test.skip(process.env.E2E_EMPTY_DB !== '1', 'Runs only against a freshly migrated empty database');

test('shows the initial connection state', async ({page}) => {
  await page.goto('/');
  await expect(page.getByRole('heading', {name: '네트워크 한눈에 보기'})).toBeVisible();
  await expect(page.getByText('등록된 사이트가 없습니다.')).toBeVisible();
  await expect(page.getByText('첫 수집을 기다리는 중입니다')).toBeVisible();
  await expect(page.getByText('시작 전')).toBeVisible();

  const response = await page.request.get('/api/overview');
  expect(response.status()).toBe(200);
  expect(await response.json()).toMatchObject({sites: [], clientCount: 0, onlineCount: null,
    rawCounterCount: null, latestRun: null, hasMeasuredUsage: false, traffic: null});
  await page.goto('/settings');
  await expect(page.getByText('수집 기록이 없습니다.')).toBeVisible();
});
