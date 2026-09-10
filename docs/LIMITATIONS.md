# Limitations

## Merge PDF

- Document-level outlines may not survive a merge.
- Encrypted inputs must be opened before processing.
- Very large documents remain limited by the browser and available memory.

## OCR PDF

- This public edition includes English language data.
- Recognition accuracy depends on scan resolution, contrast, skew, typeface and layout.
- Handwriting is not a supported target.
- The invisible text layer is recognition output and must be checked before critical use.

## Redaction Verifier

- A result with no findings is not proof that a redaction occurred.
- The verifier cannot see content that was successfully removed.
- Vector outlines, Type 3 fonts and some Form XObject content may not be readable as text.
- A filled table cell can resemble a visual cover and requires human judgment.

## Workspace proof demo

- It demonstrates only merging and receipt generation.
- It does not contain the complete production Workspace, recipes, handoffs or history model.
