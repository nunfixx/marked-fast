import * as fs from 'node:fs';
import * as path from 'node:path';
import { parse } from './parse.js';

const inDir = process.env.MAKEFUN_INPUT_DIR || '/input';
const outDir = process.env.MAKEFUN_OUTPUT_DIR || '/output';
const raw = fs.readFileSync(path.join(inDir, 'cases.json'), 'utf8');
const list = JSON.parse(raw);
const out: string[] = new Array(list.length);
for (let k = 0; k < list.length; k++) {
  out[k] = parse(list[k].markdown);
}
fs.writeFileSync(path.join(outDir, 'html.json'), JSON.stringify(out));
