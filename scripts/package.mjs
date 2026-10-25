import {execFileSync} from 'node:child_process';
import {mkdir,readFile} from 'node:fs/promises';
import path from 'node:path';
await mkdir('artifacts',{recursive:true});
const manifest=JSON.parse(await readFile('dist/manifest.json','utf8'));
const output=path.resolve(`artifacts/inbox-code-${manifest.version}${manifest.oauth2?'':'-development'}.zip`);
execFileSync('zip',['-qr',output,'.'],{cwd:'dist'});
console.log(output);
