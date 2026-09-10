# Privacy model

The selected tools process document bytes inside the browser. The repository has no document-upload server and the tool code does not send selected files to an external service.

OCR downloads its runtime and English language model from the same application origin. These files are program code and model data; the user's document is not part of those requests.

The practical verification method is to run a tool with the browser Network panel open and confirm that no request body contains the selected document. The automated suite also rejects cross-origin URLs in the selected runtime.

This boundary does not protect against a compromised browser, malicious extension, infected device or an independently modified copy of the repository.
