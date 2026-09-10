# Security

## Report a problem

Email `hello@unboundpdf.com`. Do not attach a sensitive document. Provide a synthetic reproduction or describe the PDF structure involved.

## Document boundary

- Tool pages have no document-upload endpoint.
- OCR runtime assets are same-origin.
- Findings from Redaction Verifier are masked by default in its report interface.
- The public tests use generated or deliberately planted fixtures.

## Public-repository boundary

The publication audit rejects credentials, environment files, private host addresses, local user paths, deployment material, SEO research and files outside the allowlist. The repository was created with fresh history rather than importing the mixed private working tree.
