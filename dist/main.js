"use strict";
(() => {
  var __defProp = Object.defineProperty;
  var __defProps = Object.defineProperties;
  var __getOwnPropDescs = Object.getOwnPropertyDescriptors;
  var __getOwnPropSymbols = Object.getOwnPropertySymbols;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __propIsEnum = Object.prototype.propertyIsEnumerable;
  var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
  var __spreadValues = (a, b) => {
    for (var prop in b || (b = {}))
      if (__hasOwnProp.call(b, prop))
        __defNormalProp(a, prop, b[prop]);
    if (__getOwnPropSymbols)
      for (var prop of __getOwnPropSymbols(b)) {
        if (__propIsEnum.call(b, prop))
          __defNormalProp(a, prop, b[prop]);
      }
    return a;
  };
  var __spreadProps = (a, b) => __defProps(a, __getOwnPropDescs(b));

  // src/main.ts
  var isEnabled = true;
  var useAI = false;
  var apiKey = "";
  var debounceMap = /* @__PURE__ */ new Map();
  var aiCache = /* @__PURE__ */ new Map();
  var localCache = /* @__PURE__ */ new Map();
  var structureSnapshot = /* @__PURE__ */ new Map();
  var pendingAnalyzeNodes = /* @__PURE__ */ new Map();
  var pendingAnalyzeTotal = 0;
  function structuralFingerprint(node) {
    var _a;
    const n = node;
    const layout = (_a = n.layoutMode) != null ? _a : "NONE";
    const w = Math.round(node.width / 20) * 20;
    const h = Math.round(node.height / 20) * 20;
    const childCount = "children" in node ? node.children.length : 0;
    const childTypes = "children" in node ? node.children.slice(0, 6).map((c) => c.type[0]).join("") : "";
    const ar = node.height > 0 ? node.width / node.height > 2 ? "W" : node.width / node.height < 0.5 ? "T" : "S" : "S";
    return `${layout}|${w}x${h}|${ar}|${childCount}|${childTypes}`;
  }
  var command = figma.command;
  var needsUI = !command || command === "open";
  figma.showUI(__html__, {
    width: 320,
    height: 560,
    title: "AI Realtime Renamer",
    visible: needsUI
  });
  (async () => {
    var _a, _b, _c;
    await figma.loadAllPagesAsync();
    const saved = await figma.clientStorage.getAsync("settings");
    if (saved) {
      isEnabled = (_a = saved.isEnabled) != null ? _a : true;
      useAI = (_b = saved.useAI) != null ? _b : false;
      apiKey = (_c = saved.apiKey) != null ? _c : "";
    }
    const savedLog = await figma.clientStorage.getAsync("renameLog");
    if (savedLog && Array.isArray(savedLog)) {
      figma.ui.postMessage({ type: "restoreLog", log: savedLog });
    }
    if (command && command !== "open") {
      await handleMenuCommand(command);
      return;
    }
    figma.ui.postMessage({ type: "init", isEnabled, useAI, hasApiKey: !!apiKey });
  })();
  async function handleMenuCommand(cmd) {
    if (cmd === "renameSelected") {
      const selection = figma.currentPage.selection;
      if (!selection.length) {
        figma.notify("Nothing selected \u2014 select a frame first.");
        figma.closePlugin();
        return;
      }
      let count = 0;
      for (const node of selection) {
        if (isNamableNode(node)) {
          const name = await getNameForNode(node);
          if (name && name !== node.name) {
            node.name = name;
            count++;
          }
        }
      }
      figma.notify(count > 0 ? `\u2713 Renamed ${count} layer${count !== 1 ? "s" : ""}` : "Name already looks good \u2713");
      figma.closePlugin();
    } else if (cmd === "fixSelected") {
      const selection = figma.currentPage.selection;
      if (!selection.length) {
        figma.notify("Nothing selected \u2014 select a frame first.");
        figma.closePlugin();
        return;
      }
      let count = 0;
      for (const node of selection) {
        if (!isNamableNode(node)) continue;
        const allNodes = [];
        collectTree(node, allNodes);
        for (const n of allNodes) {
          const suggested = analyzeNode(n);
          if (suggested && suggested !== n.name) {
            n.name = suggested;
            count++;
          }
        }
      }
      figma.notify(count > 0 ? `\u2713 Fixed ${count} layer${count !== 1 ? "s" : ""} in tree` : "Tree already looks good \u2713");
      figma.closePlugin();
    } else if (cmd === "renamePage") {
      const nodes = figma.currentPage.findAll((n) => isNamableNode(n) && isAutoName(n.name));
      let count = 0;
      for (const n of nodes) {
        const suggested = analyzeNode(n);
        if (suggested && suggested !== n.name) {
          n.name = suggested;
          count++;
        }
      }
      figma.notify(count > 0 ? `\u2713 Renamed ${count} layer${count !== 1 ? "s" : ""} on page` : "Page already clean \u2713");
      figma.closePlugin();
    } else if (cmd === "healthCheck") {
      const allNodes = figma.currentPage.findAll((n) => isNamableNode(n));
      const total = allNodes.length;
      const unnamed = allNodes.filter((n) => isAutoName(n.name)).length;
      const pct = total > 0 ? Math.round((total - unnamed) / total * 100) : 100;
      figma.notify(
        unnamed === 0 ? `\u2713 All ${total} layers are clean!` : `\u26A0 ${unnamed} of ${total} layers need renaming (${pct}% clean)`,
        { timeout: 4e3 }
      );
      figma.closePlugin();
    } else {
      figma.ui.postMessage({ type: "init", isEnabled, useAI, hasApiKey: !!apiKey });
    }
  }
  figma.ui.onmessage = async (msg) => {
    var _a, _b;
    if (msg.type === "toggle") {
      isEnabled = msg.value;
      await saveSettings();
    }
    if (msg.type === "toggleAI") {
      useAI = msg.value;
      await saveSettings();
    }
    if (msg.type === "setApiKey") {
      apiKey = msg.value;
      await saveSettings();
      figma.ui.postMessage({ type: "status", text: apiKey ? "\u{1F511} API key saved \u2014 AI mode enabled \u2713" : "API key cleared" });
    }
    if (msg.type === "getApiKey") {
      figma.ui.postMessage({ type: "apiKeyForTest", apiKey });
    }
    if (msg.type === "renameSelected") {
      const selection = figma.currentPage.selection;
      if (!selection.length) {
        figma.ui.postMessage({ type: "status", text: "Nothing selected." });
        return;
      }
      let count = 0;
      for (const node of selection) {
        if (isNamableNode(node)) {
          const name = await getNameForNode(node);
          if (name) {
            node.name = name;
            count++;
          }
        }
      }
      figma.ui.postMessage({ type: "status", text: `Renamed ${count} layer${count !== 1 ? "s" : ""} \u2713` });
    }
    if (msg.type === "fixSelected") {
      const selection = figma.currentPage.selection;
      if (!selection.length) {
        figma.notify("Nothing selected \u2014 please select a layer first.", { timeout: 3e3 });
        figma.ui.postMessage({ type: "analyzeDone" });
        return;
      }
      if (!useAI || !apiKey) {
        let count2 = 0;
        for (const node of selection) {
          if (!isNamableNode(node)) continue;
          const suggested = analyzeNode(node);
          if (suggested && suggested !== node.name) {
            const prevName = node.name;
            node.name = suggested;
            figma.ui.postMessage({ type: "renamed", layerName: suggested, prevName, nodeId: node.id, ai: false });
            count2++;
          }
        }
        figma.ui.postMessage({
          type: "status",
          text: count2 === 0 ? "Name is already accurate \u2713" : `Updated ${count2} layer${count2 !== 1 ? "s" : ""} \u2713`
        });
        return;
      }
      figma.ui.postMessage({ type: "status", text: "Analyzing with Claude Sonnet\u2026" });
      figma.ui.postMessage({ type: "aiThinking", value: true });
      const allNodes = [];
      for (const root of selection) {
        if (!isNamableNode(root)) continue;
        const queue = [{ node: root, parentId: null, depth: 0 }];
        while (queue.length) {
          const { node, parentId, depth } = queue.shift();
          allNodes.push({ node, parentId, depth });
          if ("children" in node) {
            for (const child of node.children) {
              if (isNamableNode(child)) {
                queue.push({ node: child, parentId: node.id, depth: depth + 1 });
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
        structure: serializeNode(node)
      }));
      const nameMap = await callClaudeFixSelected(batchPayload);
      figma.ui.postMessage({ type: "aiThinking", value: false });
      let count = 0;
      for (const { node } of allNodes) {
        const suggested = nameMap.get(node.id);
        if (suggested && suggested !== node.name) {
          const prevName = node.name;
          node.name = suggested;
          figma.ui.postMessage({ type: "renamed", layerName: suggested, prevName, nodeId: node.id, ai: true });
          count++;
        }
      }
      figma.ui.postMessage({
        type: "status",
        text: count === 0 ? "All names look accurate \u2713" : `Renamed ${count} layer${count !== 1 ? "s" : ""} with Sonnet \u2713`
      });
    }
    if (msg.type === "renameAll") {
      const nodes = figma.currentPage.findAll((n) => isNamableNode(n) && isAutoName(n.name));
      const results = await Promise.all(
        nodes.map(async (n) => ({
          node: n,
          name: await getNameForNode(n)
        }))
      );
      let count = 0;
      for (const { node, name } of results) {
        if (name && name !== node.name) {
          node.name = name;
          count++;
        }
      }
      figma.ui.postMessage({ type: "renameAllDone" });
      figma.ui.postMessage({ type: "status", text: `Renamed ${count} layer${count !== 1 ? "s" : ""} \u2713` });
    }
    if (msg.type === "renameTree") {
      const selection = figma.currentPage.selection;
      if (!selection.length) {
        figma.ui.postMessage({ type: "status", text: "Select a frame first." });
        return;
      }
      let count = 0;
      const renamed = [];
      for (const root of selection) {
        if (!isNamableNode(root)) continue;
        const allNodes = [];
        collectTree(root, allNodes);
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
        figma.ui.postMessage({ type: "renamed", layerName: r.name, prevName: r.prevName, nodeId: r.nodeId, ai: false });
      }
      figma.ui.postMessage({
        type: "status",
        text: count > 0 ? `Renamed ${count} layer${count !== 1 ? "s" : ""} \u2713` : "All layers already accurate \u2713"
      });
    }
    if (msg.type === "focusNode") {
      const node = await figma.getNodeByIdAsync(msg.nodeId);
      if (node && "visible" in node) {
        figma.currentPage.selection = [node];
        figma.viewport.scrollAndZoomIntoView([node]);
      }
    }
    if (msg.type === "contextAnalyze") {
      let gatherText2 = function(node) {
        if (node.type === "TEXT") {
          const chars = node.characters.trim();
          if (chars && chars.length > 0 && chars.length < 200 && !seen.has(chars)) {
            seen.add(chars);
            textSamples.push(chars);
          }
        }
        if ("children" in node) {
          for (const child of node.children) gatherText2(child);
        }
      };
      var gatherText = gatherText2;
      const selection = figma.currentPage.selection;
      if (!selection.length || !isNamableNode(selection[0])) {
        figma.ui.postMessage({ type: "contextProgress", text: "\u2717 Select a Frame or Component first" });
        return;
      }
      const root = selection[0];
      figma.ui.postMessage({ type: "contextProgress", text: "Collecting layers\u2026" });
      const allNodes = [];
      collectTree(root, allNodes);
      const textSamples = [];
      const seen = /* @__PURE__ */ new Set();
      gatherText2(root);
      const nodeList = allNodes.slice(0, 80).map((n) => {
        var _a2;
        const par = allNodes.find(
          (p) => "children" in p && p.children.some((c) => c.id === n.id)
        );
        return {
          id: n.id,
          parentId: (_a2 = par == null ? void 0 : par.id) != null ? _a2 : null,
          depth: 0,
          structure: serializeNode(n),
          currentName: n.name
        };
      });
      figma.ui.postMessage({
        type: "contextNodes",
        nodes: nodeList,
        textSamples: textSamples.slice(0, 60),
        screenName: root.name,
        screenNodeId: root.id,
        scanOnly: !!msg.scanOnly
      });
      const saved = await figma.clientStorage.getAsync("settings");
      figma.ui.postMessage({ type: "apiKeyForContext", apiKey: (saved == null ? void 0 : saved.apiKey) || "" });
    }
    if (msg.type === "contextApplyNames") {
      const names = msg.names || {};
      let count = 0;
      for (const [id, name] of Object.entries(names)) {
        const node = await figma.getNodeByIdAsync(id);
        if (node && isNamableNode(node) && typeof name === "string" && name.trim()) {
          const prevName = node.name;
          node.name = name.trim();
          figma.ui.postMessage({ type: "renamed", layerName: name.trim(), prevName, nodeId: id, ai: true });
          count++;
        }
      }
      if (count > 0) figma.notify(`\u2713 Context renamed ${count} layers`, { timeout: 2500 });
    }
    if (msg.type === "contextBuildDocFrame") {
      const { doc, stats, screenName, screenNodeId } = msg;
      if (!doc) return;
      try {
        let addText2 = function(parent, str, x, y2, w, size, weight, color, lineH = 0) {
          if (!str.trim()) return y2;
          const t = figma.createText();
          t.fontName = { family: "Inter", style: weight };
          t.fontSize = size;
          t.characters = str;
          t.fills = [{ type: "SOLID", color }];
          if (lineH > 0) t.lineHeight = { value: lineH, unit: "PIXELS" };
          t.textAutoResize = "HEIGHT";
          t.resizeWithoutConstraints(w, 20);
          t.x = x;
          t.y = y2;
          parent.appendChild(t);
          return y2 + t.height;
        }, addRect2 = function(parent, x, y2, w, h, color, opacity = 1, radius = 0) {
          const r = figma.createRectangle();
          r.resize(w, h);
          r.fills = [{ type: "SOLID", color, opacity }];
          r.cornerRadius = radius;
          r.x = x;
          r.y = y2;
          parent.appendChild(r);
          return r;
        };
        var addText = addText2, addRect = addRect2;
        const screenNode = screenNodeId ? await figma.getNodeByIdAsync(screenNodeId) : null;
        const GAP = 80;
        const DOC_W = screenNode ? Math.max(screenNode.width, 600) : 720;
        const screenX = screenNode ? screenNode.absoluteTransform[0][2] : 0;
        const screenY = screenNode ? screenNode.absoluteTransform[1][2] : 0;
        const PAD = 36;
        const IW = DOC_W - PAD * 2;
        await figma.loadFontAsync({ family: "Inter", style: "Regular" });
        await figma.loadFontAsync({ family: "Inter", style: "Medium" });
        await figma.loadFontAsync({ family: "Inter", style: "Bold" });
        const BG = { r: 0.09, g: 0.09, b: 0.11 };
        const SURFACE = { r: 0.13, g: 0.13, b: 0.16 };
        const BORDER = { r: 0.2, g: 0.2, b: 0.24 };
        const ACCENT = { r: 0.48, g: 0.38, b: 1 };
        const CYAN = { r: 0, g: 0.76, b: 1 };
        const GREEN = { r: 0.2, g: 0.78, b: 0.35 };
        const ORANGE = { r: 1, g: 0.55, b: 0.26 };
        const TPRI = { r: 0.94, g: 0.94, b: 0.96 };
        const TSUB = { r: 0.6, g: 0.6, b: 0.64 };
        const TMUT = { r: 0.38, g: 0.38, b: 0.42 };
        const SEC_ACCENTS = [ACCENT, GREEN, ORANGE];
        const sections = [];
        const parts = doc.split(/(?=## )/);
        for (const p of parts) {
          const nl = p.indexOf("\n");
          if (nl === -1) continue;
          const title = p.slice(p.startsWith("## ") ? 3 : 0, nl).trim();
          const body = p.slice(nl + 1).trim();
          if (title && body) sections.push({ title, body });
        }
        if (sections.length === 0) {
          sections.push({ title: "Documentation", body: doc.trim() });
        }
        let curY = 0;
        curY += 4;
        curY += 4 + 22 + 10 + 36 + 10 + 32 + 56;
        curY += 1;
        for (const sec of sections) {
          curY += 28;
          curY += 20;
          curY += 12;
          const lines2 = sec.body.split("\n").filter((l) => l.trim());
          curY += 32;
          curY += lines2.length * 22;
          curY += 12;
        }
        curY += 1 + 44;
        const doc2 = figma.createFrame();
        doc2.name = `\u{1F4C4} ${screenName} \u2014 Documentation`;
        doc2.fills = [{ type: "SOLID", color: BG }];
        doc2.cornerRadius = 16;
        doc2.clipsContent = true;
        doc2.resize(DOC_W, Math.max(curY, 400));
        doc2.strokes = [{ type: "SOLID", color: BORDER }];
        doc2.strokeWeight = 1;
        doc2.strokeAlign = "INSIDE";
        let y = 0;
        const topBar = figma.createRectangle();
        topBar.resize(DOC_W, 4);
        topBar.fills = [{
          type: "GRADIENT_LINEAR",
          gradientTransform: [[1, 0, 0], [0, 1, 0]],
          gradientStops: [
            { position: 0, color: __spreadProps(__spreadValues({}, ACCENT), { a: 1 }) },
            { position: 1, color: __spreadProps(__spreadValues({}, CYAN), { a: 1 }) }
          ]
        }];
        topBar.x = 0;
        topBar.y = 0;
        doc2.appendChild(topBar);
        y += 4;
        const hdrBg = addRect2(doc2, 0, y, DOC_W, 130, BG);
        void hdrBg;
        y += 28;
        const pillBg = figma.createRectangle();
        pillBg.resize(184, 22);
        pillBg.fills = [{ type: "SOLID", color: ACCENT, opacity: 0.14 }];
        pillBg.cornerRadius = 11;
        pillBg.x = PAD;
        pillBg.y = y;
        doc2.appendChild(pillBg);
        const pillT = figma.createText();
        pillT.fontName = { family: "Inter", style: "Bold" };
        pillT.fontSize = 9;
        pillT.characters = "SCREEN DOCUMENTATION";
        pillT.fills = [{ type: "SOLID", color: ACCENT }];
        pillT.letterSpacing = { value: 1.2, unit: "PIXELS" };
        pillT.textAutoResize = "HEIGHT";
        pillT.resizeWithoutConstraints(164, 12);
        pillT.x = PAD + 10;
        pillT.y = y + 5;
        doc2.appendChild(pillT);
        y += 30;
        const h1 = figma.createText();
        h1.fontName = { family: "Inter", style: "Bold" };
        h1.fontSize = 24;
        h1.characters = screenName;
        h1.fills = [{ type: "SOLID", color: TPRI }];
        h1.lineHeight = { value: 32, unit: "PIXELS" };
        h1.textAutoResize = "HEIGHT";
        h1.resizeWithoutConstraints(IW, 30);
        h1.x = PAD;
        h1.y = y;
        doc2.appendChild(h1);
        y += h1.height + 14;
        const chipDefs = [
          { label: `${stats.totalLayers} layers renamed`, color: ACCENT },
          { label: `${stats.components} components`, color: GREEN },
          { label: `${stats.interactions} interactions`, color: ORANGE }
        ];
        let chipX = PAD;
        for (const cd of chipDefs) {
          const cw = cd.label.length * 7 + 32;
          const chipBg = figma.createRectangle();
          chipBg.resize(cw, 28);
          chipBg.fills = [{ type: "SOLID", color: SURFACE }];
          chipBg.cornerRadius = 7;
          chipBg.strokes = [{ type: "SOLID", color: BORDER }];
          chipBg.strokeWeight = 1;
          chipBg.strokeAlign = "INSIDE";
          chipBg.x = chipX;
          chipBg.y = y;
          doc2.appendChild(chipBg);
          const dot = figma.createEllipse();
          dot.resize(5, 5);
          dot.fills = [{ type: "SOLID", color: cd.color }];
          dot.x = chipX + 10;
          dot.y = y + 11;
          doc2.appendChild(dot);
          const ct = figma.createText();
          ct.fontName = { family: "Inter", style: "Medium" };
          ct.fontSize = 11;
          ct.characters = cd.label;
          ct.fills = [{ type: "SOLID", color: TSUB }];
          ct.textAutoResize = "WIDTH_AND_HEIGHT";
          ct.x = chipX + 21;
          ct.y = y + 6;
          doc2.appendChild(ct);
          chipX += cw + 8;
        }
        y += 28 + 28;
        hdrBg.resize(DOC_W, y - 4);
        addRect2(doc2, 0, y, DOC_W, 1, BORDER);
        y += 1;
        for (let si = 0; si < sections.length; si++) {
          const sec = sections[si];
          const accent = SEC_ACCENTS[si % SEC_ACCENTS.length];
          y += 28;
          addRect2(doc2, PAD, y + 1, 3, 16, accent, 1, 2);
          addText2(doc2, sec.title.toUpperCase(), PAD + 13, y, IW - 14, 10, "Bold", accent, 16);
          y += 24;
          const cardBg = figma.createRectangle();
          cardBg.resize(IW, 20);
          cardBg.fills = [{ type: "SOLID", color: SURFACE }];
          cardBg.cornerRadius = 10;
          cardBg.strokes = [{ type: "SOLID", color: BORDER }];
          cardBg.strokeWeight = 1;
          cardBg.strokeAlign = "INSIDE";
          cardBg.x = PAD;
          cardBg.y = y;
          doc2.appendChild(cardBg);
          const cardTop = y;
          y += 16;
          const rawLines = sec.body.split("\n");
          for (const rawLine of rawLines) {
            const trimmed = rawLine.trim();
            if (!trimmed) continue;
            const isBullet = /^[-•*]/.test(trimmed);
            const text = isBullet ? trimmed.replace(/^[-•*]\s*/, "") : trimmed;
            if (isBullet) {
              const dot2 = figma.createEllipse();
              dot2.resize(4, 4);
              dot2.fills = [{ type: "SOLID", color: accent, opacity: 0.8 }];
              dot2.x = PAD + 16;
              dot2.y = y + 6;
              doc2.appendChild(dot2);
              const bt = figma.createText();
              bt.fontName = { family: "Inter", style: "Regular" };
              bt.fontSize = 12;
              bt.characters = text;
              bt.fills = [{ type: "SOLID", color: TSUB }];
              bt.lineHeight = { value: 19, unit: "PIXELS" };
              bt.textAutoResize = "HEIGHT";
              bt.resizeWithoutConstraints(IW - 46, 18);
              bt.x = PAD + 27;
              bt.y = y;
              doc2.appendChild(bt);
              y += bt.height + 6;
            } else {
              const pt = figma.createText();
              pt.fontName = { family: "Inter", style: "Regular" };
              pt.fontSize = 12;
              pt.characters = text;
              pt.fills = [{ type: "SOLID", color: TSUB }];
              pt.lineHeight = { value: 19, unit: "PIXELS" };
              pt.textAutoResize = "HEIGHT";
              pt.resizeWithoutConstraints(IW - 32, 18);
              pt.x = PAD + 16;
              pt.y = y;
              doc2.appendChild(pt);
              y += pt.height + 6;
            }
          }
          y += 16;
          cardBg.resize(IW, y - cardTop);
          if (si < sections.length - 1) {
            y += 12;
            addRect2(doc2, PAD, y, IW, 1, BORDER, 0.5);
            y += 1;
          }
        }
        y += 28;
        addRect2(doc2, 0, y, DOC_W, 1, BORDER);
        y += 1 + 14;
        const now = /* @__PURE__ */ new Date();
        const ds = now.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
        addText2(doc2, `Generated by AI Realtime Renamer  \xB7  ${ds}`, PAD, y, IW, 10, "Regular", TMUT, 16);
        y += 30;
        doc2.resize(DOC_W, y);
        figma.currentPage.appendChild(doc2);
        doc2.x = screenX;
        doc2.y = screenY - y - GAP;
        figma.viewport.scrollAndZoomIntoView([doc2]);
        figma.notify(`\u2713 Documentation frame created above "${screenName}"`, { timeout: 3e3 });
        figma.ui.postMessage({
          type: "contextSummary",
          totalLayers: stats.totalLayers,
          components: stats.components,
          interactions: stats.interactions,
          screenName
        });
      } catch (err) {
        figma.notify(`\u26A0 Doc frame error: ${(err == null ? void 0 : err.message) || err}`, { timeout: 4e3 });
        figma.ui.postMessage({ type: "contextSummary", totalLayers: 0, components: 0, interactions: 0, screenName: "" });
      }
    }
    if (msg.type === "analyzeRename") {
      const selection = figma.currentPage.selection;
      if (!selection.length) {
        figma.notify("Select a frame first \u2014 Scan Nested Layers needs a starting point.", { timeout: 3e3 });
        figma.ui.postMessage({ type: "analyzeDone" });
        return;
      }
      const allNodes = [];
      for (const root of selection) {
        if (!isNamableNode(root)) continue;
        const queue = [{ node: root, parentId: null, depth: 0 }];
        while (queue.length) {
          const { node, parentId, depth } = queue.shift();
          allNodes.push({ node, parentId, depth });
          if ("children" in node) {
            for (const child of node.children) {
              if (isNamableNode(child)) {
                queue.push({ node: child, parentId: node.id, depth: depth + 1 });
              }
            }
          }
        }
      }
      const total = allNodes.length;
      if (useAI && apiKey) {
        let gatherTxt2 = function(n) {
          if (n.type === "TEXT") {
            const ch = n.characters.trim();
            if (ch && ch.length < 200 && !seenTxt.has(ch)) {
              seenTxt.add(ch);
              textSamples.push(ch);
            }
          }
          if ("children" in n) for (const c of n.children) gatherTxt2(c);
        };
        var gatherTxt = gatherTxt2;
        const root = selection[0];
        const textSamples = [];
        const seenTxt = /* @__PURE__ */ new Set();
        gatherTxt2(root);
        const nodeList = allNodes.slice(0, 80).map(({ node, parentId, depth }) => ({
          id: node.id,
          parentId,
          depth,
          currentName: node.name,
          structure: serializeNode(node)
        }));
        pendingAnalyzeNodes.clear();
        for (const { node } of allNodes) pendingAnalyzeNodes.set(node.id, node);
        pendingAnalyzeTotal = total;
        figma.ui.postMessage({
          type: "contextNodes",
          nodes: nodeList,
          textSamples: textSamples.slice(0, 60),
          screenName: root.name,
          screenNodeId: root.id,
          fromScan: true
          // signals UI to use scanApplyNames instead of contextApplyNames
        });
        figma.ui.postMessage({ type: "apiKeyForContext", apiKey });
      } else {
        const renamed = [];
        let count = 0;
        for (let i = 0; i < allNodes.length; i++) {
          const { node } = allNodes[i];
          const fp = structuralFingerprint(node);
          let suggested = localCache.get(fp);
          if (!suggested) {
            suggested = (_a = analyzeNode(node)) != null ? _a : void 0;
            if (suggested) localCache.set(fp, suggested);
          }
          if (i % 5 === 0 || i === allNodes.length - 1) {
            figma.ui.postMessage({ type: "analyzeProgress", text: `${i + 1} / ${total}` });
          }
          if (suggested && suggested !== node.name) {
            const prevName = node.name;
            node.name = suggested;
            count++;
            renamed.push({ name: suggested, prevName, nodeId: node.id });
          }
        }
        for (const r of renamed) {
          figma.ui.postMessage({ type: "renamed", layerName: r.name, prevName: r.prevName, nodeId: r.nodeId, ai: false });
        }
        figma.ui.postMessage({ type: "analyzeDone" });
        figma.ui.postMessage({
          type: "status",
          text: count > 0 ? `Renamed ${count} of ${total} layers \u2713` : `All ${total} layers already named \u2713`
        });
      }
    }
    if (msg.type === "aiAnalyzeBatchResult" && !msg.id) {
      const result = msg.result || {};
      const renamed = [];
      let count = 0;
      let i = 0;
      const total = pendingAnalyzeTotal;
      for (const [nodeId, suggestedName] of Object.entries(result)) {
        const node = pendingAnalyzeNodes.get(nodeId);
        i++;
        figma.ui.postMessage({ type: "analyzeProgress", text: `${i} / ${total}` });
        if (node && suggestedName && suggestedName !== node.name) {
          const prevName = node.name;
          node.name = suggestedName;
          count++;
          renamed.push({ name: suggestedName, prevName, nodeId: node.id });
        }
      }
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
        figma.ui.postMessage({ type: "renamed", layerName: r.name, prevName: r.prevName, nodeId: r.nodeId, ai: true });
      }
      figma.ui.postMessage({ type: "analyzeDone" });
      figma.ui.postMessage({
        type: "status",
        text: count > 0 ? `AI analyzed & renamed ${count} of ${total} layers \u2713` : `All ${total} layers already accurate \u2713`
      });
      pendingAnalyzeNodes.clear();
      pendingAnalyzeTotal = 0;
    }
    if (msg.type === "scanApplyNames") {
      const names = msg.names || {};
      let count = 0;
      const total2 = Object.keys(names).length;
      for (const [id, nameStr] of Object.entries(names)) {
        if (typeof nameStr !== "string" || !nameStr.trim()) continue;
        const clean = nameStr.trim();
        const node = (_b = pendingAnalyzeNodes.get(id)) != null ? _b : await figma.getNodeByIdAsync(id);
        if (node && isNamableNode(node)) {
          const prevName = node.name;
          if (prevName !== clean) {
            node.name = clean;
            figma.ui.postMessage({ type: "renamed", layerName: clean, prevName, nodeId: id, ai: true });
            count++;
          }
        }
      }
      pendingAnalyzeNodes.clear();
      pendingAnalyzeTotal = 0;
      figma.ui.postMessage({ type: "analyzeDone" });
      figma.ui.postMessage({
        type: "status",
        text: count > 0 ? `Context renamed ${count} of ${total2} layers \u2713` : "All layers already named accurately \u2713"
      });
    }
    if (msg.type === "checkSelection") {
      const sel = figma.currentPage.selection;
      if (!sel.length || !isNamableNode(sel[0])) {
        figma.notify("Please select a frame or layer first", { timeout: 2500 });
      } else {
        figma.ui.postMessage({ type: "checkSelectionOk", then: msg.then });
      }
    }
    if (msg.type === "healthScan") {
      sendHealthUpdate();
    }
    if (msg.type === "pointLayers") {
      const unnamed = figma.currentPage.findAll((n) => isNamableNode(n) && isAutoName(n.name));
      if (unnamed.length) {
        figma.currentPage.selection = unnamed;
        figma.viewport.scrollAndZoomIntoView(unnamed);
        figma.ui.postMessage({ type: "status", text: `Pointing to ${unnamed.length} unnamed layer${unnamed.length !== 1 ? "s" : ""} \u2197` });
      } else {
        figma.ui.postMessage({ type: "status", text: "No unnamed layers found \u2713" });
      }
    }
    if (msg.type === "saveLog") {
      await figma.clientStorage.setAsync("renameLog", msg.log);
    }
    if (msg.type === "resize") {
      figma.ui.resize(msg.width, msg.height);
    }
  };
  var STRUCTURAL_PROPS = /* @__PURE__ */ new Set([
    "width",
    "height",
    "layoutMode",
    "itemSpacing",
    "paddingTop",
    "paddingBottom",
    "paddingLeft",
    "paddingRight",
    "children",
    "characters",
    "fontSize",
    "fontWeight"
  ]);
  figma.on("documentchange", async (event) => {
    var _a;
    if (!isEnabled) return;
    const toEvaluate = /* @__PURE__ */ new Set();
    for (const change of event.documentChanges) {
      if (change.type !== "CREATE" && change.type !== "PROPERTY_CHANGE") continue;
      if (change.type === "PROPERTY_CHANGE") {
        const hasStructural = (_a = change.properties) == null ? void 0 : _a.some(
          (p) => STRUCTURAL_PROPS.has(p)
        );
        if (change.properties && !hasStructural) continue;
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
  var pendingAIRenames = /* @__PURE__ */ new Map();
  function scheduleRename(nodeId) {
    if (debounceMap.has(nodeId)) clearTimeout(debounceMap.get(nodeId));
    const timeout = setTimeout(async () => {
      debounceMap.delete(nodeId);
      const node = await figma.getNodeByIdAsync(nodeId);
      if (!node || !isNamableNode(node)) return;
      if (!isAutoName(node.name)) return;
      const typedNode = node;
      const fp = structuralFingerprint(typedNode);
      if (structureSnapshot.get(nodeId) === fp && !isAutoName(node.name)) return;
      if (!useAI || !apiKey) {
        const cached = localCache.get(fp);
        if (cached) {
          if (cached !== node.name) {
            const prevName = node.name;
            node.name = cached;
            structureSnapshot.set(nodeId, fp);
            figma.ui.postMessage({ type: "renamed", layerName: cached, prevName, nodeId, ai: false });
          }
          return;
        }
        const suggested = analyzeNode(typedNode);
        if (suggested) {
          localCache.set(fp, suggested);
          if (suggested !== node.name) {
            const prevName = node.name;
            node.name = suggested;
            structureSnapshot.set(nodeId, fp);
            figma.ui.postMessage({ type: "renamed", layerName: suggested, prevName, nodeId, ai: false });
          }
        }
        return;
      }
      if (pendingAIRenames.has(nodeId)) return;
      const aiCached = aiCache.get(fp);
      if (aiCached) {
        if (aiCached !== node.name) {
          const prevName = node.name;
          node.name = aiCached;
          structureSnapshot.set(nodeId, fp);
          figma.ui.postMessage({ type: "renamed", layerName: aiCached, prevName, nodeId, ai: true });
        }
        return;
      }
      const aiPromise = (async () => {
        try {
          figma.ui.postMessage({ type: "aiThinking", value: true });
          const structure = serializeNode(typedNode);
          const aiName = await callClaude(structure, nodeId);
          figma.ui.postMessage({ type: "aiThinking", value: false });
          if (aiName) {
            aiCache.set(fp, aiName);
            const freshNode = await figma.getNodeByIdAsync(nodeId);
            if (freshNode && isNamableNode(freshNode)) {
              const prevName = freshNode.name;
              freshNode.name = aiName;
              structureSnapshot.set(nodeId, fp);
              if (prevName !== aiName) {
                figma.ui.postMessage({ type: "renamed", layerName: aiName, prevName, nodeId, ai: true });
              }
            }
          }
        } catch (e) {
          figma.ui.postMessage({ type: "aiThinking", value: false });
        } finally {
          pendingAIRenames.delete(nodeId);
        }
      })();
      pendingAIRenames.set(nodeId, aiPromise);
    }, 350);
    debounceMap.set(nodeId, timeout);
  }
  function findNamableAncestor(node) {
    let current = node.parent;
    while (current) {
      if (isNamableNode(current) && isAutoName(current.name)) {
        return current;
      }
      if (current.type === "PAGE") break;
      current = current.parent;
    }
    return null;
  }
  async function getNameForNode(node) {
    const fp = structuralFingerprint(node);
    if (!useAI || !apiKey) {
      const cached2 = localCache.get(fp);
      if (cached2) return cached2;
      const name = analyzeNode(node);
      if (name) localCache.set(fp, name);
      return name;
    }
    const cached = aiCache.get(fp);
    if (cached) return cached;
    try {
      const name = await callClaude(serializeNode(node), node.id);
      if (name) {
        aiCache.set(fp, name);
        return name;
      }
    } catch (e) {
    }
    return analyzeNode(node);
  }
  function deepAnalyze(node) {
    const s = {
      textCount: 0,
      headingCount: 0,
      bodyCount: 0,
      labelCount: 0,
      shortTextCount: 0,
      totalWordCount: 0,
      hasLargeNumber: false,
      hasImage: false,
      hasAvatar: false,
      hasButton: false,
      hasInput: false,
      hasCheckbox: false,
      hasToggle: false,
      hasDropdown: false,
      hasLogo: false,
      hasDivider: false,
      iconCount: 0,
      isHorizontal: false,
      isVertical: false,
      hasAutoLayout: false,
      width: node.width,
      height: node.height,
      aspectRatio: node.height > 0 ? node.width / node.height : 1,
      childCount: 0,
      totalDescendants: 0,
      childrenAreUniform: false,
      nameHints: []
    };
    if ("layoutMode" in node) {
      s.isHorizontal = node.layoutMode === "HORIZONTAL";
      s.isVertical = node.layoutMode === "VERTICAL";
      s.hasAutoLayout = s.isHorizontal || s.isVertical;
    }
    if (!("children" in node)) return s;
    s.childCount = node.children.length;
    walkDescendants(node, s, 0);
    if (s.childCount >= 3 && "children" in node) {
      const kids = node.children;
      const heights = kids.map((c) => Math.round(c.height / 10) * 10);
      const allSame = heights.every((h) => Math.abs(h - heights[0]) <= 20);
      s.childrenAreUniform = allSame;
    }
    return s;
  }
  function walkDescendants(parent, s, depth) {
    for (const child of parent.children) {
      s.totalDescendants++;
      const nameLower = child.name.toLowerCase();
      s.nameHints.push(nameLower);
      if (child.type === "TEXT") {
        const t = child;
        const chars = t.characters.trim();
        if (!chars) continue;
        s.textCount++;
        const wordCount = chars.trim().split(/\s+/).filter(Boolean).length;
        s.totalWordCount += wordCount;
        if (wordCount <= 2) s.shortTextCount++;
        const fontSize = typeof t.fontSize === "number" ? t.fontSize : 14;
        const fontWeight = typeof t.fontWeight === "number" ? t.fontWeight : 400;
        const isLong = chars.length > 80;
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
      if (child.type === "VECTOR" || child.type === "BOOLEAN_OPERATION") s.iconCount++;
      if (child.type === "INSTANCE" || child.type === "COMPONENT") {
        const isSmallSquare = child.width < 64 && child.height < 64 && Math.abs(child.width - child.height) < 10;
        if (isSmallSquare && nm(nameLower, ["icon", "ico", "symbol", "arrow", "chevron", "check", "close", "menu", "more", "dots"])) {
          s.iconCount++;
        }
      }
      if (child.type === "RECTANGLE" || child.type === "LINE") {
        if (child.width > 50 && child.height <= 4) s.hasDivider = true;
      }
      if ("fills" in child) {
        const fills = child.fills;
        if (Array.isArray(fills) && fills.some((f) => f.type === "IMAGE")) {
          const isSmall = child.width < 100 && child.height < 100;
          const isSquarish = Math.abs(child.width - child.height) < 20;
          if (isSmall && isSquarish) s.hasAvatar = true;
          else s.hasImage = true;
        }
      }
      if (nm(nameLower, ["icon", "ico", "symbol"])) s.iconCount++;
      if (nm(nameLower, ["avatar", "profile", "pfp", "user photo"])) s.hasAvatar = true;
      if (nm(nameLower, [
        "image",
        "img",
        "photo",
        "thumbnail",
        "cover",
        "banner",
        "poster",
        "hero image"
      ])) s.hasImage = true;
      if (nm(nameLower, ["button", "btn", "cta"])) s.hasButton = true;
      if (nm(nameLower, ["input", "field", "textfield", "search", "placeholder"])) s.hasInput = true;
      if (nm(nameLower, ["checkbox", "check box"])) s.hasCheckbox = true;
      if (nm(nameLower, ["toggle", "switch"])) s.hasToggle = true;
      if (nm(nameLower, ["dropdown", "select", "picker"])) s.hasDropdown = true;
      if (nm(nameLower, ["logo", "brand", "wordmark"])) s.hasLogo = true;
      if ("children" in child && depth < 3) walkDescendants(child, s, depth + 1);
    }
  }
  function nm(name, keywords) {
    return keywords.some((k) => name.includes(k));
  }
  function analyzeNode(node) {
    if (!("children" in node) || node.children.length === 0) return null;
    const kids = node.children;
    if (kids.length === 1) {
      const only = kids[0];
      if (only.type === "TEXT") return "Label";
      if (only.type === "VECTOR" || only.type === "BOOLEAN_OPERATION") return "Icon";
      if ("fills" in only) {
        const f = only.fills;
        if (Array.isArray(f) && f.some((x) => x.type === "IMAGE")) return "Media Block";
      }
    }
    const s = deepAnalyze(node);
    const { width: w, height: h } = s;
    const ar = s.aspectRatio;
    const candidates = [];
    const add = (name, score) => {
      if (score > 0) candidates.push({ name, score });
    };
    {
      let sc = 0;
      if (s.isHorizontal && w > 600 && h < 100) sc += 45;
      if (s.hasLogo) sc += 40;
      if (s.textCount >= 2 && h < 80) sc += 20;
      if (s.hasButton && s.hasLogo) sc += 15;
      add("Navbar", sc);
    }
    {
      let sc = 0;
      if (s.isHorizontal && s.childCount >= 3 && s.childCount <= 6 && s.childrenAreUniform) sc += 50;
      if (s.iconCount >= 2 && s.textCount >= 2 && h < 90) sc += 35;
      if (!s.hasImage && !s.hasButton && !s.hasInput && ar > 2) sc += 15;
      add("Tab Bar", sc);
    }
    {
      let sc = 0;
      if (s.isHorizontal && s.textCount >= 2 && !s.hasLogo && !s.hasImage) sc += 40;
      if (s.iconCount === 0 && h < 48 && s.childCount >= 2) sc += 30;
      if (s.childrenAreUniform && s.childCount >= 2) sc += 15;
      add("Links", sc);
    }
    {
      let sc = 0;
      if (w < 320 && h > 400 && s.isVertical) sc += 50;
      if (ar < 0.5 && s.textCount >= 3) sc += 30;
      if (s.iconCount >= 2 && s.textCount >= 2 && w < 300) sc += 25;
      add("Sidebar", sc);
    }
    {
      let sc = 0;
      if (s.hasInput && s.iconCount >= 1 && h < 60 && w > 150) sc += 80;
      if (s.childCount <= 4 && h < 60) sc += 15;
      add("Search Bar", sc);
    }
    {
      let sc = 0;
      if (s.hasInput && w >= 150 && h < 80 && s.childCount <= 3) sc += 70;
      if (!s.hasButton && !s.hasImage) sc += 10;
      add("Input", sc);
    }
    {
      let sc = 0;
      if (s.hasInput && s.isVertical && s.childCount >= 3) sc += 65;
      if (s.hasButton && s.hasInput) sc += 20;
      if (s.hasCheckbox || s.hasDropdown || s.hasToggle) sc += 15;
      add("Form", sc);
    }
    {
      let sc = 0;
      if (s.hasLargeNumber && s.textCount >= 2) sc += 80;
      if (s.hasLargeNumber && s.labelCount >= 1) sc += 20;
      if (!s.hasImage && !s.hasButton && !s.hasInput && !s.hasAvatar) sc += 10;
      add("Stat", sc);
    }
    {
      let sc = 0;
      if (s.hasImage && s.textCount === 0) sc += 85;
      if (s.hasImage && s.textCount === 1) sc += 40;
      if (!s.hasButton && !s.hasInput) sc += 10;
      add("Media Block", sc);
    }
    {
      let sc = 0;
      if (s.hasAvatar && s.headingCount >= 1 && s.textCount >= 2 && s.totalDescendants >= 4) sc += 85;
      if (s.hasAvatar && s.bodyCount >= 1) sc += 20;
      add("Card", sc);
    }
    {
      let sc = 0;
      if ((s.hasImage || s.hasAvatar) && s.textCount >= 1 && s.totalDescendants >= 4) sc += 80;
      if (s.headingCount >= 1 && (s.hasImage || s.hasAvatar)) sc += 20;
      if (s.hasButton && (s.hasImage || s.hasAvatar)) sc += 15;
      add("Card", sc);
    }
    {
      let sc = 0;
      if ((s.hasImage || s.hasAvatar) && s.textCount >= 1 && s.totalDescendants < 5) sc += 80;
      if (s.isHorizontal && h < 100) sc += 20;
      if (s.iconCount >= 1) sc += 10;
      if (s.totalDescendants >= 5 && s.headingCount >= 1 && s.bodyCount >= 1) sc = 0;
      add("Item", sc);
    }
    {
      let sc = 0;
      if (s.isVertical && s.childCount >= 3 && s.childrenAreUniform) sc += 55;
      if (s.hasAvatar || s.iconCount >= 2) sc += 20;
      if (!s.hasButton && !s.hasInput) sc += 10;
      add("List", sc);
    }
    {
      let sc = 0;
      if (!s.hasImage && s.iconCount >= 1 && s.textCount >= 1 && h < 80) sc += 75;
      if (!s.hasImage && s.hasAvatar && s.textCount >= 1 && h < 80) sc += 70;
      if (s.isHorizontal && s.childCount >= 2 && s.childCount <= 6) sc += 20;
      if (!s.hasButton && !s.hasInput && s.totalDescendants <= 8) sc += 10;
      add("List Item", sc);
    }
    {
      let sc = 0;
      if (s.childCount >= 3 && s.childrenAreUniform && s.isHorizontal) sc += 50;
      if ((s.hasImage || s.hasAvatar) && s.childCount >= 3) sc += 25;
      if (w > 500) sc += 10;
      add("Grid", sc);
    }
    {
      let sc = 0;
      if (!s.hasImage && !s.hasAvatar && s.totalWordCount <= 2 && s.textCount === 1) {
        if (h < 32 && w < 120) sc += 85;
        if (s.iconCount === 0) sc += 10;
      }
      if (s.hasImage || s.hasAvatar) sc = 0;
      add("Badge", sc);
    }
    {
      let sc = 0;
      if (!s.hasImage && !s.hasAvatar) {
        if (s.hasButton && h <= 56 && w <= 350) sc += 75;
        if (s.totalWordCount <= 4 && h <= 56 && s.iconCount <= 2) sc += 40;
        if (s.textCount === 1 && h > 32 && h <= 56 && !s.hasInput) sc += 20;
      }
      if (s.hasImage || s.hasAvatar) sc = 0;
      add("Button", sc);
    }
    {
      let sc = 0;
      if (!s.hasImage && !s.hasAvatar) {
        if (s.totalWordCount <= 2 && s.iconCount >= 1 && s.childCount <= 4) sc += 70;
        if (s.totalWordCount <= 2 && s.iconCount === 0 && s.textCount >= 1 && h >= 32) sc += 55;
      }
      if (s.hasImage || s.hasAvatar) sc = 0;
      add("Label", sc);
    }
    {
      let sc = 0;
      if (s.iconCount >= 1 && s.headingCount >= 1 && !s.hasImage && !s.hasAvatar) sc += 65;
      if (s.bodyCount >= 1 && !s.hasImage) sc += 25;
      if (s.isVertical && !s.hasInput && s.totalWordCount > 5) sc += 15;
      add("Feature", sc);
    }
    {
      let sc = 0;
      if (s.headingCount >= 1 && s.bodyCount >= 1 && !s.hasImage && s.iconCount === 0) sc += 70;
      if (s.headingCount >= 1 && s.labelCount >= 1 && !s.hasImage && s.iconCount === 0) sc += 40;
      if (!s.hasButton && !s.hasInput && !s.hasAvatar) sc += 10;
      add("Text Block", sc);
    }
    {
      let sc = 0;
      if (s.hasImage && s.textCount >= 2 && s.childCount === 2 && s.isHorizontal) sc += 70;
      if (w > 500 && s.hasImage && s.headingCount >= 1 && s.bodyCount >= 1) sc += 30;
      add("Split", sc);
    }
    {
      let sc = 0;
      if (w > 600 && h > 250 && s.headingCount >= 1 && s.bodyCount >= 1) sc += 55;
      if (s.hasButton && s.headingCount >= 1 && w > 500) sc += 30;
      if (s.hasImage && h > 250) sc += 15;
      add("Hero", sc);
    }
    {
      let sc = 0;
      if (s.totalDescendants > 10 && s.childCount >= 2 && w > 400) sc += 45;
      if (s.headingCount >= 2 && s.childCount >= 3) sc += 25;
      if (w > 600 && s.childCount >= 3) sc += 20;
      add("Section", sc);
    }
    {
      let sc = 0;
      if (s.isHorizontal && s.iconCount >= 3 && h < 60 && !s.hasLogo) sc += 65;
      if (s.childCount >= 3 && !s.hasImage && !s.hasInput && h < 60) sc += 20;
      add("Toolbar", sc);
    }
    {
      let sc = 0;
      if (s.hasButton && s.childCount >= 2 && s.isHorizontal && !s.hasImage) sc += 55;
      if (s.textCount <= 4 && !s.hasInput && h < 80) sc += 20;
      add("Action Bar", sc);
    }
    {
      let sc = 0;
      if (s.iconCount >= 1 && s.hasImage && s.textCount >= 1) sc += 40;
      if (s.childCount >= 3 && s.totalDescendants > 6) sc += 20;
      if (w > 300 && !s.hasAutoLayout) sc += 10;
      add("Container", sc);
    }
    if (s.isHorizontal && s.textCount === 0 && s.iconCount === 0 && !s.hasImage && !s.hasAvatar) add("Row", 40);
    if (s.isVertical && s.textCount === 0 && s.iconCount === 0 && !s.hasImage && !s.hasAvatar) add("Column", 40);
    candidates.sort((a, b) => b.score - a.score);
    const winner = candidates[0];
    if (!winner || winner.score < 25) {
      if (s.childCount === 0) return null;
      if (s.isHorizontal) return "Row";
      if (s.isVertical) return "Column";
      return "Container";
    }
    return winner.name;
  }
  function collectTree(root, result) {
    const queue = [root];
    while (queue.length > 0) {
      const node = queue.shift();
      result.push(node);
      if ("children" in node) {
        for (const child of node.children) {
          if (isNamableNode(child)) {
            queue.push(child);
          }
        }
      }
    }
  }
  function isNamableNode(node) {
    return node.type === "FRAME" || node.type === "COMPONENT" || node.type === "GROUP";
  }
  function isAutoName(name) {
    return /^(Frame|Group|Component|Section|Rectangle|Ellipse|Polygon|Star|Vector|Line|Arrow)\s*\d*$/i.test(name.trim());
  }
  function sendHealthUpdate() {
    const allNodes = figma.currentPage.findAll((n) => isNamableNode(n));
    const total = allNodes.length;
    const unnamed = allNodes.filter((n) => isAutoName(n.name)).length;
    figma.ui.postMessage({ type: "healthResult", total, unnamed });
  }
  async function saveSettings() {
    await figma.clientStorage.setAsync("settings", { isEnabled, useAI, apiKey });
  }
  function serializeNode(node, depth = 0) {
    var _a;
    const result = {
      t: node.type[0] + ((_a = node.type[1]) != null ? _a : ""),
      // "FR", "TE", "VE", etc.
      w: Math.round(node.width / 5) * 5,
      // bucket to 5px
      h: Math.round(node.height / 5) * 5
    };
    if ("layoutMode" in node) {
      const lm = node.layoutMode;
      if (lm !== "NONE") result.l = lm[0];
    }
    if ("fills" in node) {
      const fills = node.fills;
      if (Array.isArray(fills) && fills.some((f) => f.type === "IMAGE")) result.img = 1;
    }
    if (node.type === "TEXT") {
      const t = node;
      result.fs = typeof t.fontSize === "number" ? Math.round(t.fontSize) : 14;
      result.fw = typeof t.fontWeight === "number" ? t.fontWeight : 400;
      result.len = t.characters.trim().length;
    }
    if ("children" in node && depth < 3) {
      const children = node.children.slice(0, 10);
      if (children.length) result.c = children.map((c) => serializeNode(c, depth + 1));
    }
    return result;
  }
  async function callClaude(structure, nodeId) {
    return new Promise((resolve) => {
      const id = Math.random().toString(36).slice(2);
      const handler = (msg) => {
        if (msg.type === "aiResponse" && msg.id === id) {
          figma.ui.off("message", handler);
          resolve(msg.name || null);
        }
      };
      figma.ui.on("message", handler);
      figma.ui.postMessage({ type: "aiRequest", id, apiKey, structure, nodeId });
      setTimeout(() => {
        figma.ui.off("message", handler);
        resolve(null);
      }, 8e3);
    });
  }
  async function callClaudeFixSelected(nodes) {
    return new Promise((resolve) => {
      const id = Math.random().toString(36).slice(2);
      const handler = (msg) => {
        if (msg.type === "aiAnalyzeBatchResult" && msg.id === id) {
          figma.ui.off("message", handler);
          const map = /* @__PURE__ */ new Map();
          for (const [k, v] of Object.entries(msg.result || {})) {
            if (typeof v === "string") map.set(k, v);
          }
          resolve(map);
        }
      };
      figma.ui.on("message", handler);
      figma.ui.postMessage({ type: "aiAnalyzeBatch", id, apiKey, nodes });
      setTimeout(() => {
        figma.ui.off("message", handler);
        resolve(/* @__PURE__ */ new Map());
      }, 3e4);
    });
  }
  var debugMode = false;
  (async () => {
    var _a;
    debugMode = (_a = await figma.clientStorage.getAsync("debug")) != null ? _a : false;
  })();
})();
