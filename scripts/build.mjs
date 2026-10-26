import { build } from 'esbuild';
import { readFile, writeFile, mkdir, copyFile, rm, cp } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const defaultKey = JSON.parse(await readFile(new URL('../extension-key.json', import.meta.url))).key;
let config = JSON.parse(await readFile(new URL('../oauth-client.json', import.meta.url)));
try { config = { ...config, ...JSON.parse(await readFile('config.local.json', 'utf8')) }; } catch (error) { if (error.code !== 'ENOENT') throw error; }
const key = config.extensionKey || defaultKey;
const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID || config.clientId;
config.clientId = clientId;
config.webClientId = process.env.GOOGLE_WEB_CLIENT_ID || config.webClientId;
if (config.webClientId && !/^\d+-[a-z0-9]+\.apps\.googleusercontent\.com$/.test(config.webClientId)) throw new Error('Invalid web OAuth client ID');
if (clientId && !/^\d+-[a-z0-9]+\.apps\.googleusercontent\.com$/.test(clientId)) throw new Error('Invalid Google OAuth client ID');
if (process.argv.includes('--release') && (!clientId || !config.webClientId)) throw new Error('Release requires a Google OAuth client ID; see docs/SETUP.md');
await rm('dist', { recursive: true, force: true }); await mkdir('dist', { recursive: true });
await build({ entryPoints: ['src/background.js','src/content.js','src/popup.js'], outdir: 'dist', bundle: true, format: 'iife', target: 'chrome120', minify: false, legalComments: 'eof', plugins: [{ name: 'oauth-config', setup(b) { b.onLoad({ filter: /oauth-client\.json$/ }, () => ({ contents: JSON.stringify({ clientId: config.clientId, webClientId: config.webClientId }), loader: 'json' })); } }] });
await cp('src/icons','dist/icons',{recursive:true});
for (const name of ['popup.html','popup.css','setup.html','setup.js']) await copyFile(`src/${name}`, `dist/${name}`);
const manifest = {
  manifest_version: 3, name: 'Inbox Code', version: '0.2.1', minimum_chrome_version: '120',
  description: 'Gmail verification codes beside your login field. Local processing, sender matching, and click-to-fill.',
  icons: { 16:'icons/16.png',32:'icons/32.png',48:'icons/48.png',128:'icons/128.png' },
  key, permissions: ['identity','storage','activeTab','scripting'],
  host_permissions: ['https://*/*', 'https://gmail.googleapis.com/*', 'https://oauth2.googleapis.com/*'],
  action: { default_popup: 'popup.html', default_title: 'Inbox Code' },
  background: { service_worker: 'background.js' },
  content_security_policy: { extension_pages: "script-src 'self'; object-src 'none'; connect-src https://gmail.googleapis.com https://oauth2.googleapis.com" },
  ...(clientId ? { oauth2: { client_id: clientId, scopes: ['https://www.googleapis.com/auth/gmail.readonly'] } } : {}),
};
await writeFile('dist/manifest.json', JSON.stringify(manifest, null, 2) + '\n');
const id = createHash('sha256').update(Buffer.from(key, 'base64')).digest('hex').slice(0,32).replace(/[0-9a-f]/g, c => String.fromCharCode(97 + parseInt(c,16)));
console.log(`Built dist/ — extension ID ${id} — ${clientId ? 'Google OAuth configured' : 'Google OAuth not configured (development only)'}`);
