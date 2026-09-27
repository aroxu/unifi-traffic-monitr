import {test, expect} from '@playwright/test';

test('shows verified overview usage and top clients on desktop and mobile', async ({page}) => {
  test.skip(process.env.E2E_EXPECT_OVERVIEW_TRAFFIC !== '1', 'Requires a DB with recent measured rollups');
  const email = process.env.E2E_OVERVIEW_ADMIN_EMAIL ?? process.env.E2E_ADMIN_EMAIL;
  const password = process.env.E2E_OVERVIEW_ADMIN_PASSWORD ?? process.env.E2E_ADMIN_PASSWORD;
  if (!email || !password) throw new Error('Admin credentials are required');
  if (!process.env.E2E_AUTH_STATE) {
    await page.goto('/login');
    await page.getByLabel('이메일').fill(email);
    await page.getByLabel('비밀번호').fill(password);
    await page.getByRole('button', {name: '로그인'}).click();
  } else await page.goto('/');
  await expect(page.getByRole('heading', {name: '개요'})).toBeVisible();
  await expect(page.getByText('최근 24시간 인터넷 트래픽')).toBeVisible();
  await expect(page.getByRole('img', {name: '검증된 다운로드와 업로드의 시간별 평균 속도 그래프'})).toBeVisible();
  await expect(page.getByRole('heading', {name: '상위 클라이언트'})).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
