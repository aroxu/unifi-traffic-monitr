import {test, expect} from '@playwright/test';

const email = process.env.E2E_CHART_ADMIN_EMAIL ?? process.env.E2E_ADMIN_EMAIL;
const password = process.env.E2E_CHART_ADMIN_PASSWORD ?? process.env.E2E_ADMIN_PASSWORD;
const clientId = process.env.E2E_CHART_CLIENT_ID;

test('shows measured sparse traffic and preserves the period selection', async ({page}) => {
  test.skip(!email || !password || !clientId, 'Requires a restored DB with measured intervals');
  if (!process.env.E2E_AUTH_STATE) {
    await page.goto('/login');
    await page.getByLabel('이메일').fill(email!);
    await page.getByLabel('비밀번호').fill(password!);
    await page.getByRole('button', {name: '로그인'}).click();
  } else await page.goto('/');
  await expect(page.getByRole('heading', {name: '개요'})).toBeVisible();

  await page.goto(`/clients/${clientId}`);
  const chart = page.getByRole('img', {name: '검증된 다운로드와 업로드의 시간별 평균 속도 그래프'});
  await expect(chart).toBeVisible();
  await expect(chart.locator('.recharts-dot').first()).toBeVisible();
  await expect(page.getByText('0.000 GB')).toHaveCount(0);
  await page.getByRole('link', {name: '7d'}).click();
  await expect(page).toHaveURL(/period=7d/);
  await expect(chart).toBeVisible();
  await expect(chart.locator('.recharts-dot').first()).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
