// Dump doc page HTML to plain text for keyword inspection
import { readFileSync, writeFileSync } from "node:fs";
const html = readFileSync(process.argv[2], "utf8");
const text = html
  .replace(/<script[\s\S]*?<\/script>/g, "")
  .replace(/<style[\s\S]*?<\/style>/g, "")
  .replace(/<[^>]+>/g, " ")
  .replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"')
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  .replace(/[ \t]+/g, " ");
writeFileSync(process.argv[3], text);
console.log("wrote", process.argv[3], text.length, "chars");
