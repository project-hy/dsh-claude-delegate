// Extract long string literals from compiled DSH JS bundles.
// Usage: node extract-string-literals.mjs <file.js> [minLen] [--all]
import fs from "node:fs";
import path from "node:path";

const file = process.argv[2];
const minLen = Number(process.argv[3] || 200);
const showAll = process.argv.includes("--all");
if (!file) {
  console.error("usage: node extract-string-literals.mjs <file.js> [minLen] [--all]");
  process.exit(2);
}

let src = fs.readFileSync(file, "utf8");

const out = [];
let i = 0;
const n = src.length;
while (i < n) {
  const c = src[i];
  if (c === '"' || c === "'" || c === "`") {
    const quote = c;
    let j = i + 1;
    let raw = "";
    while (j < n) {
      const d = src[j];
      if (d === "\\") {
        raw += src[j] + src[j + 1];
        j += 2;
        continue;
      }
      if (d === quote) break;
      if (d === "\n" && quote !== "`") break;
      raw += d;
      j += 1;
    }
    if (j < n && src[j] === quote) {
      // decode
      let val;
      try {
        if (quote === "`") {
          // avoid evaluating interpolations; just unescape simple seqs
          val = raw
            .replace(/\\n/g, "\n")
            .replace(/\\t/g, "\t")
            .replace(/\\`/g, "`")
            .replace(/\\\$/g, "$")
            .replace(/\\\\/g, "\\");
        } else {
          val = JSON.parse(quote + raw + quote);
        }
      } catch {
        val = raw;
      }
      const looksLikeText =
        /[a-zA-Z]{3,}/.test(val) &&
        (/[\s]/.test(val) || val.length > 40) &&
        !/^[A-Za-z0-9_$.\-/]{0,30}$/.test(val);
      const hasSentence = /[a-z][ ][a-z]/i.test(val) || /[.:;!?]\s/.test(val) || val.includes("\n");
      if (val.length >= minLen && looksLikeText && (showAll || hasSentence)) {
        out.push({ line: src.slice(0, i).split("\n").length, len: val.length, val });
      }
      i = j + 1;
      continue;
    }
  }
  i += 1;
}

const base = path.basename(file);
console.log(`### ${base} — ${out.length} literals >= ${minLen} chars\n`);
out.forEach((o, k) => {
  console.log(`----- [${k + 1}] line ${o.line} len ${o.len} -----`);
  console.log(o.val);
  console.log("");
});
