import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { once } from "node:events";

async function start() { const child=spawn(process.execPath,["scripts/serve.mjs"],{stdio:["ignore","pipe","inherit"]}); const [chunk]=await once(child.stdout,"data"); return {child,base:`http://127.0.0.1:${String(chunk).match(/port=(\d+)/)[1]}`}; }
test("Selected pages load at desktop and mobile without overflow or foreign requests", { timeout:120000 }, async () => {
  const {child,base}=await start(); const browser=await chromium.launch({headless:true});
  try {
    for (const viewport of [{width:1280,height:800},{width:390,height:844}]) for (const path of ["/","/tools/merge-pdf/","/tools/ocr-pdf/","/tools/redaction-verifier/","/workspace/"]) {
      const page=await browser.newPage({viewport}); const errors=[]; const foreign=[];
      page.on("pageerror",e=>errors.push(e.message)); page.on("request",r=>{if(!r.url().startsWith(base)&&!r.url().startsWith("data:")&&!r.url().startsWith("blob:")) foreign.push(r.url());});
      const response=await page.goto(base+path,{waitUntil:"domcontentloaded"}); assert.equal(response.status(),200,path);
      await page.waitForTimeout(250);
      const geom=await page.evaluate(()=>({sw:document.documentElement.scrollWidth,cw:document.documentElement.clientWidth}));
      assert.ok(geom.sw<=geom.cw+1,`${path} overflow ${geom.sw}/${geom.cw}`); assert.deepEqual(errors,[],`${path} page errors`); assert.deepEqual(foreign,[],`${path} foreign requests`); await page.close();
    }
  } finally { await browser.close(); child.kill("SIGTERM"); }
});
