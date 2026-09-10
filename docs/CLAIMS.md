# Claims and evidence

| Claim | Evidence in this repository | Boundary |
| --- | --- | --- |
| Selected files are processed in the browser | Static tool code and browser tests | Does not cover modified forks or compromised clients |
| OCR runtime assets are same-origin | Source paths plus publication audit | Public edition includes English data |
| Workspace receipts describe produced bytes | Test recomputes SHA-256 and page count | Public demo covers merge only |
| Redaction Verifier detects planted live text under covers | Positive and negative synthetic fixtures | No-findings is not a safety guarantee |
| Private operating material is absent | Allowlist and forbidden-pattern audit | Applies to the published commit |

The complete production product is available at <https://unboundpdf.com/>. This repository does not imply that every production tool is open source or included here.
