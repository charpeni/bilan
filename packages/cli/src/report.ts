import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { serializePayload } from '@bilan/core';

import type { Payload } from '@bilan/core';

/** Self-contained HTML: styles and the dashboard bundle inlined, payload embedded. */
export function renderReport(payload: Payload, assets = loadAssets()): string {
  const title = `${payload.repo} · bilan`;
  return `<!doctype html>
<html lang="en" data-theme="auto">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
${assets.css}
</style>
</head>
<body>
<div id="bilan"></div>
<script id="payload" type="application/json">${serializePayload(payload)}</script>
<script>
${assets.js}
</script>
<script>
BilanUI.mount(
  document.getElementById("bilan"),
  JSON.parse(document.getElementById("payload").textContent),
);
</script>
</body>
</html>
`;
}

export interface ReportAssets {
  css: string;
  js: string;
}

/** The dashboard bundle is copied next to the CLI bundle at build time. */
export function loadAssets(): ReportAssets {
  const here = dirname(fileURLToPath(import.meta.url));
  return {
    css: readFileSync(join(here, 'bilan-ui.css'), 'utf8'),
    js: readFileSync(join(here, 'bilan-ui.js'), 'utf8'),
  };
}

function escapeHtml(s: string): string {
  return s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}
