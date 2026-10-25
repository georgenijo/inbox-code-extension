import { cp, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
const base = process.platform === 'darwin' ? path.join(homedir(),'Library','Application Support') : process.env.XDG_DATA_HOME || path.join(homedir(),'.local','share');
const target=path.join(base,'Inbox Code','extension');
await mkdir(target,{recursive:true});
await cp('dist',target,{recursive:true});
console.log(`Load unpacked from: ${target}`);
