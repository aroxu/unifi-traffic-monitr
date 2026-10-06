import {test, expect} from '@playwright/test';

test('shows stored wireless signal and noise for a connected client', async ({page}) => {
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
  test.skip(!selected, 'No connected wireless client with signal readings');
  await page.goto(`/clients/${selected!.id}`);
  await expect(page.getByText('무선 신호')).toBeVisible();
  await expect(page.getByText(`${selected!.wirelessSignalDbm} dBm`)).toBeVisible();
  await expect(page.getByText(`${selected!.wirelessNoiseDbm} dBm`)).toBeVisible();
  await expect(page.getByText('마지막 수집값이며 실시간 신호가 아닙니다.')).toBeVisible();
});
