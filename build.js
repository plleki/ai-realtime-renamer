const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const watch = process.argv.includes('--watch');

// ── Entry points ──────────────────────────────────────────────────────────────
const mainOptions = {
  entryPoints: ['src/main.ts'],
  bundle: true,
  outfile: 'dist/main.js',
  target: 'es2017',
  logLevel: 'info',
};

const uiOptions = {
  entryPoints: ['src/ui.ts'],
  bundle: true,
  outfile: 'dist/ui-bundle.js',
  target: 'es2017',
  logLevel: 'info',
};

// ── Inject bundled JS into minimal HTML shell ─────────────────────────────────
function injectUI() {
  const bundlePath = path.join('dist', 'ui-bundle.js');
  if (!fs.existsSync(bundlePath)) return;

  const js = fs.readFileSync(bundlePath, 'utf8');
  const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { width: 100%; height: 100%; overflow: hidden; background: #161618; }
  #root { width: 100%; height: 100%; }
</style>
</head>
<body>
<div id="root"></div>
<script>${js}</script>
</body>
</html>`;

  fs.mkdirSync('dist', { recursive: true });
  fs.writeFileSync('dist/ui.html', html);
  console.log('✓ UI built → dist/ui.html');
}

// ── Build ─────────────────────────────────────────────────────────────────────
async function build() {
  fs.mkdirSync('dist', { recursive: true });

  if (watch) {
    const mainCtx = await esbuild.context(mainOptions);
    const uiCtx   = await esbuild.context(uiOptions);
    await mainCtx.watch();
    await uiCtx.watch();
    // Re-inject HTML whenever the UI bundle changes
    fs.watch('dist/ui-bundle.js', () => injectUI());
    injectUI();
    console.log('Watching for changes… (Ctrl+C to stop)');
  } else {
    await esbuild.build(mainOptions);
    await esbuild.build(uiOptions);
    injectUI();
    console.log('✓ Build complete → dist/');
  }
}

build().catch(err => { console.error(err); process.exit(1); });
