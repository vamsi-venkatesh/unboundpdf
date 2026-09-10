# Architecture

UnboundPDF is a static browser application. A tool page loads its interface and processing libraries from the same origin. The selected public edition contains no API endpoint that accepts a document.

```text
User-selected PDF
      │
      ▼
Browser File API
      │
      ├── Merge PDF ─────────── pdf-lib ──────────► output PDF
      ├── OCR PDF ───────────── pdf.js + Tesseract/WASM ─► searchable PDF
      └── Redaction Verifier ── PDF operator inspection ─► local report
      │
      ▼
Blob URL / browser download
```

The tool runtime reads bytes with the File API and returns output through browser-generated Blob URLs. OCR workers and language data are loaded from `/tools/assets/tesseract/` on the same origin.

The public Workspace is intentionally smaller than production. It accepts multiple PDFs, merges them in the selected order, reopens the produced document to count pages, computes SHA-256 with Web Crypto and renders that measurement as a receipt.

Production deployment, content generation, analytics, review services and the remaining tool engines are outside this repository.
