import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { createHash } from "node:crypto";

const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const forbiddenTop = new Set(["engine","research","_qa","data","analytics","blueprints","prompts","services",".claude","node_modules","shots","deploy"]);
const forbiddenFile = /(^|\/)(\.env(?:\.|$)|client_secret|credentials?|id_rsa|[^/]+\.(?:pem|key))/i;
const forbiddenText = [
  [/\/Users\/vamsiv/i, "local user path"],
  [/169\.58\.51\.87|185\.194\.219\.18/, "private host address"],
  [/\/opt\/vvdex|vvdex-products/i, "production path or host"],
  [/ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9]{20,}|AIza[A-Za-z0-9_-]{20,}/, "credential-shaped token"],
  [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, "private key"]
];
const textExt = /\.(?:md|html|js|json|css|txt|yml|yaml|webmanifest)$/i;
const files = [];
async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes:true })) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const path = join(dir, entry.name); const rel = relative(root, path);
    if (rel.split("/").length === 1 && forbiddenTop.has(entry.name)) throw new Error(`forbidden top-level path: ${rel}`);
    if (forbiddenFile.test(rel)) throw new Error(`forbidden sensitive filename: ${rel}`);
    if (entry.isDirectory()) await walk(path); else files.push({ path, rel });
  }
}
await walk(root);
for (const file of files) {
  const info = await stat(file.path);
  if (textExt.test(file.rel) && info.size < 5_000_000) {
    const body = await readFile(file.path, "utf8");
    for (const [pattern, label] of forbiddenText) if (pattern.test(body)) throw new Error(`${label} in ${file.rel}`);
  }
}
const selected = ["tools/merge-pdf/index.html","tools/ocr-pdf/index.html","tools/redaction-verifier/index.html","workspace/index.html"];
for (const rel of selected) if (!files.some(f => f.rel === rel)) throw new Error(`missing selected surface: ${rel}`);

const thirdParty = JSON.parse(await readFile(join(root, "docs/third-party-manifest.json"), "utf8"));
const pdfLib = thirdParty.entries.find(entry => entry.id === "pdf-lib");
if (!pdfLib || pdfLib.name !== "@cantoo/pdf-lib" || pdfLib.version !== "2.5.3") {
  throw new Error("@cantoo/pdf-lib 2.5.3 provenance is missing from the third-party manifest");
}
const pdfLibBytes = await readFile(join(root, "tools/assets/pdf-lib.min.js"));
const commentEnd = pdfLibBytes.indexOf(Buffer.from("*/\n"));
if (commentEnd < 0) throw new Error("pdf-lib attribution header is missing");
const payloadHash = createHash("sha256").update(pdfLibBytes.subarray(commentEnd + 3)).digest("hex");
if (payloadHash !== pdfLib.upstreamDistSha256) throw new Error(`pdf-lib payload hash drift: ${payloadHash}`);
const bundledNames = new Set((pdfLib.bundledDependencies || []).map(dep => dep.name));
for (const required of ["@pdf-lib/standard-fonts", "@pdf-lib/upng", "crypto-js", "pako", "tslib"]) {
  if (!bundledNames.has(required)) throw new Error(`missing bundled pdf-lib dependency: ${required}`);
}
for (const absent of ["@pdf-lib/fontkit", "fontkit", "fflate"]) {
  if (bundledNames.has(absent)) throw new Error(`incorrect embedded pdf-lib dependency: ${absent}`);
}
console.log(`PUBLIC AUDIT PASS — ${files.length} files, declared boundary present, no forbidden path or text pattern`);
