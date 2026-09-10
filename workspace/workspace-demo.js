"use strict";
(function () {
  const input = document.getElementById("files");
  const list = document.getElementById("list");
  const run = document.getElementById("run");
  const result = document.getElementById("result");
  let files = [];

  function fmt(n) { return new Intl.NumberFormat().format(n) + " bytes"; }
  function render() {
    list.replaceChildren();
    files.forEach((file, i) => {
      const row = document.createElement("div"); row.className = "file";
      const name = document.createElement("span"); name.textContent = (i + 1) + ". " + file.name;
      const size = document.createElement("span"); size.textContent = fmt(file.size);
      row.append(name, size); list.append(row);
    });
    run.disabled = files.length < 2;
  }
  input.addEventListener("change", () => { files = Array.from(input.files || []); result.replaceChildren(); render(); });

  async function sha256(bytes) {
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
  }

  run.addEventListener("click", async () => {
    run.disabled = true; run.textContent = "Measuring…"; result.replaceChildren();
    try {
      const out = await PDFLib.PDFDocument.create();
      out.setCreationDate(new Date(0)); out.setModificationDate(new Date(0));
      for (const file of files) {
        const src = await PDFLib.PDFDocument.load(await file.arrayBuffer(), { updateMetadata: false });
        const pages = await out.copyPages(src, src.getPageIndices()); pages.forEach(page => out.addPage(page));
      }
      const bytes = await out.save({ useObjectStreams: false });
      const reopened = await PDFLib.PDFDocument.load(bytes, { updateMetadata: false });
      const digest = await sha256(bytes);
      const blob = new Blob([bytes], { type: "application/pdf" });
      const url = URL.createObjectURL(blob);
      const box = document.createElement("section"); box.className = "receipt";
      const title = document.createElement("h2"); title.textContent = "Measured receipt";
      const summary = document.createElement("p"); summary.textContent = `${files.length} inputs · ${reopened.getPageCount()} output pages · ${fmt(bytes.length)}`;
      const hash = document.createElement("p"); hash.append("SHA-256 "); const code = document.createElement("code"); code.textContent = digest; hash.append(code);
      const link = document.createElement("a"); link.href = url; link.download = "unboundpdf-public-merged.pdf"; link.textContent = "Download measured output →";
      box.append(title, summary, hash, link); result.append(box);
      window.__publicWorkspaceReceipt = { inputs: files.length, pages: reopened.getPageCount(), bytes: bytes.length, sha256: digest };
    } catch (error) {
      const p = document.createElement("p"); p.className = "error"; p.textContent = "Could not merge these files: " + error.message; result.append(p);
    } finally { run.disabled = files.length < 2; run.textContent = "Merge and issue receipt"; }
  });
  window.__publicWorkspaceFiles = () => files.length;
})();
