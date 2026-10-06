import {test as setup, expect} from '@playwright/test';
import {authFile} from '../playwright.config';

setup('sign in as the admin', async ({page}) => {
  const email = process.env.E2E_ADMIN_EMAIL;
  const password = process.env.E2E_ADMIN_PASSWORD;
  if (!email || !password) throw new Error('Set E2E_ADMIN_EMAIL and E2E_ADMIN_PASSWORD');
  await page.goto('/');
  await expect(page).toHaveURL(/\/login$/);
  await page.getByLabel('이메일').fill(email);
  await page.getByLabel('비밀번호').fill(password);
  await page.getByRole('button', {name: '로그인'}).click();
  await expect(page.getByRole('heading', {name: '네트워크 한눈에 보기'})).toBeVisible();
  await page.context().storageState({path: authFile});
});
