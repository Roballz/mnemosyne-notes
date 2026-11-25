# Marked

`marked.js` is the browser ES module from **Marked 17.0.5**, distributed under the MIT license. Source: <https://github.com/markedjs/marked/tree/v17.0.5>. The accompanying `marked-LICENSE.md` retains its license and attribution.

The module is vendored because TauriTavern installs this extension directly without a bundler or runtime package installation. It is imported only by the lazily loaded workbench. No CDN, remote scripts or new runtime service is used.

`../markdown.js` uses a private parser instance, displays raw HTML literally and rebuilds allowed elements without model-supplied attributes. It does not use the story's regex/macro formatter or load message images. Source maps are not shipped.
