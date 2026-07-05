// Strip shiki HTML to plain code: each code line is a <span class="line">...</span>
import { readFileSync, writeFileSync } from 'node:fs';

const file = process.argv[2];
const out = process.argv[3];
const html = readFileSync(file, 'utf8');

const decode = (s) =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
   .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#x27;/g, "'");

const blocks = [];
// grab each <pre ...>...</pre> block
for (const m of html.matchAll(/<pre[^>]*>([\s\S]*?)<\/pre>/g)) {
  const lines = [...m[1].matchAll(/<span class="line">([\s\S]*?)<\/span>(?=\s*<span class="line">|\s*$|<\/code>)/g)]
    .map((lm) => decode(lm[1].replace(/<[^>]+>/g, '')));
  blocks.push(lines.join('\n'));
}
writeFileSync(out, blocks.map((b, i) => `// ===== BLOCK ${i} =====\n${b}\n`).join('\n'));
console.log(`${blocks.length} code blocks -> ${out}`);
