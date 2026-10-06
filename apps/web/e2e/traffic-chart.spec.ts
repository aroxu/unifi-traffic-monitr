import {test, expect} from '@playwright/test';

const clientId = process.env.E2E_CHART_CLIENT_ID;

test('draws measured traffic and keeps the scroll position when the period changes', async ({page}) => {
  test.skip(!clientId, 'Set E2E_CHART_CLIENT_ID to a client with measured traffic');
  await page.goto(`/clients/${clientId}`);
  const chart = page.getByRole('img', {name: '다운로드와 업로드의 시간별 평균 속도 그래프'});
  await expect(chart).toBeVisible();
  await expect(chart.locator('.recharts-line-curve').first()).toBeVisible();

  await chart.scrollIntoViewIfNeeded();
  const before = await page.evaluate(() => window.scrollY);
  await page.getByRole('button', {name: /트래픽 기간/}).click();
  await page.getByRole('option', {name: '7일'}).click();
  await expect(page).toHaveURL(/period=7d/);
  await expect(chart.locator('.recharts-line-curve').first()).toBeVisible();
  expect(Math.abs(await page.evaluate(() => window.scrollY) - before)).toBeLessThan(200);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
