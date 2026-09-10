import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";

async function start() { const child=spawn(process.execPath,["scripts/serve.mjs"],{stdio:["ignore","pipe","inherit"]}); const [chunk]=await once(child.stdout,"data"); return {child,base:`http://127.0.0.1:${String(chunk).match(/port=(\d+)/)[1]}`}; }
test("English OCR runs from same-origin assets", { timeout:300000 }, async () => {
  const {child,base}=await start(); const browser=await chromium.launch({headless:true});
  try {
    const page=await browser.newPage({viewport:{width:1280,height:900}}); const foreign=[]; const errors=[];
    page.on("request",r=>{if(!r.url().startsWith(base)&&!r.url().startsWith("data:")&&!r.url().startsWith("blob:")) foreign.push(r.url());});
    page.on("pageerror",e=>errors.push(e.message));
    await page.goto(base+"/tools/ocr-pdf/",{waitUntil:"domcontentloaded"});
    await page.locator('#toolUI input[type="file"]').first().setInputFiles(join(process.cwd(),"tests/fixtures/ocr/darkfig-scan.pdf"));
    await page.locator("#toolUI button.btn",{hasText:/Run OCR/i}).first().click();
    await page.waitForFunction(()=>!!window.__wbResult,null,{timeout:240000,polling:300});
    const text=await page.evaluate(()=>window.__ocrPrepText||"");
    assert.ok(text.length>40,`recognized ${text.length} characters`); assert.deepEqual(foreign,[]); assert.deepEqual(errors,[]);
  } finally { await browser.close(); child.kill("SIGTERM"); }
});
