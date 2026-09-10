import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join } from "node:path";
const require = createRequire(import.meta.url);
globalThis.PDFLib = require("../tools/assets/pdf-lib.min.js");
globalThis.PDFTextOps = require("../tools/assets/pdf-textops.js");
require("../tools/assets/pdf-textedit.js");
const Audit = require("../tools/assets/redaction-audit.js");
const load = n => readFileSync(join(process.cwd(), "tests/fixtures/redaction", n));

test("Redaction Verifier finds real covers and stays silent on controls", async () => {
  const black = await Audit.auditDocument(load("fake-blackbox.pdf"));
  assert.equal(black.verdict, "text-found");
  assert.equal(black.findings[0].kind, "text-under-cover");
  const invisible = await Audit.auditDocument(load("invisible-text.pdf"));
  assert.ok(invisible.findings.some(f => f.kind === "invisible-text"));
  const hidden = await Audit.auditDocument(load("hidden-layer.pdf"));
  assert.ok(hidden.findings.some(f => f.kind === "hidden-layer-text"));
  for (const name of ["control-background.pdf","control-ghost.pdf","control-plain.pdf"]) {
    const report = await Audit.auditDocument(load(name)); assert.equal(report.findings.length, 0, name);
  }
  assert.ok(black.limitations.some(x => /cannot see what was removed/i.test(x)));
});
