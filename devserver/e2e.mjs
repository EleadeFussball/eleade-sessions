import { chromium } from 'playwright';
const out = '/var/tmp/shots';
import fs from 'node:fs'; fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const errors = [];
async function asUser(label) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error' && !/fonts\.g/.test(m.text())) errors.push(label + ': ' + m.text()); });
  page.on('pageerror', (e) => errors.push(label + ' pageerror: ' + e.message));
  await page.goto('http://localhost:3000/login');
  await page.getByRole('button', { name: label, exact: true }).click();
  await page.waitForURL('**/log');
  await page.getByRole('heading', { name: 'Log a session' }).waitFor();
  return { ctx, page };
}
const res = {};
// ---- Tyler logs a session for Angus Hamilton ----
{
  const { page, ctx } = await asUser('tyler');
  await page.screenshot({ path: `${out}/1-log-empty.png`, fullPage: true });
  await page.getByLabel('Search players').fill('angus');
  await page.locator('.results button', { hasText: 'Angus Hamilton' }).click();
  await page.getByPlaceholder('e.g. Moore Park').fill('Moore Park');
  await page.getByPlaceholder('Warm-up, topic 1, topic 2').fill('Ball mastery, first touch in 4 directions');
  await page.getByPlaceholder('Observations and feedback').fill('Much sharper scanning today');
  await page.screenshot({ path: `${out}/2-log-filled.png`, fullPage: true });
  await page.getByRole('button', { name: 'Log session', exact: true }).click();
  await page.getByRole('status').waitFor();
  res.confirm = await page.getByRole('status').innerText();
  await page.screenshot({ path: `${out}/3-log-saved.png`, fullPage: true });
  // 2:1 group
  await page.getByRole('button', { name: '2:1 group' }).click();
  await page.getByLabel('Search players').fill('mickey');
  await page.locator('.results button', { hasText: 'Mickey Rodov' }).click();
  await page.getByLabel('Search players').fill('rafi');
  await page.locator('.results button', { hasText: 'Rafi Rodov' }).click();
  await page.getByRole('button', { name: 'Log session', exact: true }).click();
  await page.getByRole('status').waitFor();
  res.group = await page.getByRole('status').innerText();
  // players
  await page.getByRole('navigation').getByRole('link', { name: 'Players' }).click();
  await page.getByRole('heading', { name: 'Players' }).waitFor();
  await page.locator('.plink').first().waitFor();
  res.playerCount = await page.locator('.plink').count();
  await page.screenshot({ path: `${out}/4-players.png`, fullPage: false });
  await page.getByLabel('Search players').fill('angus');
  await page.locator('.plink', { hasText: 'Angus Hamilton' }).click();
  await page.locator('.scoreboard').waitFor();
  res.angusLeft = await page.locator('.scoreboard .big').first().innerText();
  await page.screenshot({ path: `${out}/5-profile.png`, fullPage: true });
  res.tylerSeesAdmin = await page.getByRole('heading', { name: 'Admin' }).count();
  // week
  await page.getByRole('navigation').getByRole('link', { name: 'My week' }).click();
  await page.locator('.total').waitFor();
  res.weekTotal = await page.locator('.total .score').innerText();
  await page.screenshot({ path: `${out}/6-week.png`, fullPage: true });
  res.tylerTabs = await page.locator('.tab').allInnerTexts();
  await ctx.close();
}
// ---- Jan: Monday, team, add credits ----
{
  const { page, ctx } = await asUser('info');
  res.janTabs = await page.locator('.tab').allInnerTexts();
  await page.getByRole('navigation').getByRole('link', { name: 'Monday' }).click();
  await page.getByRole('heading', { name: 'Monday check' }).waitFor();
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${out}/7-monday.png`, fullPage: true });
  res.mondayHeads = await page.locator('h2').allInnerTexts();
  await page.getByRole('navigation').getByRole('link', { name: 'Team' }).click();
  await page.locator('.session').first().waitFor();
  await page.screenshot({ path: `${out}/8-team.png`, fullPage: true });
  await page.getByRole('navigation').getByRole('link', { name: 'Players' }).click();
  await page.getByLabel('Search players').fill('angus');
  await page.locator('.plink', { hasText: 'Angus Hamilton' }).click();
  await page.getByText('Add or correct credits').click();
  await page.getByRole('button', { name: '5 pack' }).click();
  await page.getByRole('button', { name: 'Save credits' }).click();
  await page.getByText('Credits saved.').waitFor();
  await page.waitForTimeout(500);
  res.angusAfterPack = await page.locator('.scoreboard .big').first().innerText();
  await page.screenshot({ path: `${out}/9-profile-admin.png`, fullPage: true });
  await ctx.close();
}
await browser.close();
console.log(JSON.stringify(res, null, 1));
console.log('ERRORS', errors);
