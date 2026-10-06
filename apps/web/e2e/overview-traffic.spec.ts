import {test, expect} from '@playwright/test';

test('shows measured overview usage and top clients', async ({page}) => {
  test.skip(process.env.E2E_EXPECT_OVERVIEW_TRAFFIC !== '1', 'Requires a DB with recent measured rollups');
  await page.goto('/');
  await expect(page.getByRole('heading', {name: '네트워크 한눈에 보기'})).toBeVisible();
  await expect(page.getByText(/^최근 24시간 .+ 트래픽$/)).toBeVisible();
  await expect(page.getByRole('img', {name: '다운로드와 업로드의 시간별 평균 속도 그래프'})).toBeVisible();
  await expect(page.getByRole('heading', {name: '상위 클라이언트'})).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
