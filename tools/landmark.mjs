// 以無頭 Chromium 匯出地標 GLB／產生預覽圖。
//   node tools/landmark.mjs export <id> <out.glb>
//   node tools/landmark.mjs preview <id> <views.json> <outDir>
import { chromium } from 'playwright';
import { createServer } from 'vite';
import fs from 'node:fs';
import path from 'node:path';

const [cmd, id, a, b] = process.argv.slice(2);
const server = await createServer({ server: { port: 5199, strictPort: false }, logLevel: 'error' });
await server.listen();
const url = server.resolvedUrls.local[0] + 'tools/landmark.html?id=' + id;
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage();
page.on('console', (m) => m.type() === 'error' && console.error('[page]', m.text()));
page.on('pageerror', (e) => console.error('[page]', e.message));
await page.goto(url);
await page.waitForFunction(() => window.ready, null, { timeout: 180000 });
console.log(JSON.stringify(await page.evaluate(() => window.stats())));
if (cmd === 'export') {
  const b64 = await page.evaluate(() => window.exportGlb());
  fs.writeFileSync(a, Buffer.from(b64, 'base64'));
  console.log('wrote', a, fs.statSync(a).size, 'bytes');
} else if (cmd === 'preview') {
  const views = JSON.parse(fs.readFileSync(a, 'utf8'));
  fs.mkdirSync(b, { recursive: true });
  const shots = await page.evaluate((v) => window.render(v), views);
  shots.forEach((s, i) => fs.writeFileSync(path.join(b, `${views[i].name ?? i}.png`), Buffer.from(s.split(',')[1], 'base64')));
  console.log('wrote', shots.length, 'previews to', b);
}
await browser.close();
await server.close();
