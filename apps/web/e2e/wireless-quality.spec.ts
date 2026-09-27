import {test, expect} from '@playwright/test';

const email = process.env.E2E_ADMIN_EMAIL;
const password = process.env.E2E_ADMIN_PASSWORD;
if (!email || !password) throw new Error('Set E2E_ADMIN_EMAIL and E2E_ADMIN_PASSWORD');

test('shows stored wireless signal and noise for a connected client', async ({page}) => {
  await page.goto('/login');
  await page.getByLabel('이메일').fill(email);
  await page.getByLabel('비밀번호').fill(password);
  await page.getByRole('button', {name: '로그인'}).click();
  await expect(page.getByRole('heading', {name: '개요'})).toBeVisible();

  const list = await page.request.get('/api/clients?connection=wireless&limit=100');
  expect(list.status()).toBe(200);
  const {rows} = await list.json() as {rows: {id: string; online: boolean | null}[]};
  let selected: {id: string; wirelessSignalDbm: number; wirelessNoiseDbm: number} | null = null;
  for (const row of rows.filter(item => item.online)) {
    const detail = await page.request.get(`/api/clients/${row.id}`);
    if (!detail.ok()) continue;
    const client = await detail.json();
    if (typeof client.wirelessSignalDbm === 'number' && typeof client.wirelessNoiseDbm === 'number') {
      selected = {id: row.id, wirelessSignalDbm: client.wirelessSignalDbm, wirelessNoiseDbm: client.wirelessNoiseDbm};
      break;
    }
  }
  expect(selected).not.toBeNull();
  await page.goto(`/clients/${selected!.id}`);
  await expect(page.getByText('무선 신호')).toBeVisible();
  await expect(page.getByText(`${selected!.wirelessSignalDbm} dBm`)).toBeVisible();
  await expect(page.getByText(`${selected!.wirelessNoiseDbm} dBm`)).toBeVisible();
  await expect(page.getByText('마지막 수집값이며 실시간 신호가 아닙니다.')).toBeVisible();
});
