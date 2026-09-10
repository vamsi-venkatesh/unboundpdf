import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";

async function start() {
  const child = spawn(process.execPath, ["scripts/serve.mjs"], { stdio:["ignore","pipe","inherit"] });
  const [chunk] = await once(child.stdout, "data");
  return { child, base:`http://127.0.0.1:${String(chunk).match(/port=(\d+)/)[1]}` };
}

test("Workspace merges two PDFs and measures the real output", { timeout:120000 }, async () => {
  const { child, base } = await start(); const browser = await chromium.launch({ headless:true });
  try {
    const page = await browser.newPage({ viewport:{ width:1280, height:800 } });
    const foreign = []; const errors = [];
    page.on("request", req => { if (!req.url().startsWith(base) && !req.url().startsWith("blob:") && !req.url().startsWith("data:")) foreign.push(req.url()); });
    page.on("pageerror", err => errors.push(err.message));
    await page.goto(base + "/workspace/", { waitUntil:"domcontentloaded" });
    await page.locator("#files").setInputFiles([join(process.cwd(),"tests/fixtures/merge/a-3p.pdf"),join(process.cwd(),"tests/fixtures/merge/b-2p.pdf")]);
    await page.locator("#run").click();
    await page.waitForFunction(() => window.__publicWorkspaceReceipt?.pages === 5);
    const receipt = await page.evaluate(() => window.__publicWorkspaceReceipt);
    assert.equal(receipt.inputs, 2); assert.equal(receipt.pages, 5); assert.ok(receipt.bytes > 1000); assert.match(receipt.sha256, /^[a-f0-9]{64}$/);
    assert.equal(foreign.length, 0); assert.equal(errors.length, 0);
  } finally { await browser.close(); child.kill("SIGTERM"); }
});
