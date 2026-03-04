/// <reference types="@figma/plugin-typings" />

// ─── State ────────────────────────────────────────────────────────────────────
let isEnabled = true;
let useAI = false;
let apiKey = '';

const debounceMap = new Map<string, ReturnType<typeof setTimeout>>();
const aiCache = new Map<string, string>();          // AI: structure fingerprint → name
const localCache = new Map<string, string>();       // Local: structure fingerprint → name
const structureSnapshot = new Map<string, string>(); // nodeId → last fingerprint (skip if unchanged)

// Temporary storage for Analyze & Rename batch AI flow
const pendingAnalyzeNodes = new Map<string, FrameNode | GroupNode | ComponentNode>();
let pendingAnalyzeTotal = 0;
let pendingAnalyzeScanRoot: SceneNode | null = null;

// ─── Structural Fingerprint ───────────────────────────────────────────────────
// Cheap hash of a node's structural shape — used for cache lookup.
// Buckets width/height to nearest 10px so minor resizes don't bust the cache.
function structuralFingerprint(node: FrameNode | GroupNode | ComponentNode): string {
  const n = node as any;
  const layout = n.layoutMode ?? 'NONE';
  // Bucket to 20px — minor resizes don't bust the cache
  const w = Math.round(node.width / 20) * 20;
  const h = Math.round(node.height / 20) * 20;
  const childCount = ('children' in node) ? (node as ChildrenMixin).children.length : 0;
  const childTypes = ('children' in node)
    ? (node as ChildrenMixin).children.slice(0, 6).map((c: SceneNode) => c.type[0]).join('')
    : '';
  // Include aspect ratio bucket — wide vs tall vs square matters more than exact px
  const ar = node.height > 0 ? (node.width / node.height > 2 ? 'W' : node.width / node.height < 0.5 ? 'T' : 'S') : 'S';
  return `${layout}|${w}x${h}|${ar}|${childCount}|${childTypes}`;
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
// Handle right-click menu commands — some run without showing UI
const command = figma.command;
const needsUI = !command || command === 'open';

figma.showUI(__html__, {
  width: 320,
  height: 560,
  title: 'AI Realtime Renamer',
  visible: needsUI,
});

(async () => {
  await figma.loadAllPagesAsync();

  const saved = await figma.clientStorage.getAsync('settings');
  if (saved) {
    isEnabled = saved.isEnabled ?? true;
    useAI = saved.useAI ?? false;
    apiKey = saved.apiKey ?? '';
  }

  // Restore saved log history
  const savedLog = await figma.clientStorage.getAsync('renameLog');
  if (savedLog && Array.isArray(savedLog)) {
    figma.ui.postMessage({ type: 'restoreLog', log: savedLog });
  }

  // Handle right-click menu commands directly
  if (command && command !== 'open') {
    await handleMenuCommand(command);
    return;
  }

  figma.ui.postMessage({ type: 'init', isEnabled, useAI, hasApiKey: !!apiKey });
})();

// ─── Menu Command Handler ─────────────────────────────────────────────────────
async function handleMenuCommand(cmd: string) {
  if (cmd === 'renameSelected') {
    const selection = figma.currentPage.selection;
    if (!selection.length) {
      figma.notify('Nothing selected — select a frame first.');
      figma.closePlugin();
      return;
    }
    let count = 0;
    for (const node of selection) {
      if (isNamableNode(node)) {
        const name = await getNameForNode(node as FrameNode);
        if (name && name !== node.name) { node.name = name; count++; }
      }
    }
    figma.notify(count > 0 ? `✓ Renamed ${count} layer${count !== 1 ? 's' : ''}` : 'Name already looks good ✓');
    figma.closePlugin();
  }

  else if (cmd === 'fixSelected') {
    const selection = figma.currentPage.selection;
    if (!selection.length) {
      figma.notify('Nothing selected — select a frame first.');
      figma.closePlugin();
      return;
    }
    let count = 0;
    for (const node of selection) {
      if (!isNamableNode(node)) continue;
      const allNodes: Array<FrameNode | GroupNode | ComponentNode> = [];
      collectTree(node as FrameNode, allNodes);
      for (const n of allNodes) {
        const suggested = analyzeNode(n);
        if (suggested && suggested !== n.name) { n.name = suggested; count++; }
      }
    }
    figma.notify(count > 0 ? `✓ Fixed ${count} layer${count !== 1 ? 's' : ''} in tree` : 'Tree already looks good ✓');
    figma.closePlugin();
  }

  else if (cmd === 'renamePage') {
    const nodes = figma.currentPage.findAll(n => isNamableNode(n) && isAutoName(n.name));
    let count = 0;
    for (const n of nodes) {
      const suggested = analyzeNode(n as FrameNode);
      if (suggested && suggested !== n.name) { n.name = suggested; count++; }
    }
    figma.notify(count > 0 ? `✓ Renamed ${count} layer${count !== 1 ? 's' : ''} on page` : 'Page already clean ✓');
    figma.closePlugin();
  }

  else if (cmd === 'healthCheck') {
    const allNodes = figma.currentPage.findAll(n => isNamableNode(n));
    const total = allNodes.length;
    const unnamed = allNodes.filter(n => isAutoName(n.name)).length;
    const pct = total > 0 ? Math.round(((total - unnamed) / total) * 100) : 100;
    figma.notify(
      unnamed === 0
        ? `✓ All ${total} layers are clean!`
        : `⚠ ${unnamed} of ${total} layers need renaming (${pct}% clean)`,
      { timeout: 4000 }
    );
    figma.closePlugin();
  }

  else {
    figma.ui.postMessage({ type: 'init', isEnabled, useAI, hasApiKey: !!apiKey });
  }
}

// ─── Messages from UI ────────────────────────────────────────────────────────
figma.ui.onmessage = async (msg) => {
  if (msg.type === 'toggle') { isEnabled = msg.value; await saveSettings(); }
  if (msg.type === 'toggleAI') { useAI = msg.value; await saveSettings(); }
  if (msg.type === 'setApiKey') {
    apiKey = msg.value;
    await saveSettings();
    figma.ui.postMessage({ type: 'status', text: apiKey ? '🔑 API key saved — AI mode enabled ✓' : 'API key cleared' });
  }

  // Return stored API key to UI for connection test
  if (msg.type === 'getApiKey') {
    figma.ui.postMessage({ type: 'apiKeyForTest', apiKey });
  }

  if (msg.type === 'renameSelected') {
    const selection = figma.currentPage.selection;
    if (!selection.length) { figma.ui.postMessage({ type: 'status', text: 'Nothing selected.' }); return; }
    let count = 0;
    for (const node of selection) {
      if (isNamableNode(node)) {
        const name = await getNameForNode(node as FrameNode);
        if (name) { node.name = name; count++; }
      }
    }
    figma.ui.postMessage({ type: 'status', text: `Renamed ${count} layer${count !== 1 ? 's' : ''} ✓` });
  }

  // Fix Selected — two paths:
  //   AI off: run local analyzeNode() on just the selected frame
  //   AI on:  collect full tree of selected frame + all descendants,
  //           send to Claude Sonnet in one batch for maximum context accuracy
  if (msg.type === 'fixSelected') {
    const selection = figma.currentPage.selection;
    if (!selection.length) {
      figma.notify('Nothing selected — please select a layer first.', { timeout: 3000 });
      figma.ui.postMessage({ type: 'analyzeDone' });
      return;
    }

    if (!useAI || !apiKey) {
      // ── Local path ──
      let count = 0;
      for (const node of selection) {
        if (!isNamableNode(node)) continue;
        const suggested = analyzeNode(node as FrameNode);
        if (suggested && suggested !== node.name) {
          const prevName = node.name;
          node.name = suggested;
          figma.ui.postMessage({ type: 'renamed', layerName: suggested, prevName, nodeId: node.id, ai: false });
          count++;
        }
      }
      figma.ui.postMessage({
        type: 'status',
        text: count === 0 ? 'Name is already accurate ✓' : `Updated ${count} layer${count !== 1 ? 's' : ''} ✓`,
      });
      return;
    }

    // ── AI path (Sonnet + full tree) ──
    figma.ui.postMessage({ type: 'status', text: 'Analyzing with Claude Sonnet…' });
    figma.ui.postMessage({ type: 'aiThinking', value: true });

    type FixNode = { node: FrameNode | GroupNode | ComponentNode; parentId: string | null; depth: number };
    const allNodes: FixNode[] = [];

    for (const root of selection) {
      if (!isNamableNode(root)) continue;
      const queue: FixNode[] = [{ node: root as FrameNode, parentId: null, depth: 0 }];
      while (queue.length) {
        const { node, parentId, depth } = queue.shift()!;
        allNodes.push({ node, parentId, depth });
        if ('children' in node) {
          for (const child of (node as ChildrenMixin).children) {
            if (isNamableNode(child)) {
              queue.push({ node: child as FrameNode, parentId: node.id, depth: depth + 1 });
            }
          }
        }
      }
    }

    const batchPayload = allNodes.map(({ node, parentId, depth }) => ({
      id: node.id,
      parentId,
      depth,
      currentName: node.name,
      structure: serializeNode(node),
    }));

    const nameMap = await callClaudeFixSelected(batchPayload);
    figma.ui.postMessage({ type: 'aiThinking', value: false });

    let count = 0;
    for (const { node } of allNodes) {
      const suggested = nameMap.get(node.id);
      if (suggested && suggested !== node.name) {
        const prevName = node.name;
        node.name = suggested;
        figma.ui.postMessage({ type: 'renamed', layerName: suggested, prevName, nodeId: node.id, ai: true });
        count++;
      }
    }

    figma.ui.postMessage({
      type: 'status',
      text: count === 0 ? 'All names look accurate ✓' : `Renamed ${count} layer${count !== 1 ? 's' : ''} with Sonnet ✓`,
    });
  }

  if (msg.type === 'renameAll') {
    const nodes = figma.currentPage.findAll(n => isNamableNode(n) && isAutoName(n.name));
    // Fire all renames in parallel — cache hits return instantly,
    // Haiku calls for uncached nodes fly concurrently
    const results = await Promise.all(
      nodes.map(async n => ({
        node: n as FrameNode,
        name: await getNameForNode(n as FrameNode),
      }))
    );
    let count = 0;
    for (const { node, name } of results) {
      if (name && name !== node.name) { node.name = name; count++; }
    }
    figma.ui.postMessage({ type: 'renameAllDone' });
    figma.ui.postMessage({ type: 'status', text: `Renamed ${count} layer${count !== 1 ? 's' : ''} ✓` });
  }

  // Rename entire tree — renames selected frame + every namable descendant
  // regardless of whether they already have a custom name, top-down
  if (msg.type === 'renameTree') {
    const selection = figma.currentPage.selection;
    if (!selection.length) {
      figma.ui.postMessage({ type: 'status', text: 'Select a frame first.' });
      return;
    }

    let count = 0;
    const renamed: Array<{ name: string; prevName: string; nodeId: string }> = [];

    for (const root of selection) {
      if (!isNamableNode(root)) continue;

      // Collect root + all namable descendants, breadth-first (top-down)
      const allNodes: Array<FrameNode | GroupNode | ComponentNode> = [];
      collectTree(root as FrameNode, allNodes);

      for (const node of allNodes) {
        const suggested = await getNameForNode(node);
        if (suggested && suggested !== node.name) {
          const prevName = node.name;
          node.name = suggested;
          count++;
          renamed.push({ name: suggested, prevName, nodeId: node.id });
        }
      }
    }

    for (const r of renamed) {
      figma.ui.postMessage({ type: 'renamed', layerName: r.name, prevName: r.prevName, nodeId: r.nodeId, ai: false });
    }
    figma.ui.postMessage({
      type: 'status',
      text: count > 0 ? `Renamed ${count} layer${count !== 1 ? 's' : ''} ✓` : 'All layers already accurate ✓',
    });
  }

  // Focus node — scroll Figma viewport to the layer and select it
  if (msg.type === 'focusNode') {
    const node = await figma.getNodeByIdAsync(msg.nodeId) as SceneNode | null;
    if (node && 'visible' in node) {
      figma.currentPage.selection = [node as SceneNode];
      figma.viewport.scrollAndZoomIntoView([node as SceneNode]);
    }
  }

  // ── Give Context: Collect tree + text samples ─────────────────────────────
  if (msg.type === 'contextAnalyze') {
    const selection = figma.currentPage.selection;
    if (!selection.length || !isNamableNode(selection[0])) {
      figma.ui.postMessage({ type: 'contextProgress', text: '✗ Select a Frame or Component first' });
      return;
    }
    const root = selection[0] as FrameNode | GroupNode | ComponentNode;
    figma.ui.postMessage({ type: 'contextProgress', text: 'Collecting layers…' });

    // Collect all namable nodes
    const allNodes: Array<FrameNode | GroupNode | ComponentNode> = [];
    collectTree(root, allNodes);

    // Collect actual text content for AI context
    const textSamples: string[] = [];
    const seen = new Set<string>();
    function gatherText(node: BaseNode) {
      if (node.type === 'TEXT') {
        const chars = (node as TextNode).characters.trim();
        if (chars && chars.length > 0 && chars.length < 200 && !seen.has(chars)) {
          seen.add(chars);
          textSamples.push(chars);
        }
      }
      if ('children' in node) {
        for (const child of (node as ChildrenMixin).children) gatherText(child);
      }
    }
    gatherText(root);

    // Build serialized node list
    const nodeList = allNodes.slice(0, 80).map(n => {
      const par = allNodes.find(p =>
        'children' in p && (p as ChildrenMixin).children.some((c: SceneNode) => c.id === n.id)
      );
      return {
        id: n.id,
        parentId: par?.id ?? null,
        depth: 0,
        structure: serializeNode(n),
        currentName: n.name,
      };
    });

    // Send nodes + screen metadata to UI, then API key to trigger Claude call
    figma.ui.postMessage({
      type: 'contextNodes',
      nodes: nodeList,
      textSamples: textSamples.slice(0, 60),
      screenName: root.name,
      screenNodeId: root.id,
      scanOnly: !!msg.scanOnly,
    });
    const saved = await figma.clientStorage.getAsync('settings');
    figma.ui.postMessage({ type: 'apiKeyForContext', apiKey: saved?.apiKey || '' });
  }

  // ── Give Context: Apply Names ─────────────────────────────────────────────
  if (msg.type === 'contextApplyNames') {
    const names: Record<string, string> = msg.names || {};
    let count = 0;
    for (const [id, name] of Object.entries(names)) {
      const node = await figma.getNodeByIdAsync(id);
      if (node && isNamableNode(node) && typeof name === 'string' && name.trim()) {
        const prevName = (node as FrameNode).name;
        (node as FrameNode).name = name.trim();
        figma.ui.postMessage({ type: 'renamed', layerName: name.trim(), prevName, nodeId: id, ai: true });
        count++;
      }
    }
    if (count > 0) figma.notify(`✓ Context renamed ${count} layers`, { timeout: 2500 });
  }

  // ── Give Context: Build Documentation Frame ─────────────────────────────────
  // Manually positioned — avoids Figma auto-layout API pitfalls that cause
  // silent failures when layoutSizingHorizontal/FILL is set before appending.
  if (msg.type === 'contextBuildDocFrame') {
    const { doc, stats, screenName, screenNodeId } = msg;
    if (!doc) return;

    try {
      const screenNode = screenNodeId
        ? (await figma.getNodeByIdAsync(screenNodeId) as FrameNode | null)
        : null;

      const GAP    = 80;
      const DOC_W  = screenNode ? Math.max((screenNode as FrameNode).width, 600) : 720;
      const screenX = screenNode ? (screenNode as FrameNode).absoluteTransform[0][2] : 0;
      const screenY = screenNode ? (screenNode as FrameNode).absoluteTransform[1][2] : 0;
      const PAD    = 36;
      const IW     = DOC_W - PAD * 2;  // inner content width

      // ── Fonts ──────────────────────────────────────────────────────────────
      await figma.loadFontAsync({ family: 'Inter', style: 'Regular' });
      await figma.loadFontAsync({ family: 'Inter', style: 'Medium' });
      await figma.loadFontAsync({ family: 'Inter', style: 'Bold' });

      // ── Palette ────────────────────────────────────────────────────────────
      const BG      = { r: 0.09, g: 0.09, b: 0.11 };
      const SURFACE = { r: 0.13, g: 0.13, b: 0.16 };
      const BORDER  = { r: 0.20, g: 0.20, b: 0.24 };
      const ACCENT  = { r: 0.48, g: 0.38, b: 1.00 };
      const CYAN    = { r: 0.00, g: 0.76, b: 1.00 };
      const GREEN   = { r: 0.20, g: 0.78, b: 0.35 };
      const ORANGE  = { r: 1.00, g: 0.55, b: 0.26 };
      const TPRI    = { r: 0.94, g: 0.94, b: 0.96 };
      const TSUB    = { r: 0.60, g: 0.60, b: 0.64 };
      const TMUT    = { r: 0.38, g: 0.38, b: 0.42 };
      type RGB3 = { r: number; g: number; b: number };

      const SEC_ACCENTS = [ACCENT, GREEN, ORANGE];

      // ── Helpers ────────────────────────────────────────────────────────────

      // Create a plain text node at absolute position, auto-height, fixed width
      function addText(
        parent: FrameNode,
        str: string,
        x: number, y: number, w: number,
        size: number,
        weight: 'Regular' | 'Medium' | 'Bold',
        color: RGB3,
        lineH = 0
      ): number {
        if (!str.trim()) return y;
        const t = figma.createText();
        t.fontName = { family: 'Inter', style: weight };
        t.fontSize = size;
        t.characters = str;
        t.fills = [{ type: 'SOLID', color }];
        if (lineH > 0) t.lineHeight = { value: lineH, unit: 'PIXELS' };
        t.textAutoResize = 'HEIGHT';
        t.resizeWithoutConstraints(w, 20);
        t.x = x; t.y = y;
        parent.appendChild(t);
        return y + t.height;
      }

      // Create a filled rectangle at absolute position
      function addRect(
        parent: FrameNode,
        x: number, y: number, w: number, h: number,
        color: RGB3,
        opacity = 1.0,
        radius = 0
      ): RectangleNode {
        const r = figma.createRectangle();
        r.resize(w, h);
        r.fills = [{ type: 'SOLID', color, opacity }];
        r.cornerRadius = radius;
        r.x = x; r.y = y;
        parent.appendChild(r);
        return r;
      }

      // ── Parse doc sections ─────────────────────────────────────────────────
      const sections: Array<{ title: string; body: string }> = [];
      const parts = doc.split(/(?=## )/);
      for (const p of parts) {
        const nl = p.indexOf('\n');
        if (nl === -1) continue;
        const title = p.slice(p.startsWith('## ') ? 3 : 0, nl).trim();
        const body  = p.slice(nl + 1).trim();
        if (title && body) sections.push({ title, body });
      }
      if (sections.length === 0) {
        sections.push({ title: 'Documentation', body: doc.trim() });
      }

      // ── First pass: measure total height ──────────────────────────────────
      // We build into a temp offscreen frame first, measure, then place properly

      // Estimate height so we can create the outer frame at the right size
      // (will be adjusted after children are appended)
      let curY = 0;

      // Top bar: 4px
      curY += 4;
      // Header: pill(~22) + gap(10) + h1(~36) + gap(10) + chips(~32) + gap(10) + padding(52)
      curY += 4 + 22 + 10 + 36 + 10 + 32 + 56;
      // Divider: 1px
      curY += 1;
      // Sections
      for (const sec of sections) {
        curY += 28; // top padding
        curY += 20; // section title row
        curY += 12; // gap
        // body lines
        const lines2 = sec.body.split('\n').filter(l => l.trim());
        curY += 32; // card padding top+bottom
        curY += lines2.length * 22;
        curY += 12; // section bottom gap
      }
      curY += 1 + 44; // footer border + footer

      // ── Create outer doc frame ─────────────────────────────────────────────
      const doc2 = figma.createFrame();
      doc2.name = `📄 ${screenName} — Documentation`;
      doc2.fills = [{ type: 'SOLID', color: BG }];
      doc2.cornerRadius = 16;
      doc2.clipsContent = true;
      doc2.resize(DOC_W, Math.max(curY, 400));
      doc2.strokes = [{ type: 'SOLID', color: BORDER }];
      doc2.strokeWeight = 1;
      doc2.strokeAlign = 'INSIDE';

      // ── Draw into the frame at Y cursor ────────────────────────────────────
      let y = 0;

      // Gradient top bar
      const topBar = figma.createRectangle();
      topBar.resize(DOC_W, 4);
      topBar.fills = [{
        type: 'GRADIENT_LINEAR',
        gradientTransform: [[1, 0, 0], [0, 1, 0]],
        gradientStops: [
          { position: 0, color: { ...ACCENT, a: 1 } },
          { position: 1, color: { ...CYAN, a: 1 } },
        ],
      }];
      topBar.x = 0; topBar.y = 0;
      doc2.appendChild(topBar);
      y += 4;

      // Header background
      const hdrBg = addRect(doc2, 0, y, DOC_W, 130, BG);
      void hdrBg;

      y += 28; // top padding

      // "SCREEN DOCUMENTATION" pill
      const pillBg = figma.createRectangle();
      pillBg.resize(184, 22);
      pillBg.fills = [{ type: 'SOLID', color: ACCENT, opacity: 0.14 }];
      pillBg.cornerRadius = 11;
      pillBg.x = PAD; pillBg.y = y;
      doc2.appendChild(pillBg);

      const pillT = figma.createText();
      pillT.fontName = { family: 'Inter', style: 'Bold' };
      pillT.fontSize = 9;
      pillT.characters = 'SCREEN DOCUMENTATION';
      pillT.fills = [{ type: 'SOLID', color: ACCENT }];
      pillT.letterSpacing = { value: 1.2, unit: 'PIXELS' };
      pillT.textAutoResize = 'HEIGHT';
      pillT.resizeWithoutConstraints(164, 12);
      pillT.x = PAD + 10; pillT.y = y + 5;
      doc2.appendChild(pillT);
      y += 30;

      // Screen name H1
      const h1 = figma.createText();
      h1.fontName = { family: 'Inter', style: 'Bold' };
      h1.fontSize = 24;
      h1.characters = screenName;
      h1.fills = [{ type: 'SOLID', color: TPRI }];
      h1.lineHeight = { value: 32, unit: 'PIXELS' };
      h1.textAutoResize = 'HEIGHT';
      h1.resizeWithoutConstraints(IW, 30);
      h1.x = PAD; h1.y = y;
      doc2.appendChild(h1);
      y += h1.height + 14;

      // Stat chips
      const chipDefs = [
        { label: `${stats.totalLayers} layers renamed`, color: ACCENT },
        { label: `${stats.components} components`,      color: GREEN  },
        { label: `${stats.interactions} interactions`,  color: ORANGE },
      ];
      let chipX = PAD;
      for (const cd of chipDefs) {
        const cw = cd.label.length * 7 + 32; // rough width estimate
        const chipBg = figma.createRectangle();
        chipBg.resize(cw, 28);
        chipBg.fills = [{ type: 'SOLID', color: SURFACE }];
        chipBg.cornerRadius = 7;
        chipBg.strokes = [{ type: 'SOLID', color: BORDER }];
        chipBg.strokeWeight = 1;
        chipBg.strokeAlign = 'INSIDE';
        chipBg.x = chipX; chipBg.y = y;
        doc2.appendChild(chipBg);

        const dot = figma.createEllipse();
        dot.resize(5, 5);
        dot.fills = [{ type: 'SOLID', color: cd.color }];
        dot.x = chipX + 10; dot.y = y + 11;
        doc2.appendChild(dot);

        const ct = figma.createText();
        ct.fontName = { family: 'Inter', style: 'Medium' };
        ct.fontSize = 11;
        ct.characters = cd.label;
        ct.fills = [{ type: 'SOLID', color: TSUB }];
        ct.textAutoResize = 'WIDTH_AND_HEIGHT';
        ct.x = chipX + 21; ct.y = y + 6;
        doc2.appendChild(ct);

        chipX += cw + 8;
      }
      y += 28 + 28; // chips height + bottom header padding

      // Resize header bg to actual height
      hdrBg.resize(DOC_W, y - 4);

      // Header divider
      addRect(doc2, 0, y, DOC_W, 1, BORDER);
      y += 1;

      // ── Sections ───────────────────────────────────────────────────────────
      for (let si = 0; si < sections.length; si++) {
        const sec    = sections[si];
        const accent = SEC_ACCENTS[si % SEC_ACCENTS.length];

        y += 28; // section top padding

        // Section title: accent bar + label
        addRect(doc2, PAD, y + 1, 3, 16, accent, 1, 2);
        addText(doc2, sec.title.toUpperCase(), PAD + 13, y, IW - 14, 10, 'Bold', accent, 16);
        y += 24;

        // Body card background — we'll resize it after content
        const cardBg = figma.createRectangle();
        cardBg.resize(IW, 20); // placeholder, resized below
        cardBg.fills = [{ type: 'SOLID', color: SURFACE }];
        cardBg.cornerRadius = 10;
        cardBg.strokes = [{ type: 'SOLID', color: BORDER }];
        cardBg.strokeWeight = 1;
        cardBg.strokeAlign = 'INSIDE';
        cardBg.x = PAD; cardBg.y = y;
        doc2.appendChild(cardBg);

        const cardTop = y;
        y += 16; // card top padding

        // Body lines
        const rawLines = sec.body.split('\n');
        for (const rawLine of rawLines) {
          const trimmed = rawLine.trim();
          if (!trimmed) continue;
          const isBullet = /^[-•*]/.test(trimmed);
          const text = isBullet ? trimmed.replace(/^[-•*]\s*/, '') : trimmed;

          if (isBullet) {
            // Dot
            const dot2 = figma.createEllipse();
            dot2.resize(4, 4);
            dot2.fills = [{ type: 'SOLID', color: accent, opacity: 0.8 }];
            dot2.x = PAD + 16; dot2.y = y + 6;
            doc2.appendChild(dot2);

            const bt = figma.createText();
            bt.fontName = { family: 'Inter', style: 'Regular' };
            bt.fontSize = 12;
            bt.characters = text;
            bt.fills = [{ type: 'SOLID', color: TSUB }];
            bt.lineHeight = { value: 19, unit: 'PIXELS' };
            bt.textAutoResize = 'HEIGHT';
            bt.resizeWithoutConstraints(IW - 46, 18);
            bt.x = PAD + 27; bt.y = y;
            doc2.appendChild(bt);
            y += bt.height + 6;
          } else {
            const pt = figma.createText();
            pt.fontName = { family: 'Inter', style: 'Regular' };
            pt.fontSize = 12;
            pt.characters = text;
            pt.fills = [{ type: 'SOLID', color: TSUB }];
            pt.lineHeight = { value: 19, unit: 'PIXELS' };
            pt.textAutoResize = 'HEIGHT';
            pt.resizeWithoutConstraints(IW - 32, 18);
            pt.x = PAD + 16; pt.y = y;
            doc2.appendChild(pt);
            y += pt.height + 6;
          }
        }

        y += 16; // card bottom padding
        cardBg.resize(IW, y - cardTop);

        // Section divider (except last)
        if (si < sections.length - 1) {
          y += 12;
          addRect(doc2, PAD, y, IW, 1, BORDER, 0.5);
          y += 1;
        }
      }

      // ── Footer ─────────────────────────────────────────────────────────────
      y += 28;
      addRect(doc2, 0, y, DOC_W, 1, BORDER);
      y += 1 + 14;

      const now = new Date();
      const ds = now.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
      addText(doc2, `Generated by AI Realtime Renamer  ·  ${ds}`, PAD, y, IW, 10, 'Regular', TMUT, 16);
      y += 30;

      // ── Resize outer frame to actual content height ──────────────────────
      doc2.resize(DOC_W, y);

      // ── Place on canvas above screen ────────────────────────────────────
      figma.currentPage.appendChild(doc2);
      doc2.x = screenX;
      doc2.y = screenY - y - GAP;

      figma.viewport.scrollAndZoomIntoView([doc2]);
      figma.notify(`✓ Documentation frame created above "${screenName}"`, { timeout: 3000 });

      figma.ui.postMessage({
        type: 'contextSummary',
        totalLayers:  stats.totalLayers,
        components:   stats.components,
        interactions: stats.interactions,
        screenName,
      });

    } catch (err: any) {
      figma.notify(`⚠ Doc frame error: ${err?.message || err}`, { timeout: 4000 });
      figma.ui.postMessage({ type: 'contextSummary', totalLayers: 0, components: 0, interactions: 0, screenName: '' });
    }
  }

  // ─── Analyze & Rename ─────────────────────────────────────────────────────
  // Two paths:
  //   A) No AI: run local analyzeNode() on every node in tree, rename all, done.
  //   B) AI enabled: collect tree, serialize every node WITH parent context,
  //      send batch to UI for a single Claude Sonnet call, apply results.
  //
  // Both paths rename ALL nodes in the tree regardless of current name
  // (unlike renameTree which skips custom-named nodes).
  //
  if (msg.type === 'analyzeRename') {
    const selection = figma.currentPage.selection;
    if (!selection.length) {
      figma.notify('Select a frame first — Scan Nested Layers needs a starting point.', { timeout: 3000 });
      figma.ui.postMessage({ type: 'analyzeDone' });
      return;
    }

    // Collect ALL namable nodes breadth-first across all selected roots
    type AnalyzeNode = {
      node: FrameNode | GroupNode | ComponentNode;
      parentId: string | null;
      depth: number;
    };
    const allNodes: AnalyzeNode[] = [];

    for (const root of selection) {
      if (!isNamableNode(root)) continue;
      const queue: AnalyzeNode[] = [{ node: root as FrameNode, parentId: null, depth: 0 }];
      while (queue.length) {
        const { node, parentId, depth } = queue.shift()!;
        allNodes.push({ node, parentId, depth });
        if ('children' in node) {
          for (const child of (node as ChildrenMixin).children) {
            if (isNamableNode(child)) {
              queue.push({ node: child as FrameNode, parentId: node.id, depth: depth + 1 });
            }
          }
        }
      }
    }

    const total = allNodes.length;

    if (useAI && apiKey) {
      // ── Path B: Context-aware Claude Sonnet rename ───────────────────────
      // Same flow as Give Context: collect text samples so Claude can read
      // the actual screen content and give names like "Candidate Row" not "Item"
      const root = selection[0];
      const textSamples: string[] = [];
      const seenTxt = new Set<string>();
      function gatherTxt(n: BaseNode) {
        if (n.type === 'TEXT') {
          const ch = (n as TextNode).characters.trim();
          if (ch && ch.length < 200 && !seenTxt.has(ch)) { seenTxt.add(ch); textSamples.push(ch); }
        }
        if ('children' in n) for (const c of (n as ChildrenMixin).children) gatherTxt(c);
      }
      gatherTxt(root);

      const nodeList = allNodes.slice(0, 80).map(({ node, parentId, depth }) => ({
        id: node.id, parentId, depth, currentName: node.name, structure: serializeNode(node),
      }));

      // Store for when names come back
      pendingAnalyzeNodes.clear();
      for (const { node } of allNodes) pendingAnalyzeNodes.set(node.id, node);
      pendingAnalyzeTotal = total;

      // Reuse the same contextNodes → apiKeyForContext → contextApplyNames flow
      // but with a flag so the UI knows to send results back as scanApplyNames
      figma.ui.postMessage({
        type: 'contextNodes',
        nodes: nodeList,
        textSamples: textSamples.slice(0, 60),
        screenName: root.name,
        screenNodeId: root.id,
        fromScan: true,   // signals UI to use scanApplyNames instead of contextApplyNames
      });
      figma.ui.postMessage({ type: 'apiKeyForContext', apiKey });

    } else {
      // ── Path A: Local rule-based analysis ────────────────────────────────
      const renamed: Array<{ name: string; prevName: string; nodeId: string }> = [];
      let count = 0;
      for (let i = 0; i < allNodes.length; i++) {
        const { node } = allNodes[i];
        const fp = structuralFingerprint(node);
        // Cache check first — avoid re-running scorer for identical structures
        let suggested = localCache.get(fp);
        if (!suggested) {
          suggested = analyzeNode(node) ?? undefined;
          if (suggested) localCache.set(fp, suggested);
        }
        // Only emit progress every 5 nodes — postMessage is expensive
        if (i % 5 === 0 || i === allNodes.length - 1) {
          figma.ui.postMessage({ type: 'analyzeProgress', text: `${i + 1} / ${total}` });
        }
        if (suggested && suggested !== node.name) {
          const prevName = node.name;
          node.name = suggested;
          count++;
          renamed.push({ name: suggested, prevName, nodeId: node.id });
        }
      }
      for (const r of renamed) {
        figma.ui.postMessage({ type: 'renamed', layerName: r.name, prevName: r.prevName, nodeId: r.nodeId, ai: false });
      }
      figma.ui.postMessage({ type: 'analyzeDone' });
      figma.ui.postMessage({
        type: 'status',
        text: count > 0 ? `Renamed ${count} of ${total} layers ✓` : `All ${total} layers already named ✓`,
      });
    }
  }

  // ── Apply Claude batch results (Analyze & Rename page-wide) ─────────────────
  // Results WITH an id are handled by callClaudeFixSelected's promise resolver.
  // Only process id-less results here (from the analyzeRename flow).
  if (msg.type === 'aiAnalyzeBatchResult' && !msg.id) {
    const result: Record<string, string> = msg.result || {};
    const renamed: Array<{ name: string; prevName: string; nodeId: string }> = [];
    let count = 0;
    let i = 0;
    const total = pendingAnalyzeTotal;

    for (const [nodeId, suggestedName] of Object.entries(result)) {
      const node = pendingAnalyzeNodes.get(nodeId);
      i++;
      figma.ui.postMessage({ type: 'analyzeProgress', text: `${i} / ${total}` });
      if (node && suggestedName && suggestedName !== node.name) {
        const prevName = node.name;
        node.name = suggestedName;
        count++;
        renamed.push({ name: suggestedName, prevName, nodeId: node.id });
      }
    }

    // Fallback: any node NOT in the batch result → use local scorer
    for (const [nodeId, node] of pendingAnalyzeNodes.entries()) {
      if (!(nodeId in result)) {
        const suggested = analyzeNode(node);
        if (suggested && suggested !== node.name) {
          const prevName = node.name;
          node.name = suggested;
          count++;
          renamed.push({ name: suggested, prevName, nodeId: node.id });
        }
      }
    }

    for (const r of renamed) {
      figma.ui.postMessage({ type: 'renamed', layerName: r.name, prevName: r.prevName, nodeId: r.nodeId, ai: true });
    }
    figma.ui.postMessage({ type: 'analyzeDone' });
    figma.ui.postMessage({
      type: 'status',
      text: count > 0 ? `AI analyzed & renamed ${count} of ${total} layers ✓` : `All ${total} layers already accurate ✓`,
    });

    pendingAnalyzeNodes.clear();
    pendingAnalyzeTotal = 0;
  }

  // ── Scan & Rename: Apply context-aware names from Claude ────────────────────
  // Triggered when UI sends back names from the contextNodes→callClaudeContext flow
  // with fromScan=true. Same rename logic as contextApplyNames.
  if (msg.type === 'scanApplyNames') {
    const names: Record<string, string> = msg.names || {};
    let count = 0;
    const total2 = Object.keys(names).length;
    for (const [id, nameStr] of Object.entries(names)) {
      if (typeof nameStr !== 'string' || !nameStr.trim()) continue;
      const clean = nameStr.trim();
      // Use in-memory map first (already collected), fall back to async lookup
      const node: BaseNode | null = pendingAnalyzeNodes.get(id) ?? await figma.getNodeByIdAsync(id);
      if (node && isNamableNode(node)) {
        const prevName = (node as FrameNode).name;
        if (prevName !== clean) {
          (node as FrameNode).name = clean;
          figma.ui.postMessage({ type: 'renamed', layerName: clean, prevName, nodeId: id, ai: true });
          count++;
        }
      }
    }
    pendingAnalyzeNodes.clear();
    pendingAnalyzeTotal = 0;
    figma.ui.postMessage({ type: 'analyzeDone' });
    figma.ui.postMessage({
      type: 'status',
      text: count > 0
        ? `Context renamed ${count} of ${total2} layers ✓`
        : 'All layers already named accurately ✓',
    });
  }

  // ─── Selection guard ─────────────────────────────────────────────────────────
  if (msg.type === 'checkSelection') {
    const sel = figma.currentPage.selection;
    if (!sel.length || !isNamableNode(sel[0])) {
      figma.notify('Please select a frame or layer first', { timeout: 2500 });
    } else {
      figma.ui.postMessage({ type: 'checkSelectionOk', then: msg.then });
    }
  }

  // ─── Layer Health Scan ─────────────────────────────────────────────────────
  if (msg.type === 'healthScan') {
    sendHealthUpdate();
  }

  // ─── Point Layers — select all unnamed layers in Figma ──────────────────────
  if (msg.type === 'pointLayers') {
    const unnamed = figma.currentPage.findAll(n => isNamableNode(n) && isAutoName(n.name)) as SceneNode[];
    if (unnamed.length) {
      figma.currentPage.selection = unnamed;
      figma.viewport.scrollAndZoomIntoView(unnamed);
      figma.ui.postMessage({ type: 'status', text: `Pointing to ${unnamed.length} unnamed layer${unnamed.length !== 1 ? 's' : ''} ↗` });
    } else {
      figma.ui.postMessage({ type: 'status', text: 'No unnamed layers found ✓' });
    }
  }

  // ─── Save log history ───────────────────────────────────────────────────────
  if (msg.type === 'saveLog') {
    await figma.clientStorage.setAsync('renameLog', msg.log);
  }

  // Resize plugin window (for collapse/expand)
  if (msg.type === 'resize') {
    figma.ui.resize(msg.width, msg.height);
  }
};

// ─── Real-time Listener ───────────────────────────────────────────────────────
// Only queue frames whose STRUCTURE changed — skip pure cosmetic changes
// (fills, strokes, opacity, effects) that can't affect the semantic name.
const STRUCTURAL_PROPS = new Set([
  'width', 'height', 'layoutMode', 'itemSpacing', 'paddingTop', 'paddingBottom',
  'paddingLeft', 'paddingRight', 'children', 'characters', 'fontSize', 'fontWeight',
]);

figma.on('documentchange', async (event) => {
  if (!isEnabled) return;

  const toEvaluate = new Set<string>();

  for (const change of event.documentChanges) {
    // Only care about creates and property changes
    if (change.type !== 'CREATE' && change.type !== 'PROPERTY_CHANGE') continue;

    // For property changes, skip purely cosmetic ones
    if (change.type === 'PROPERTY_CHANGE') {
      const hasStructural = (change as any).properties?.some(
        (p: string) => STRUCTURAL_PROPS.has(p)
      );
      // If properties list exists and none are structural, skip entirely
      if ((change as any).properties && !hasStructural) continue;
    }

    const node = await figma.getNodeByIdAsync(change.id);
    if (!node) continue;

    if (isNamableNode(node)) toEvaluate.add(node.id);

    const ancestor = findNamableAncestor(node);
    if (ancestor) toEvaluate.add(ancestor.id);
  }

  for (const nodeId of toEvaluate) {
    scheduleRename(nodeId);
  }
});

// ─── Debounced Rename ─────────────────────────────────────────────────────────
// Debounce: 350ms (down from 700ms) — safe since local scoring is <1ms and
// Haiku typically responds in 400-600ms, so we fire sooner without race risk.
//
// Optimizations applied here:
//   1. Structural fingerprint check — skip if structure hasn't changed since last rename
//   2. Local cache hit — return instantly without re-running the full scorer
//   3. Speculative local name (AI mode) — apply local name immediately so the layer
//      never stays as "Frame 12", then silently replace with AI name on arrival
//   4. Parallel AI calls — multiple frames fire concurrently via Promise.all
const pendingAIRenames = new Map<string, Promise<void>>();

function scheduleRename(nodeId: string) {
  if (debounceMap.has(nodeId)) clearTimeout(debounceMap.get(nodeId)!);

  const timeout = setTimeout(async () => {
    debounceMap.delete(nodeId);
    const node = await figma.getNodeByIdAsync(nodeId);
    if (!node || !isNamableNode(node)) return;
    if (!isAutoName(node.name)) return; // user manually named this — never overwrite

    const typedNode = node as FrameNode | GroupNode | ComponentNode;

    // ── 1. Fingerprint check: skip if structure unchanged since last rename ──
    const fp = structuralFingerprint(typedNode);
    if (structureSnapshot.get(nodeId) === fp && !isAutoName(node.name)) return;

    if (!useAI || !apiKey) {
      // ── LOCAL PATH ──────────────────────────────────────────────────────────
      // Check local cache first
      const cached = localCache.get(fp);
      if (cached) {
        if (cached !== node.name) {
          const prevName = node.name;
          node.name = cached;
          structureSnapshot.set(nodeId, fp);
          figma.ui.postMessage({ type: 'renamed', layerName: cached, prevName, nodeId, ai: false });
        }
        return;
      }
      // Run scorer, store in cache
      const suggested = analyzeNode(typedNode);
      if (suggested) {
        localCache.set(fp, suggested);
        if (suggested !== node.name) {
          const prevName = node.name;
          node.name = suggested;
          structureSnapshot.set(nodeId, fp);
          figma.ui.postMessage({ type: 'renamed', layerName: suggested, prevName, nodeId, ai: false });
        }
      }
      return;
    }

    // ── AI PATH ─────────────────────────────────────────────────────────────
    // Skip if an AI call for this node is already in-flight
    if (pendingAIRenames.has(nodeId)) return;

    // Check AI cache first (instant — no visual flicker, no double rename)
    const aiCached = aiCache.get(fp);
    if (aiCached) {
      if (aiCached !== node.name) {
        const prevName = node.name;
        node.name = aiCached;
        structureSnapshot.set(nodeId, fp);
        figma.ui.postMessage({ type: 'renamed', layerName: aiCached, prevName, nodeId, ai: true });
      }
      return;
    }

    // No speculative local rename — AI mode renames once, with the AI name only.
    // This eliminates the visible double-rename flicker the user sees when local
    // fires first (e.g. "Card") then AI replaces it (e.g. "Item") a few ms later.
    // The layer stays as "Frame N" until Haiku responds — acceptable UX tradeoff.

    // ── Fire Haiku in parallel (non-blocking) ────────────────────────────────
    const aiPromise = (async () => {
      try {
        figma.ui.postMessage({ type: 'aiThinking', value: true });
        const structure = serializeNode(typedNode);
        const aiName = await callClaude(structure, nodeId);
        figma.ui.postMessage({ type: 'aiThinking', value: false });

        if (aiName) {
          aiCache.set(fp, aiName);
          // Silently replace speculative name with AI name
          const freshNode = await figma.getNodeByIdAsync(nodeId);
          if (freshNode && isNamableNode(freshNode)) {
            const prevName = freshNode.name;
            freshNode.name = aiName;
            structureSnapshot.set(nodeId, fp);
            if (prevName !== aiName) {
              figma.ui.postMessage({ type: 'renamed', layerName: aiName, prevName, nodeId, ai: true });
            }
          }
        }
      } catch {
        figma.ui.postMessage({ type: 'aiThinking', value: false });
      } finally {
        pendingAIRenames.delete(nodeId);
      }
    })();

    pendingAIRenames.set(nodeId, aiPromise);
  }, 350); // 350ms debounce — half of original 700ms

  debounceMap.set(nodeId, timeout);
}

// ─── Find Closest Namable Ancestor ───────────────────────────────────────────
function findNamableAncestor(node: BaseNode): FrameNode | null {
  let current = node.parent;
  while (current) {
    if (isNamableNode(current) && isAutoName((current as FrameNode).name)) {
      return current as FrameNode;
    }
    // Stop if we hit the page — don't go further up
    if (current.type === 'PAGE') break;
    current = current.parent;
  }
  return null;
}

// ─── Name Resolution (used by renameAll / Whole Page only) ──────────────────
// Real-time renames go through scheduleRename() which handles caching,
// speculative naming, and parallel calls. This simpler version is for the
// Whole Page batch pass which doesn't need speculative behaviour.
async function getNameForNode(node: FrameNode | GroupNode | ComponentNode): Promise<string | null> {
  const fp = structuralFingerprint(node);

  if (!useAI || !apiKey) {
    const cached = localCache.get(fp);
    if (cached) return cached;
    const name = analyzeNode(node);
    if (name) localCache.set(fp, name);
    return name;
  }

  // AI: check cache first, then call Haiku
  const cached = aiCache.get(fp);
  if (cached) return cached;

  try {
    const name = await callClaude(serializeNode(node), node.id);
    if (name) { aiCache.set(fp, name); return name; }
  } catch { /* fall through */ }

  // Fallback to local for batch pass — better than leaving it as "Frame N"
  return analyzeNode(node);
}

// ─── Deep Node Analysis ───────────────────────────────────────────────

interface NodeSignals {
  // Text structure
  textCount: number;
  headingCount: number;       // large/bold — h1/h2 level
  bodyCount: number;          // long paragraph text
  labelCount: number;         // small meta text (date, tag, caption)
  shortTextCount: number;     // text nodes ≤2 words
  totalWordCount: number;     // total words across all text nodes
  hasLargeNumber: boolean;    // text that looks like a stat (pure digits, large font)

  // Media
  hasImage: boolean;
  hasAvatar: boolean;

  // Interactive
  hasButton: boolean;
  hasInput: boolean;
  hasCheckbox: boolean;
  hasToggle: boolean;
  hasDropdown: boolean;

  // Navigation signals
  hasLogo: boolean;
  hasDivider: boolean;        // thin horizontal line child

  // Icons
  iconCount: number;

  // Layout
  isHorizontal: boolean;
  isVertical: boolean;
  hasAutoLayout: boolean;
  width: number;
  height: number;
  aspectRatio: number;        // w/h — wide=navbar, tall=sidebar, square=card
  childCount: number;
  totalDescendants: number;
  childrenAreUniform: boolean; // all direct children roughly same size (grid/list signal)

  // Structural name hints from layer names only (not text content)
  nameHints: string[];
}

function deepAnalyze(node: FrameNode | GroupNode | ComponentNode): NodeSignals {
  const s: NodeSignals = {
    textCount: 0, headingCount: 0, bodyCount: 0, labelCount: 0,
    shortTextCount: 0, totalWordCount: 0, hasLargeNumber: false,
    hasImage: false, hasAvatar: false,
    hasButton: false, hasInput: false, hasCheckbox: false, hasToggle: false, hasDropdown: false,
    hasLogo: false, hasDivider: false,
    iconCount: 0,
    isHorizontal: false, isVertical: false, hasAutoLayout: false,
    width: node.width, height: node.height,
    aspectRatio: node.height > 0 ? node.width / node.height : 1,
    childCount: 0, totalDescendants: 0, childrenAreUniform: false,
    nameHints: [],
  };

  if ('layoutMode' in node) {
    s.isHorizontal = (node as FrameNode).layoutMode === 'HORIZONTAL';
    s.isVertical   = (node as FrameNode).layoutMode === 'VERTICAL';
    s.hasAutoLayout = s.isHorizontal || s.isVertical;
  }


  if (!('children' in node)) return s;
  s.childCount = (node as ChildrenMixin).children.length;
  walkDescendants(node as ChildrenMixin, s, 0);

  // Detect uniform children (grid/list signal) — all direct children within 20px height of each other
  if (s.childCount >= 3 && 'children' in node) {
    const kids = (node as ChildrenMixin).children;
    const heights = kids.map((c: SceneNode) => Math.round(c.height / 10) * 10);
    const allSame = heights.every((h: number) => Math.abs(h - heights[0]) <= 20);
    s.childrenAreUniform = allSame;
  }

  return s;
}

function walkDescendants(parent: ChildrenMixin, s: NodeSignals, depth: number) {
  for (const child of parent.children) {
    s.totalDescendants++;
    const nameLower = child.name.toLowerCase();
    s.nameHints.push(nameLower);

    // ── Text structure (classify by size/weight, NOT content) ──
    if (child.type === 'TEXT') {
      const t = child as TextNode;
      const chars = t.characters.trim();
      if (!chars) continue;

      s.textCount++;
      const wordCount = chars.trim().split(/\s+/).filter(Boolean).length;
      s.totalWordCount += wordCount;
      if (wordCount <= 2) s.shortTextCount++;
      const fontSize = typeof t.fontSize === 'number' ? t.fontSize : 14;
      const fontWeight = typeof t.fontWeight === 'number' ? t.fontWeight : 400;
      const isLong = chars.length > 80;

      // Stat detection: large font + mostly digits (e.g. "1,234" or "98%")
      if (fontSize >= 28 && /^[\d,.\s%$+\-kKmMbB]+$/.test(chars)) {
        s.hasLargeNumber = true;
      }

      if (fontSize >= 22 || fontWeight >= 700) {
        s.headingCount++;
      } else if (isLong || fontSize <= 12) {
        s.bodyCount++;
      } else {
        s.labelCount++;
      }
    }

    // ── Vector / Icon (NOT image) ──
    // Vectors, booleans, and small square instances named like icons = icon
    if (child.type === 'VECTOR' || child.type === 'BOOLEAN_OPERATION') s.iconCount++;
    if (child.type === 'INSTANCE' || child.type === 'COMPONENT') {
      const isSmallSquare = child.width < 64 && child.height < 64 && Math.abs(child.width - child.height) < 10;
      if (isSmallSquare && nm(nameLower, ['icon', 'ico', 'symbol', 'arrow', 'chevron', 'check', 'close', 'menu', 'more', 'dots'])) {
        s.iconCount++;
      }
    }

    // ── Divider (thin horizontal rectangle) ──
    if (child.type === 'RECTANGLE' || child.type === 'LINE') {
      if (child.width > 50 && child.height <= 4) s.hasDivider = true;
    }

    // ── Image fills ──
    if ('fills' in child) {
      const fills = (child as GeometryMixin).fills as Paint[];
      if (Array.isArray(fills) && fills.some(f => f.type === 'IMAGE')) {
        const isSmall    = child.width < 100 && child.height < 100;
        const isSquarish = Math.abs(child.width - child.height) < 20;
        if (isSmall && isSquarish) s.hasAvatar = true;
        else s.hasImage = true;
      }
    }

    // ── Layer-name based detection ──
    if (nm(nameLower, ['icon', 'ico', 'symbol']))                              s.iconCount++;
    if (nm(nameLower, ['avatar', 'profile', 'pfp', 'user photo']))             s.hasAvatar = true;
    if (nm(nameLower, ['image', 'img', 'photo', 'thumbnail', 'cover',
                        'banner', 'poster', 'hero image']))                    s.hasImage = true;
    if (nm(nameLower, ['button', 'btn', 'cta']))                               s.hasButton = true;
    if (nm(nameLower, ['input', 'field', 'textfield', 'search', 'placeholder']))s.hasInput = true;
    if (nm(nameLower, ['checkbox', 'check box']))                               s.hasCheckbox = true;
    if (nm(nameLower, ['toggle', 'switch']))                                    s.hasToggle = true;
    if (nm(nameLower, ['dropdown', 'select', 'picker']))                        s.hasDropdown = true;
    if (nm(nameLower, ['logo', 'brand', 'wordmark']))                           s.hasLogo = true;

    if ('children' in child && depth < 3) walkDescendants(child as ChildrenMixin, s, depth + 1);
  }
}

function nm(name: string, keywords: string[]): boolean {
  return keywords.some(k => name.includes(k));
}

// ─── Score-based Structural Naming (v9 — Full AI Knowledge) ─────────────────
//
// HOW AN AI NAMES LAYERS — the reasoning chain I apply:
//
//  1. WHAT DOES IT CONTAIN?
//     Scan all descendants: text nodes (size/weight/length), images, avatars,
//     icons (vectors), inputs, buttons, checkboxes, dividers.
//
//  2. WHAT IS ITS SHAPE?
//     Wide+flat = navigation/bar. Tall+narrow = sidebar/panel.
//     Squarish = card/tile. Very large = section/page area.
//     Very small + short = element (button, badge, tag).
//
//  3. HOW IS IT ARRANGED?
//     Horizontal auto-layout = row of peers (nav, tab bar, links, action bar).
//     Vertical auto-layout = stack of items (list, form, section).
//     No auto-layout = freeform canvas (hero, illustration, banner).
//
//  4. HOW MANY CHILDREN / DESCENDANTS?
//     1–2 children = atom (label, input, avatar row).
//     3–6 children = component (card, list item, form group).
//     7+ children = organism (section, form, feed, grid).
//
//  5. WHAT COMBINATION OF SIGNALS FIRES A PATTERN?
//     logo + links + horizontal + wide                  → Navbar
//     3–6 uniform horizontal items + icons              → Tab Bar
//     input + icon + horizontal + short                 → Search Bar
//     2+ stacked inputs                                 → Form
//     avatar + 2 text nodes + horizontal                → Profile Row / Item
//     image + heading + body + optional button          → Card
//     image only, no text                               → Media Block
//     large number + small label below                  → Stat
//     icon + heading + body (no image)                  → Feature
//     heading + body (no icon, no image)                → Text Block
//     horizontal 2-col: image one side, text other      → Split Layout
//     repeated uniform children (3+)                    → List / Grid
//     ≤2 words + no image/avatar                        → Label / Badge
//     text(>2w) + icon, no image                        → List Item
//     many descendants + wide + 2+ headings             → Section
//     thin horizontal bar with text/links               → Links / Toolbar
//
// SCORING: each signal contributes points. Highest total wins.
// Hard blocks (sc = 0 if condition) prevent impossible matches.

interface NameCandidate { name: string; score: number; }

function analyzeNode(node: FrameNode | GroupNode | ComponentNode): string | null {
  if (!('children' in node) || (node as ChildrenMixin).children.length === 0) return null;

  // Fast path: single child — no need to score 20 candidates
  const kids = (node as ChildrenMixin).children;
  if (kids.length === 1) {
    const only = kids[0];
    if (only.type === 'TEXT') return 'Label';
    if (only.type === 'VECTOR' || only.type === 'BOOLEAN_OPERATION') return 'Icon';
    if ('fills' in only) {
      const f = (only as GeometryMixin).fills as Paint[];
      if (Array.isArray(f) && f.some(x => x.type === 'IMAGE')) return 'Media Block';
    }
  }

  const s = deepAnalyze(node);
  const { width: w, height: h } = s;
  const ar = s.aspectRatio; // w/h ratio
  const candidates: NameCandidate[] = [];
  const add = (name: string, score: number) => { if (score > 0) candidates.push({ name, score }); };

  // ═══════════════════════════════════════════════════════════════════════════
  // 1. NAVIGATION
  // ═══════════════════════════════════════════════════════════════════════════

  // Navbar — very wide horizontal bar, has logo, links, optional CTA
  {
    let sc = 0;
    if (s.isHorizontal && w > 600 && h < 100) sc += 45;
    if (s.hasLogo)                             sc += 40;
    if (s.textCount >= 2 && h < 80)           sc += 20;
    if (s.hasButton && s.hasLogo)             sc += 15;
    add('Navbar', sc);
  }

  // Tab Bar — 3–6 uniform horizontal items, each has icon + short text
  // Mobile bottom nav or desktop top tabs
  {
    let sc = 0;
    if (s.isHorizontal && s.childCount >= 3 && s.childCount <= 6 && s.childrenAreUniform) sc += 50;
    if (s.iconCount >= 2 && s.textCount >= 2 && h < 90)                                   sc += 35;
    if (!s.hasImage && !s.hasButton && !s.hasInput && ar > 2)                             sc += 15;
    add('Tab Bar', sc);
  }

  // Links — horizontal row of text-only links, no logo or images
  // Nav link groups, footer links, breadcrumb-style
  {
    let sc = 0;
    if (s.isHorizontal && s.textCount >= 2 && !s.hasLogo && !s.hasImage) sc += 40;
    if (s.iconCount === 0 && h < 48 && s.childCount >= 2)                sc += 30;
    if (s.childrenAreUniform && s.childCount >= 2)                       sc += 15;
    add('Links', sc);
  }

  // Sidebar — tall narrow vertical panel, usually has a list of nav items
  {
    let sc = 0;
    if (w < 320 && h > 400 && s.isVertical)                sc += 50;
    if (ar < 0.5 && s.textCount >= 3)                      sc += 30;
    if (s.iconCount >= 2 && s.textCount >= 2 && w < 300)   sc += 25;
    add('Sidebar', sc);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 2. FORMS & INPUTS
  // ═══════════════════════════════════════════════════════════════════════════

  // Search Bar — input with search icon, usually wide and short
  {
    let sc = 0;
    if (s.hasInput && s.iconCount >= 1 && h < 60 && w > 150) sc += 80;
    if (s.childCount <= 4 && h < 60)                          sc += 15;
    add('Search Bar', sc);
  }

  // Input — single text field alone (no icon pairing that makes it Search Bar)
  {
    let sc = 0;
    if (s.hasInput && w >= 150 && h < 80 && s.childCount <= 3) sc += 70;
    if (!s.hasButton && !s.hasImage)                             sc += 10;
    add('Input', sc);
  }

  // Form — 2+ stacked inputs, usually vertical, has submit button
  {
    let sc = 0;
    if (s.hasInput && s.isVertical && s.childCount >= 3)   sc += 65;
    if (s.hasButton && s.hasInput)                          sc += 20;
    if (s.hasCheckbox || s.hasDropdown || s.hasToggle)     sc += 15;
    add('Form', sc);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 3. STATS / METRICS
  // Large number + supporting label = stat tile (dashboard, landing page)
  // ═══════════════════════════════════════════════════════════════════════════

  {
    let sc = 0;
    if (s.hasLargeNumber && s.textCount >= 2)                      sc += 80;
    if (s.hasLargeNumber && s.labelCount >= 1)                     sc += 20;
    if (!s.hasImage && !s.hasButton && !s.hasInput && !s.hasAvatar) sc += 10;
    add('Stat', sc);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 4. MEDIA
  // ═══════════════════════════════════════════════════════════════════════════

  // Media Block — image fill with no or minimal text (banner, photo, illustration)
  {
    let sc = 0;
    if (s.hasImage && s.textCount === 0)  sc += 85;
    if (s.hasImage && s.textCount === 1)  sc += 40;
    if (!s.hasButton && !s.hasInput)      sc += 10;
    add('Media Block', sc);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 5. CARDS & ITEMS
  //
  // The key distinction:
  //   Card  = richer, more descendants, self-contained content unit
  //   Item  = compact row, fewer descendants, lives inside a list/card
  //
  // Both require image OR avatar. Icon alone ≠ card.
  // ═══════════════════════════════════════════════════════════════════════════

  // Profile / Testimonial Card — avatar + name + role/quote, richer nesting
  {
    let sc = 0;
    if (s.hasAvatar && s.headingCount >= 1 && s.textCount >= 2 && s.totalDescendants >= 4) sc += 85;
    if (s.hasAvatar && s.bodyCount >= 1)                                                    sc += 20;
    add('Card', sc);
  }

  // Card — image/avatar + text, enough descendants to be a real content unit
  {
    let sc = 0;
    if ((s.hasImage || s.hasAvatar) && s.textCount >= 1 && s.totalDescendants >= 4) sc += 80;
    if (s.headingCount >= 1 && (s.hasImage || s.hasAvatar))                         sc += 20;
    if (s.hasButton && (s.hasImage || s.hasAvatar))                                 sc += 15;
    add('Card', sc);
  }

  // Item — compact image/avatar + text row, few descendants (child of a list/card)
  {
    let sc = 0;
    if ((s.hasImage || s.hasAvatar) && s.textCount >= 1 && s.totalDescendants < 5) sc += 80;
    if (s.isHorizontal && h < 100)                                                  sc += 20;
    if (s.iconCount >= 1)                                                           sc += 10;
    // hard block — if rich enough to be a Card, don't be an Item
    if (s.totalDescendants >= 5 && s.headingCount >= 1 && s.bodyCount >= 1) sc = 0;
    add('Item', sc);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 6. LISTS & REPEATING PATTERNS
  // ═══════════════════════════════════════════════════════════════════════════

  // List — vertical stack of 3+ uniform child items
  {
    let sc = 0;
    if (s.isVertical && s.childCount >= 3 && s.childrenAreUniform) sc += 55;
    if (s.hasAvatar || s.iconCount >= 2)                           sc += 20;
    if (!s.hasButton && !s.hasInput)                               sc += 10;
    add('List', sc);
  }

  // List Item — single compact row: icon OR avatar + text, no image fill
  // The repeating unit inside a List
  {
    let sc = 0;
    if (!s.hasImage && s.iconCount >= 1 && s.textCount >= 1 && h < 80) sc += 75;
    if (!s.hasImage && s.hasAvatar && s.textCount >= 1 && h < 80)      sc += 70;
    if (s.isHorizontal && s.childCount >= 2 && s.childCount <= 6)      sc += 20;
    if (!s.hasButton && !s.hasInput && s.totalDescendants <= 8)        sc += 10;
    add('List Item', sc);
  }

  // Grid — horizontal or wrapping layout of 3+ uniform card-like children
  {
    let sc = 0;
    if (s.childCount >= 3 && s.childrenAreUniform && s.isHorizontal) sc += 50;
    if ((s.hasImage || s.hasAvatar) && s.childCount >= 3)            sc += 25;
    if (w > 500)                                                      sc += 10;
    add('Grid', sc);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 7. LABELS / BADGES / BUTTONS
  //
  // STRICT: NEVER fires when image or avatar is present.
  // Relies on word count — short text = label/badge/button.
  // ═══════════════════════════════════════════════════════════════════════════

  // Badge / Tag — tiny pill, 1–2 words, often colored background
  {
    let sc = 0;
    if (!s.hasImage && !s.hasAvatar && s.totalWordCount <= 2 && s.textCount === 1) {
      if (h < 32 && w < 120)  sc += 85; // tiny = badge/tag
      if (s.iconCount === 0)  sc += 10;
    }
    if (s.hasImage || s.hasAvatar) sc = 0;
    add('Badge', sc);
  }

  // Button — text + optional icon, medium size, interactive element
  {
    let sc = 0;
    if (!s.hasImage && !s.hasAvatar) {
      if (s.hasButton && h <= 56 && w <= 350)                          sc += 75;
      if (s.totalWordCount <= 4 && h <= 56 && s.iconCount <= 2)        sc += 40;
      if (s.textCount === 1 && h > 32 && h <= 56 && !s.hasInput)      sc += 20;
    }
    if (s.hasImage || s.hasAvatar) sc = 0;
    add('Button', sc);
  }

  // Label — short text (≤2 words) OR short text + icon. No image/avatar.
  // Catches pill labels, tags, small text+icon combos
  {
    let sc = 0;
    if (!s.hasImage && !s.hasAvatar) {
      if (s.totalWordCount <= 2 && s.iconCount >= 1 && s.childCount <= 4) sc += 70;
      if (s.totalWordCount <= 2 && s.iconCount === 0 && s.textCount >= 1 && h >= 32) sc += 55;
    }
    if (s.hasImage || s.hasAvatar) sc = 0;
    add('Label', sc);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 8. TEXT CONTENT BLOCKS
  // ═══════════════════════════════════════════════════════════════════════════

  // Feature — icon (not image) + heading + body paragraph
  // Classic "benefit tile" or "feature card" pattern
  {
    let sc = 0;
    if (s.iconCount >= 1 && s.headingCount >= 1 && !s.hasImage && !s.hasAvatar) sc += 65;
    if (s.bodyCount >= 1 && !s.hasImage)                                         sc += 25;
    if (s.isVertical && !s.hasInput && s.totalWordCount > 5)                    sc += 15;
    add('Feature', sc);
  }

  // Text Block — heading + body, pure text content, no icons, no media
  {
    let sc = 0;
    if (s.headingCount >= 1 && s.bodyCount >= 1 && !s.hasImage && s.iconCount === 0) sc += 70;
    if (s.headingCount >= 1 && s.labelCount >= 1 && !s.hasImage && s.iconCount === 0) sc += 40;
    if (!s.hasButton && !s.hasInput && !s.hasAvatar)                                  sc += 10;
    add('Text Block', sc);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 9. PAGE / LAYOUT LEVEL
  // ═══════════════════════════════════════════════════════════════════════════

  // Split Layout — 2 main children side by side: image on one, text on other
  {
    let sc = 0;
    if (s.hasImage && s.textCount >= 2 && s.childCount === 2 && s.isHorizontal) sc += 70;
    if (w > 500 && s.hasImage && s.headingCount >= 1 && s.bodyCount >= 1)       sc += 30;
    add('Split', sc);
  }

  // Hero — very wide, tall, has heading + body + optional button + optional image
  // Usually the top section of a landing page
  {
    let sc = 0;
    if (w > 600 && h > 250 && s.headingCount >= 1 && s.bodyCount >= 1) sc += 55;
    if (s.hasButton && s.headingCount >= 1 && w > 500)                  sc += 30;
    if (s.hasImage && h > 250)                                          sc += 15;
    add('Hero', sc);
  }

  // Section — page-level container, many descendants, wide, multiple content areas
  {
    let sc = 0;
    if (s.totalDescendants > 10 && s.childCount >= 2 && w > 400) sc += 45;
    if (s.headingCount >= 2 && s.childCount >= 3)                 sc += 25;
    if (w > 600 && s.childCount >= 3)                             sc += 20;
    add('Section', sc);
  }

  // Toolbar — horizontal bar of actions/icons, no logo, no big text
  // Think: editor toolbar, table action bar
  {
    let sc = 0;
    if (s.isHorizontal && s.iconCount >= 3 && h < 60 && !s.hasLogo) sc += 65;
    if (s.childCount >= 3 && !s.hasImage && !s.hasInput && h < 60)  sc += 20;
    add('Toolbar', sc);
  }

  // Action Bar — 2+ buttons in a row (dialog footer, form actions)
  {
    let sc = 0;
    if (s.hasButton && s.childCount >= 2 && s.isHorizontal && !s.hasImage) sc += 55;
    if (s.textCount <= 4 && !s.hasInput && h < 80)                          sc += 20;
    add('Action Bar', sc);
  }

  // Container — mixed content, too varied for a specific name
  {
    let sc = 0;
    if (s.iconCount >= 1 && s.hasImage && s.textCount >= 1)    sc += 40;
    if (s.childCount >= 3 && s.totalDescendants > 6)           sc += 20;
    if (w > 300 && !s.hasAutoLayout)                           sc += 10;
    add('Container', sc);
  }

  // Row / Column — pure layout wrappers with no meaningful content
  if (s.isHorizontal && s.textCount === 0 && s.iconCount === 0 && !s.hasImage && !s.hasAvatar) add('Row', 40);
  if (s.isVertical   && s.textCount === 0 && s.iconCount === 0 && !s.hasImage && !s.hasAvatar) add('Column', 40);

  // ── Pick winner ────────────────────────────────────────────────────────────
  candidates.sort((a, b) => b.score - a.score);
  const winner = candidates[0];

  if (!winner || winner.score < 25) {
    if (s.childCount === 0) return null;
    if (s.isHorizontal)    return 'Row';
    if (s.isVertical)      return 'Column';
    return 'Container';
  }

  return winner.name;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
/** Breadth-first collection of a node and all its namable descendants */
function collectTree(
  root: FrameNode | GroupNode | ComponentNode,
  result: Array<FrameNode | GroupNode | ComponentNode>
) {
  const queue: Array<FrameNode | GroupNode | ComponentNode> = [root];
  while (queue.length > 0) {
    const node = queue.shift()!;
    result.push(node);
    if ('children' in node) {
      for (const child of (node as ChildrenMixin).children) {
        if (isNamableNode(child)) {
          queue.push(child as FrameNode | GroupNode | ComponentNode);
        }
      }
    }
  }
}

function isNamableNode(node: BaseNode): boolean {
  return node.type === 'FRAME' || node.type === 'COMPONENT' || node.type === 'GROUP';
}

function isAutoName(name: string): boolean {
  return /^(Frame|Group|Component|Section|Rectangle|Ellipse|Polygon|Star|Vector|Line|Arrow)\s*\d*$/i.test(name.trim());
}

// ─── Health Scan Helper ──────────────────────────────────────────────────────
function sendHealthUpdate() {
  const allNodes = figma.currentPage.findAll(n => isNamableNode(n));
  const total = allNodes.length;
  const unnamed = allNodes.filter(n => isAutoName(n.name)).length;
  figma.ui.postMessage({ type: 'healthResult', total, unnamed });
}

async function saveSettings() {
  await figma.clientStorage.setAsync('settings', { isEnabled, useAI, apiKey });
}

// serializeNode — compact structural snapshot for AI prompt.
// Strips text content (we don't want AI using copy to name layers),
// buckets dimensions, limits depth to 3 and children to 10.
// Shorter JSON = fewer tokens = faster + cheaper Haiku calls.
function serializeNode(node: SceneNode, depth = 0): object {
  const result: any = {
    t: node.type[0] + (node.type[1] ?? ''),          // "FR", "TE", "VE", etc.
    w: Math.round(node.width / 5) * 5,               // bucket to 5px
    h: Math.round(node.height / 5) * 5,
  };
  if ('layoutMode' in node) {
    const lm = (node as FrameNode).layoutMode;
    if (lm !== 'NONE') result.l = lm[0];             // "H" or "V"
  }
  if ('fills' in node) {
    const fills = (node as GeometryMixin).fills as Paint[];
    if (Array.isArray(fills) && fills.some(f => f.type === 'IMAGE')) result.img = 1;
  }
  if (node.type === 'TEXT') {
    const t = node as TextNode;
    result.fs = typeof t.fontSize === 'number' ? Math.round(t.fontSize) : 14;
    result.fw = typeof t.fontWeight === 'number' ? t.fontWeight : 400;
    result.len = t.characters.trim().length;          // length only, no content
  }
  if ('children' in node && depth < 3) {
    const children = (node as ChildrenMixin).children.slice(0, 10);
    if (children.length) result.c = children.map((c: SceneNode) => serializeNode(c, depth + 1));
  }
  return result;
}

// ─── Claude Haiku — single frame, real-time rename ───────────────────────────
// Fast and cheap (~$0.0002). Used for real-time renaming when AI mode is on.
// Times out after 8s — frame stays as "Frame N" if no response.
async function callClaude(structure: object, nodeId: string): Promise<string | null> {
  return new Promise((resolve) => {
    const id = Math.random().toString(36).slice(2);
    const handler = (msg: any) => {
      if (msg.type === 'aiResponse' && msg.id === id) {
        figma.ui.off('message', handler);
        resolve(msg.name || null);
      }
    };
    figma.ui.on('message', handler as any);
    figma.ui.postMessage({ type: 'aiRequest', id, apiKey, structure, nodeId });
    setTimeout(() => { figma.ui.off('message', handler as any); resolve(null); }, 8000);
  });
}

// ─── Claude Sonnet — Fix Selected full-context rename ────────────────────────
// Used only by Fix Selected when AI mode is on.
// Collects the full serialized tree of the selected frame + all children,
// sends to Sonnet in one batch for maximum context and accuracy.
// Returns a map of nodeId → suggestedName.
async function callClaudeFixSelected(
  nodes: Array<{ id: string; parentId: string | null; depth: number; structure: object; currentName: string }>
): Promise<Map<string, string>> {
  return new Promise((resolve) => {
    const id = Math.random().toString(36).slice(2);
    const handler = (msg: any) => {
      if (msg.type === 'aiAnalyzeBatchResult' && msg.id === id) {
        figma.ui.off('message', handler);
        const map = new Map<string, string>();
        for (const [k, v] of Object.entries(msg.result || {})) {
          if (typeof v === 'string') map.set(k, v);
        }
        resolve(map);
      }
    };
    figma.ui.on('message', handler as any);
    figma.ui.postMessage({ type: 'aiAnalyzeBatch', id, apiKey, nodes });
    setTimeout(() => { figma.ui.off('message', handler as any); resolve(new Map()); }, 30000);
  });
}


// ─── Debug Mode ───────────────────────────────────────────────────────────────
// Enable via figma.clientStorage.setAsync('debug', true) in Figma console.
// Logs: node name → signals → score candidates → winner for every rename.
// Used for pre-launch testing against Material Design 3 / Atlassian / Apple HIG files.
let debugMode = false;
(async () => { debugMode = await figma.clientStorage.getAsync('debug') ?? false; })();

function debugLog(node: SceneNode, signals: NodeSignals, winner: string | null) {
  if (!debugMode) return;
  console.log(`[SmartRenamer] "${node.name}" →`, {
    winner,
    signals: {
      layout: signals.isHorizontal ? 'H' : signals.isVertical ? 'V' : 'none',
      size: `${Math.round(signals.width)}×${Math.round(signals.height)}`,
      text: `${signals.headingCount}h ${signals.bodyCount}b ${signals.labelCount}l`,
      media: `img:${signals.hasImage} avatar:${signals.hasAvatar}`,
      interactive: `btn:${signals.hasButton} input:${signals.hasInput}`,
      icons: signals.iconCount,
      children: signals.childCount,
      descendants: signals.totalDescendants,
      hints: signals.nameHints.slice(0, 8).join(', '),
    }
  });
}
