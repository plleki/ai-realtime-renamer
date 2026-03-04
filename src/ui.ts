// ui.ts — Smart Renamer Plugin UI v11

interface LogEntry {
  name: string;
  prevName: string;
  ai: boolean;
  nodeId: string;
}

interface State {
  isEnabled: boolean;
  useAI: boolean;
  hasApiKey: boolean;
  isThinking: boolean;
  isCollapsed: boolean;
  isAnalyzing: boolean;
  analyzeProgress: string;
  log: Array<LogEntry>;
  statusText: string;
  isDark: boolean;
  health: { total: number; unnamed: number } | null;
  isHealthExpanded: boolean;
  loadingBtn: string | null;
  // Context tab
  activeTab: 'rename' | 'context';
  docMode: 'ai' | 'local';
  contextEnabled: boolean;
  contextStatus: string;
  contextSummary: { totalLayers: number; components: number; interactions: number; screenName: string } | null;
  isContextRunning: boolean;
  isLogOverlay: boolean;
}

const state: State = {
  isEnabled: true,
  useAI: false,
  hasApiKey: false,
  isThinking: false,
  isCollapsed: false,
  isAnalyzing: false,
  analyzeProgress: '',
  log: [],
  statusText: '',
  isDark: window.matchMedia('(prefers-color-scheme: dark)').matches,
  health: null,
  isHealthExpanded: false,
  loadingBtn: null,
  activeTab: 'rename',
  docMode: 'ai',
  contextEnabled: false,
  contextStatus: '',
  contextSummary: null,
  isContextRunning: false,
  isLogOverlay: false,
};

// Follow system theme changes live
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', e => {
  state.isDark = e.matches;
  render();
});

// ─── Theme tokens ─────────────────────────────────────────────────────────────
function t() {
  const d = state.isDark;
  return {
    bg:          d ? '#161618' : '#F5F5F7',
    surface:     d ? '#1E1E20' : '#FFFFFF',
    surfaceHov:  d ? '#28282C' : '#F0F0F2',
    border:      d ? '#2C2C30' : '#E0E0E4',
    borderFocus: d ? '#7B61FF' : '#7B61FF',
    text:        d ? '#F0F0F2' : '#111114',
    textSub:     d ? '#8A8A90' : '#6B6B72',
    textMuted:   d ? '#85858D' : '#3C3C44',  // WCAG fix: was #4A4A52 (2.06:1 dark) / #ABABB4 (2.09:1 light)
    accent:      d ? '#8B6CFF' : '#6E54F5',  // WCAG fix: was #7B61FF (4.30:1 dark / 3.86:1 light)
    accentEnd:   '#00C2FF',
    accentAI:    d ? '#FF8C42' : '#A85C2C',  // WCAG fix light: was #FF8C42 (2.12:1 on light bg)
    success:     d ? '#34C759' : '#188236',  // WCAG fix light: was #1A8C3A (3.97:1)
    danger:      d ? '#FF5F5F' : '#D93025',
    tagAI:       d ? '#2C1A0A' : '#FFF0E6',
    tagAIText:   d ? '#FF9A4D' : '#B85000',
    tagAuto:     d ? '#1A1A2E' : '#EEE9FF',
    tagAutoText: d ? '#9A86FF' : '#5B3FD9',
    logItem:     d ? '#1C1C20' : '#F8F8FA',
    logItemNew:  d ? '#1E1A2E' : '#F0ECFF',
    logBorderNew:d ? '#7B61FF' : '#7B61FF',
    inputBg:     d ? '#141416' : '#FFFFFF',
    shadow:      d ? '0 8px 32px rgba(0,0,0,0.5)' : '0 4px 20px rgba(0,0,0,0.12)',
  };
}

// ─── Single-frame Claude API Call ─────────────────────────────────────────────
async function callClaudeAPI(apiKey: string, structure: object): Promise<string | null> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 20,
      messages: [{ role: 'user', content: buildSinglePrompt(structure) }],
    }),
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data?.content?.[0]?.text?.trim() || null;
}

// ─── Batch Claude API Call ─────────────────────────────────────────────────────
async function callClaudeBatch(
  apiKey: string,
  nodes: Array<{ id: string; parentId: string | null; depth: number; structure: object; currentName: string }>
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const prompt = `You are a Figma layer naming expert. Given a JSON array of layers with structural data and tree context, return a JSON object mapping each id to a semantic layer name.

Rules:
- Generic structural names only — no text content from the frame
- Title Case with spaces
- Use parent/sibling context: identical sibling frames are likely List Items or Cards
- 1-4 words max per name
- Return ONLY valid JSON, no markdown

Layers: ${JSON.stringify(nodes, null, 2)}

JSON output:`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) return result;
  const data = await res.json();
  const text = data?.content?.[0]?.text?.trim() || '';
  try {
    const parsed = JSON.parse(text.replace(/```json|```/g, '').trim());
    for (const [id, name] of Object.entries(parsed)) {
      if (typeof name === 'string') result.set(id, name as string);
    }
  } catch { }
  return result;
}

// ─── Context: Analyze Screen ─────────────────────────────────────────────────
// Two modes:
//   scanOnly=true  → lean names-only prompt, max_tokens 1200, faster
//   scanOnly=false → full prompt with doc generation, max_tokens 3000
async function callClaudeContext(
  apiKey: string,
  nodes: Array<{ id: string; parentId: string | null; depth: number; structure: object; currentName: string }>,
  textSamples: string[],
  scanOnly = false
): Promise<{ names: Record<string, string>; doc: string } | null> {

  // Lean prompt for Analyze and Rename Nested Layers — names only, no doc
  // Strips parentId/depth, compacts structure, removes whitespace from JSON
  const compactNodes = nodes.map(n => ({ i: n.id, n: n.currentName, s: n.structure }));
  const scanPrompt = `Figma designer. Rename layers with context-aware names reflecting PURPOSE on this screen.
Text on screen: ${textSamples.slice(0, 25).join(' | ')}
Rules: 1-4 words Title Case. Return ONLY: {"id":"Name",...}
Layers:${JSON.stringify(compactNodes)}`;

  // Full prompt for Give Context — names + documentation
  const fullPrompt = `You are an expert product designer and technical writer analyzing a Figma screen.

You will receive:
1. A tree of UI layers (structural data only)
2. Text samples found on the screen (actual copy/labels — use these to understand what the screen is about)

Your job has two parts:

PART 1 — RENAME LAYERS
Rename every layer with a context-aware name that reflects its PURPOSE in this specific screen.
Use the text samples to understand what the screen is (e.g. if you see "Candidate", "Apply", "Status" it's a recruitment screen).
Names: 1-4 words, Title Case, descriptive. Examples: "Candidate Row", "Filter Toolbar", "Status Badge", "Application Table", "Sidebar Navigation".

PART 2 — WRITE SCREEN DOCUMENTATION
Write documentation using exactly this structure (keep ## headings):

## Screen Purpose
2-3 sentences: what this screen does, who uses it, when, and what the overall user flow is. Reference actual text/labels from the screen where relevant.

## User Interactions
- [Action verb phrase]: [what the user does and what happens as a result — be specific, reference actual buttons/labels from the screen]
- (list 6-10 interactions the user can perform)

Return ONLY valid JSON, no markdown fences, no explanation:
{
  "names": { "nodeId": "Layer Name", ... },
  "doc": "## Screen Purpose\n...\n\n## User Interactions\n..."
}

Text samples from screen:
${textSamples.slice(0, 40).join(' | ')}

Layer tree:
${JSON.stringify(nodes, null, 2)}`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: scanOnly ? 800 : 3000,
      messages: [{ role: 'user', content: scanOnly ? scanPrompt : fullPrompt }],
    }),
  });
  if (!res.ok) return null;
  const data = await res.json();
  const text = data?.content?.[0]?.text?.trim() || '';
  try {
    if (scanOnly) {
      const parsed = JSON.parse(text.replace(/```json|```/g, '').trim());
      // scanPrompt returns flat {id:name} map directly
      return { names: parsed || {}, doc: '' };
    } else {
      const parsed = JSON.parse(text.replace(/```json|```/g, '').trim());
      return { names: parsed.names || {}, doc: parsed.doc || '' };
    }
  } catch { return null; }
}

function buildSinglePrompt(structure: object): string {
  // Compressed prompt — strips whitespace overhead to minimize input tokens
  // Valid names: Nav Bar, Tab Bar, Input Field, Form Block, Media Block, Avatar,
  //   Label, List Item, Card, Feature Block, Text Block, Content Block, Action Bar,
  //   Content Section, Row, Column, Container
  return `Figma layer. Output ONLY a 1-4 word Title Case generic structural name. No text content. Valid: Nav Bar,Tab Bar,Input Field,Form Block,Media Block,Avatar,Label,List Item,Card,Feature Block,Text Block,Content Block,Action Bar,Content Section,Row,Column,Container.
Structure:${JSON.stringify(structure)}
Name:`;
}

// ─── CSS ──────────────────────────────────────────────────────────────────────
function injectStyles() {
  const c = t();
  const existing = document.getElementById('sr-styles');
  if (existing) existing.remove();
  const style = document.createElement('style');
  style.id = 'sr-styles';
  style.textContent = `
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    html, body {
      width: 100%; height: 100%;
      margin: 0; padding: 0;
      overflow: hidden;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif;
      background: ${c.bg};
      color: ${c.text};
      font-size: 13px;
      line-height: 1.4;
      -webkit-font-smoothing: antialiased;
    }
    #root {
      width: 100%; height: 100%;
      margin: 0; padding: 0;
      overflow: hidden;
    }
    .plugin-wrap {
      display: flex;
      flex-direction: column;
      width: 100%;
      height: 100%;
      overflow: hidden;
      background: ${c.bg};
      position: relative;
      padding: 0 16px 16px;
    }

    /* Status bar */
    .sr-status {
      flex-shrink: 0;
      padding: 3px 0;
      font-size: 10px;
      color: ${c.accent};
      min-height: 20px;
      font-weight: 500;
    }

    /* Header */
    .sr-header {
      flex-shrink: 0;
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 14px 0 12px;
      border-bottom: 1px solid ${c.border};
    }
    .sr-logo {
      width: 28px; height: 28px;
      background: linear-gradient(135deg, ${c.accent}, ${c.accentEnd});
      border-radius: 8px;
      display: flex; align-items: center; justify-content: center;
      flex-shrink: 0;
      font-size: 14px;
      box-shadow: 0 2px 8px rgba(123,97,255,0.35);
    }
    .sr-title { font-size: 13px; font-weight: 600; color: ${c.text}; letter-spacing: -0.2px; }
    .sr-subtitle {
      font-size: 11px;
      color: ${c.textSub};
      display: flex; align-items: center; gap: 5px;
      margin-top: 1px;
    }
    .sr-dot {
      width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0;
    }
    .dot-active { background: ${c.success}; box-shadow: 0 0 5px ${c.success}; }
    .dot-ai { background: ${c.accentAI}; box-shadow: 0 0 5px ${c.accentAI}; }
    .dot-paused { background: ${c.textMuted}; }

    /* Toggle */
    .sr-toggle {
      width: 36px; height: 20px; border-radius: 10px;
      position: relative; cursor: pointer; flex-shrink: 0;
      transition: background 0.2s;
      border: none; outline: none;
      padding: 0;
      box-shadow: inset 0 0 0 1.5px ${c.border};
    }
    .sr-toggle-thumb {
      position: absolute; top: 2px;
      width: 16px; height: 16px;
      background: #fff; border-radius: 50%;
      transition: left 0.15s ease;
      box-shadow: 0 1px 4px rgba(0,0,0,0.3);
      pointer-events: none;
    }

    /* Section */
    .sr-section {
      flex-shrink: 0;
      padding: 12px 0;
      border-bottom: 1px solid ${c.border};
    }

    /* AI section */
    .sr-ai-header {
      display: flex; align-items: flex-start; justify-content: space-between;
      gap: 12px;
      margin-bottom: 10px;
    }
    .sr-ai-label {
      display: flex; align-items: flex-start; gap: 6px; flex: 1; min-width: 0;
    }
    .sr-ai-name { font-size: 12px; font-weight: 600; color: ${c.text}; }
    .sr-ai-status { font-size: 11px; color: ${c.textSub}; margin-top: 2px; }

    /* Info icon + tooltip */
    .sr-info-wrap {
      position: static;
      display: inline-flex; align-items: center;
    }
    .sr-info-icon {
      width: 15px; height: 15px;
      border-radius: 50%;
      border: 1.5px solid ${c.border};
      display: flex; align-items: center; justify-content: center;
      cursor: default;
      color: ${c.textSub};
      font-size: 9px; font-weight: 700;
      user-select: none;
      transition: border-color 0.15s;
      position: relative;
    }
    .sr-info-icon:hover { border-color: ${c.accent}; color: ${c.accent}; }
    .sr-tooltip {
      display: none;
      position: fixed;
      left: 16px;
      right: 16px;
      width: auto;
      background: ${c.surface};
      border: 1px solid ${c.border};
      border-radius: 8px;
      padding: 10px 12px;
      font-size: 11px;
      color: ${c.textSub};
      line-height: 1.55;
      z-index: 9999;
      box-shadow: ${c.shadow};
      pointer-events: none;
    }
    .sr-info-icon:hover + .sr-tooltip,
    .sr-info-icon:hover ~ .sr-tooltip { display: block; }
    /* Author tooltip */
    .sr-author-tooltip {
      display: none;
      position: fixed;
      left: 16px;
      right: 16px;
      bottom: 44px;
      background: ${c.surface};
      border: 1px solid ${c.border};
      border-radius: 8px;
      padding: 10px 12px;
      font-size: 11px;
      color: ${c.textSub};
      line-height: 1.55;
      z-index: 9999;
      box-shadow: ${c.shadow};
      pointer-events: none;
    }
    .sr-author:hover .sr-author-tooltip { display: block; }
    .sr-author-tooltip a {
      color: ${c.accent};
      text-decoration: underline;
      pointer-events: all;
    }

    /* Input row */
    .sr-input-row { display: flex; gap: 7px; align-items: center; }
    .sr-input {
      flex: 1;
      padding: 7px 10px;
      background: ${c.inputBg};
      border: 1.5px solid ${c.border};
      border-radius: 7px;
      color: ${c.text};
      font-size: 11px;
      font-family: 'SF Mono', 'Fira Code', monospace;
      outline: none;
      transition: border-color 0.15s;
    }
    .sr-input:focus { border-color: ${c.accent}; }
    .sr-input::placeholder { color: ${c.textMuted}; }

    /* Buttons */
    .sr-btn {
      padding: 7px 12px;
      border-radius: 7px;
      border: none;
      font-size: 11px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.15s;
      display: flex; align-items: center; justify-content: center; gap: 5px;
      white-space: nowrap;
    }
    .sr-btn-primary {
      background: linear-gradient(135deg, ${c.accent}, ${c.accentEnd});
      color: #fff;
    }
    .sr-btn-primary:hover { opacity: 0.88; transform: translateY(-1px); }
    .sr-btn-ghost {
      background: transparent;
      border: 1.5px solid ${c.border};
      color: ${c.textSub};
    }
    .sr-btn-ghost:hover { border-color: ${c.accent}; color: ${c.accent}; background: ${c.surfaceHov}; }
    .sr-btn-ghost:disabled { opacity: 0.4; cursor: not-allowed; }

    /* Action buttons row */
    .sr-actions { display: flex; flex-direction: column; gap: 6px; }
    .sr-actions-row { display: flex; gap: 6px; }
    .sr-action-btn {
      flex: 1;
      padding: 8px 10px;
      background: ${c.surface};
      border: 1.5px solid ${c.border};
      border-radius: 8px;
      color: ${c.textSub};
      font-size: 11px;
      font-weight: 500;
      cursor: pointer;
      display: flex; align-items: center; justify-content: center; gap: 5px;
      transition: all 0.15s;
    }
    .sr-action-btn:hover { border-color: ${c.accent}; color: ${c.text}; background: ${c.surfaceHov}; }
    .sr-action-btn.active {
      border-color: ${c.accent};
      color: ${c.accent};
      background: ${state.isDark ? 'rgba(123,97,255,0.08)' : 'rgba(123,97,255,0.06)'};
    }
    .sr-analyze-btn {
      width: 100%;
      padding: 9px 12px;
      background: ${state.isDark ? 'rgba(123,97,255,0.1)' : 'rgba(123,97,255,0.07)'};
      border: 1.5px solid rgba(123,97,255,0.3);
      border-radius: 8px;
      color: ${c.accent};
      font-size: 11px;
      font-weight: 500;
      cursor: pointer;
      display: flex; align-items: center; justify-content: center; gap: 7px;
      transition: all 0.15s;
    }
    .sr-analyze-btn:hover:not(:disabled) {
      background: ${state.isDark ? 'rgba(123,97,255,0.18)' : 'rgba(123,97,255,0.13)'};
      border-color: rgba(123,97,255,0.6);
    }
    .sr-analyze-btn:disabled { opacity: 0.5; cursor: default; }

    /* Mode badge */
    .sr-mode-badge {
      display: inline-flex; align-items: center; gap: 4px;
      padding: 3px 8px;
      border-radius: 5px;
      font-size: 10px;
      font-weight: 600;
      margin-top: 8px;
    }
    .badge-ai {
      background: ${c.tagAI};
      color: ${c.tagAIText};
    }
    .badge-local {
      background: ${c.tagAuto};
      color: ${c.tagAutoText};
    }

    /* Log section */
    .sr-log-wrap {
      flex: 1;
      min-height: 0;
      display: flex;
      flex-direction: column;
      padding: 10px 0 0;
      overflow: hidden;
    }
    .sr-log-header {
      flex-shrink: 0;
      display: flex; align-items: center; justify-content: space-between;
      margin-bottom: 7px;
    }
    .sr-log-title {
      font-size: 10px;
      font-weight: 600;
      color: ${c.textMuted};
      text-transform: uppercase;
      letter-spacing: 0.7px;
    }
    .sr-log-clear {
      font-size: 10px;
      color: ${c.textMuted};
      cursor: pointer;
      text-decoration: underline;
      background: none; border: none;
    }
    .sr-log-clear:hover { color: ${c.textSub}; }
    .sr-log-list {
      flex: 1;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 3px;
      scrollbar-width: thin;
      scrollbar-color: ${c.border} transparent;
      padding-bottom: 6px;
    }
    .sr-log-empty {
      color: ${c.textMuted};
      font-size: 11px;
      font-style: italic;
      padding: 6px 0;
    }
    .sr-log-item {
      flex-shrink: 0;
      display: flex; align-items: center; gap: 6px;
      padding: 5px 8px;
      border-radius: 6px;
      font-size: 11px;
      cursor: pointer;
      border-left: 2px solid transparent;
      transition: background 0.1s, color 0.1s, border-color 0.1s;
    }
    .sr-log-item:hover {
      background: ${state.isDark ? 'rgba(123,97,255,0.1)' : 'rgba(123,97,255,0.07)'} !important;
      border-color: ${c.accent} !important;
      color: ${c.accent} !important;
    }
    .sr-log-tag {
      font-size: 9px;
      font-weight: 600;
      padding: 2px 5px;
      border-radius: 4px;
      flex-shrink: 0;
      letter-spacing: 0.3px;
    }
    .sr-log-name {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      flex: 1;
    }
    .sr-jump-icon { flex-shrink: 0; opacity: 0.3; }

    .sr-log-expand-btn {
      background: none;
      border: none;
      cursor: pointer;
      color: ${c.textMuted};
      padding: 2px 3px;
      border-radius: 4px;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: color 0.15s, background 0.15s;
      flex-shrink: 0;
    }
    .sr-log-expand-btn:hover {
      color: ${c.textSub};
      background: ${state.isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.05)'};
    }

    /* Log overlay — covers the full plugin interior, sits above everything */
    .sr-log-overlay {
      position: fixed;
      inset: 0;
      background: ${c.bg};
      z-index: 200;
      display: flex;
      flex-direction: column;
      padding: 16px 16px 0;
      animation: overlayIn 0.18s ease;
    }
    @keyframes overlayIn {
      from { opacity: 0; transform: translateY(8px); }
      to   { opacity: 1; transform: translateY(0); }
    }
    .sr-log-overlay-header {
      flex-shrink: 0;
      display: flex; align-items: center; justify-content: space-between;
      margin-bottom: 10px;
    }
    .sr-log-overlay-title {
      font-size: 12px;
      font-weight: 700;
      color: ${c.text};
      letter-spacing: 0.2px;
    }
    .sr-log-overlay-actions {
      display: flex; align-items: center; gap: 8px;
    }
    .sr-log-overlay-close {
      background: none; border: none; cursor: pointer;
      color: ${c.textMuted};
      padding: 4px;
      border-radius: 6px;
      display: flex; align-items: center; justify-content: center;
      transition: color 0.15s, background 0.15s;
    }
    .sr-log-overlay-close:hover {
      color: ${c.text};
      background: ${state.isDark ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.06)'};
    }
    .sr-log-overlay-list {
      flex: 1;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 3px;
      scrollbar-width: thin;
      scrollbar-color: ${c.border} transparent;
      padding-bottom: 16px;
    }

    /* Footer */
    .sr-footer {
      flex-shrink: 0;
      display: flex; align-items: center; justify-content: space-between;
      padding: 10px 0 14px;
      border-top: 1px solid ${c.border};
      min-height: 38px;
    }
    .sr-byline { font-size: 11px; color: ${c.textMuted}; }
    .sr-byline span { color: ${c.textSub}; font-weight: 500; }
    .sr-collapse-btn {
      display: flex; align-items: center; gap: 4px;
      font-size: 11px; color: ${c.textMuted};
      cursor: pointer; padding: 4px 8px; border-radius: 6px;
      background: none; border: none;
      transition: all 0.15s;
    }
    .sr-collapse-btn:hover { background: ${c.surfaceHov}; color: ${c.textSub}; }

    /* Collapsed view */
    .collapsed-wrap {
      width: 100%;
      height: 100%;
      margin: 0; padding: 0;
      background: ${c.bg};
      display: flex; align-items: center; justify-content: center;
      overflow: hidden;
    }
    .collapsed-btn {
      width: 36px; height: 36px;
      background: linear-gradient(135deg, ${c.accent}, ${c.accentEnd});
      border-radius: 11px;
      display: flex; align-items: center; justify-content: center;
      cursor: pointer;
      box-shadow: 0 2px 12px rgba(123,97,255,0.5);
      transition: transform 0.15s, box-shadow 0.15s;
      border: none;
      flex-shrink: 0;
    }
    .collapsed-btn:hover {
      transform: scale(1.08);
      box-shadow: 0 4px 18px rgba(123,97,255,0.65);
    }

    /* Test connection row */
    .sr-test-row {
      display: flex; align-items: center; justify-content: space-between;
      margin-top: 8px;
    }
    #test-status { font-size: 10px; color: ${c.textMuted}; }

    /* Health panel */
    .sr-health {
      flex-shrink: 0;
      padding: 10px 0;
      border-bottom: 1px solid ${c.border};
    }
    .sr-health-bar-wrap {
      height: 4px;
      background: ${c.border};
      border-radius: 2px;
      margin: 6px 0 8px;
      overflow: hidden;
    }
    .sr-health-bar-fill {
      height: 100%;
      border-radius: 2px;
      transition: width 0.4s ease;
    }
    .sr-health-actions {
      display: flex;
      gap: 6px;
      margin-top: 2px;
    }
    .sr-health-scan-btn {
      padding: 5px 10px;
      border-radius: 6px;
      border: 1.5px solid ${c.border};
      background: transparent;
      color: ${c.textSub};
      font-size: 11px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.15s;
    }
    .sr-health-scan-btn:hover { border-color: ${c.accent}; color: ${c.accent}; }
    .sr-health-fix-btn {
      flex: 1;
      padding: 5px 10px;
      border-radius: 6px;
      border: none;
      background: linear-gradient(135deg, ${c.accent}, ${c.accentEnd});
      color: #fff;
      font-size: 11px;
      font-weight: 500;
      cursor: pointer;
      transition: opacity 0.15s;
    }
    .sr-health-fix-btn:hover { opacity: 0.85; }
    .sr-health-fix-btn:disabled { opacity: 0.4; cursor: default; }

    /* Loading shimmer inside buttons */
    @keyframes btnShimmer {
      0%   { transform: translateX(-100%); }
      100% { transform: translateX(200%); }
    }
    .sr-btn-loading {
      position: relative;
      overflow: hidden;
      opacity: 0.75;
      cursor: default !important;
      pointer-events: none;
    }
    .sr-btn-loading::after {
      content: '';
      position: absolute;
      top: 0; left: 0; right: 0; bottom: 0;
      background: linear-gradient(90deg, transparent 0%, rgba(255,255,255,0.18) 50%, transparent 100%);
      animation: btnShimmer 1.2s infinite;
    }

    @keyframes spin {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }
    .spin { animation: spin 1s linear infinite; }

    /* Context tab (infrastructure — hidden, future PRO release) */
    .ctx-wrap {
      flex: 1; display: flex; flex-direction: column;
      overflow: hidden; padding: 12px 0 0;
      min-height: 0;
    }
    .ctx-intro {
      font-size: 11px; color: ${c.textSub};
      line-height: 1.5; margin-bottom: 12px; flex-shrink: 0;
    }
    .ctx-btn {
      width: 100%;
      padding: 10px 14px;
      border-radius: 9px;
      border: none;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      display: flex; align-items: center; justify-content: center; gap: 7px;
      background: linear-gradient(135deg, #7B61FF, #00C2FF);
      color: #fff;
      transition: opacity 0.15s, transform 0.15s;
      flex-shrink: 0;
      box-shadow: 0 3px 12px rgba(123,97,255,0.35);
    }
    .ctx-btn:hover:not(:disabled) { opacity: 0.88; transform: translateY(-1px); }
    .ctx-btn:disabled { opacity: 0.45; cursor: default; transform: none; box-shadow: none; }
    .ctx-doc-wrap {
      flex: 1; overflow-y: auto; margin-top: 12px;
      min-height: 0;
      scrollbar-width: thin;
      scrollbar-color: ${c.border} transparent;
    }
    .ctx-doc {
      background: ${c.surface};
      border: 1px solid ${c.border};
      border-radius: 10px;
      padding: 14px;
      font-size: 11px;
      line-height: 1.65;
      color: ${c.textSub};
      white-space: pre-wrap;
      word-break: break-word;
    }
    .ctx-doc-header {
      display: flex; align-items: center; justify-content: space-between;
      margin-bottom: 8px; flex-shrink: 0;
    }
    .ctx-doc-title {
      font-size: 10px; font-weight: 700; text-transform: uppercase;
      letter-spacing: 0.7px; color: ${c.textMuted};
    }
    .ctx-copy-btn {
      font-size: 10px; color: ${c.textMuted};
      cursor: pointer; background: none; border: none;
      padding: 2px 6px; border-radius: 4px;
      transition: all 0.12s;
    }
    .ctx-copy-btn:hover { background: ${c.surfaceHov}; color: ${c.textSub}; }
    .ctx-status {
      font-size: 11px; color: ${c.accent};
      min-height: 18px; margin-top: 8px;
      font-style: italic; flex-shrink: 0;
    }
    .ctx-no-key {
      margin-top: 8px;
      padding: 10px 12px;
      background: ${state.isDark ? 'rgba(255,140,66,0.08)' : 'rgba(255,140,66,0.06)'};
      border: 1px solid ${state.isDark ? 'rgba(255,140,66,0.25)' : 'rgba(255,140,66,0.2)'};
      border-radius: 8px;
      font-size: 11px;
      color: ${state.isDark ? '#FF9A4D' : '#B85000'};
      line-height: 1.5;
    }

    /* Tab bar */
    .sr-tabs {
      flex-shrink: 0;
      display: flex;
      padding: 10px 0 0;
      border-bottom: 1px solid ${c.border};
    }
    .sr-tab {
      flex: 1;
      padding: 7px 12px 8px;
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      background: none;
      border: none;
      border-bottom: 2px solid transparent;
      color: ${c.textSub};
      transition: color 0.15s, border-color 0.15s;
      text-align: center;
      margin-bottom: -1px;
      letter-spacing: -0.1px;
    }
    .sr-tab.active {
      color: ${c.accent};
      border-bottom-color: ${c.accent};
      font-weight: 600;
    }
    .sr-tab:hover:not(.active) {
      color: ${c.text};
    }
  `;
  document.head.appendChild(style);
}


// ─── Health Panel HTML ────────────────────────────────────────────────────────
function renderHealthPanel(c: ReturnType<typeof t>): string {
  const h = state.health;
  const expanded = state.isHealthExpanded;
  const pct = h && h.total > 0 ? Math.round(((h.total - h.unnamed) / h.total) * 100) : (h ? 100 : -1);
  const color = pct < 0 ? c.textMuted : pct >= 80 ? c.success : pct >= 50 ? c.accentAI : c.danger;
  const allClean = h !== null && h.unnamed === 0;

  // ── Collapsed header (always shown) ──
  const pctLabel = pct >= 0
    ? '<span style="font-size:11px;font-weight:600;color:' + color + ';">' + pct + '%</span>'
    : '<span style="font-size:11px;color:' + c.textMuted + ';">—</span>';

  const chevron = expanded
    ? '<svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M2 4L5 7L8 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>'
    : '<svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M4 2L7 5L4 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  const header = [
    '<button onclick="handleToggleHealth()" style="',
    '  width:100%;display:flex;align-items:center;justify-content:space-between;',
    '  background:none;border:none;cursor:pointer;padding:0;',
    '  color:' + c.textMuted + ';',
    '" aria-expanded="' + expanded + '">',
    '  <span style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.7px;">Layer Health</span>',
    '  <span style="display:flex;align-items:center;gap:6px;">',
    '    ' + pctLabel,
    '    <span style="color:' + c.textMuted + ';opacity:0.6;">' + chevron + '</span>',
    '  </span>',
    '</button>',
  ].join('');

  if (!expanded) {
    return '<div class="sr-health">' + header + '</div>';
  }

  // ── Expanded content ──
  const isCheckingHealth = state.loadingBtn === 'checkHealth';
  const barHtml = h !== null
    ? '<div class="sr-health-bar-wrap"><div class="sr-health-bar-fill" style="width:' + pct + '%;background:' + color + ';"></div></div>'
    : '<div class="sr-health-bar-wrap"><div class="sr-health-bar-fill" style="width:0%;background:' + c.border + ';"></div></div>';

  const labelHtml = isCheckingHealth
    ? '<div style="font-size:11px;color:' + c.textMuted + ';font-style:italic;margin:4px 0 8px;">Scanning…</div>'
    : h === null
      ? '<div style="font-size:11px;color:' + c.textMuted + ';font-style:italic;margin:4px 0 8px;">Click Check Layer Health to scan</div>'
      : allClean
        ? '<div style="font-size:11px;color:' + c.success + ';margin:4px 0 8px;">✓ All ' + h.total + ' layers are named</div>'
        : '<div style="font-size:11px;color:' + c.textSub + ';margin:4px 0 8px;">' + h.unnamed + ' of ' + h.total + ' layers need renaming</div>';

  const pointDisabled = !h || h.unnamed === 0;
  const spinSvg = '<svg class="spin" width="10" height="10" viewBox="0 0 12 12" fill="none" style="display:inline;vertical-align:middle;margin-right:4px;"><circle cx="6" cy="6" r="4.5" stroke="rgba(255,255,255,0.3)" stroke-width="1.5"/><path d="M6 1.5A4.5 4.5 0 0 1 10.5 6" stroke="white" stroke-width="1.5" stroke-linecap="round"/></svg>';

  const pointBtn = [
    '<button class="sr-health-scan-btn"',
    '  onclick="' + (pointDisabled ? '' : 'handlePointLayers()') + '"',
    '  ' + (pointDisabled ? 'disabled' : ''),
    '  title="Select all unnamed layers in Figma"',
    '  style="' + (pointDisabled ? 'opacity:0.4;cursor:default;' : '') + '"',
    '>',
    '  ⌖ Point Layers',
    '</button>',
  ].join('');

  const checkBtn = [
    '<button class="sr-health-fix-btn' + (isCheckingHealth ? ' sr-btn-loading' : '') + '"',
    '  onclick="' + (isCheckingHealth ? '' : 'handleCheckLayerHealth()') + '"',
    '  title="Check layer health across the whole page"',
    '>',
    isCheckingHealth ? '  ' + spinSvg + 'Processing…' : '  Check Layer Health',
    '</button>',
  ].join('');

  return [
    '<div class="sr-health">',
    header,
    '<div style="margin-top:6px;">',
    barHtml,
    labelHtml,
    '<div class="sr-health-actions">',
    pointBtn,
    checkBtn,
    '</div>',
    '</div>',
    '</div>',
  ].join('\n');
}


// ─── Context Panel ───────────────────────────────────────────────────────────
function renderContextPanel(c: ReturnType<typeof t>): string {
  const hasKey  = state.hasApiKey;
  const running = state.isContextRunning;
  const sum     = state.contextSummary;
  const ctxOn   = state.contextEnabled;
  const isLocal = state.docMode === 'local';

  // ── Mode switcher pill ────────────────────────────────────────────────────
  const modeSwitcher = `
    <div style="
      display:flex;gap:3px;padding:3px;
      background:${c.surface};
      border:1.5px solid ${c.border};
      border-radius:10px;
      margin-bottom:12px;
      flex-shrink:0;
    ">
      <button onclick="handleDocModeSwitch('ai')" style="
        flex:1;padding:7px 10px;border:none;border-radius:7px;
        font-size:11px;font-weight:600;cursor:pointer;transition:all 0.15s;
        background:${!isLocal ? `linear-gradient(135deg,${c.accent},${c.accentEnd})` : 'transparent'};
        color:${!isLocal ? '#fff' : c.textSub};
      " aria-pressed="${!isLocal}">✨ AI</button>
      <button onclick="handleDocModeSwitch('local')" style="
        flex:1;padding:7px 10px;border:none;border-radius:7px;
        font-size:11px;font-weight:600;cursor:pointer;transition:all 0.15s;
        background:${isLocal ? `linear-gradient(135deg,${c.accent},${c.accentEnd})` : 'transparent'};
        color:${isLocal ? '#fff' : c.textSub};
      " aria-pressed="${isLocal}">⚡ Local</button>
    </div>`;

  // ── Description ───────────────────────────────────────────────────────────
  const description = isLocal
    ? `<p class="ctx-intro">Analyzes your screen structure using built-in rules — <strong>no API key required</strong>. Generates layer names and a documentation frame locally.</p>`
    : `<p class="ctx-intro">Select a screen frame, then click <strong>Analyze Screen</strong>. Claude renames all layers with context-aware names and generates a documentation frame above your screen.</p>`;

  // ── AI-only: AI Mode toggle + API key status ──────────────────────────────
  const aiModeRow = !isLocal ? `
    <div style="
      display:flex;align-items:center;justify-content:space-between;
      padding:11px 13px;
      background:${c.surface};
      border:1.5px solid ${ctxOn && hasKey ? c.accent : c.border};
      border-radius:9px;margin-bottom:12px;transition:border-color 0.15s;
    ">
      <div>
        <div style="font-size:12px;font-weight:600;color:${c.text};">AI Mode</div>
        <div style="font-size:10px;color:${hasKey ? c.textSub : '#F59E0B'};margin-top:2px;">
          ${hasKey ? (ctxOn ? 'Active — Claude will analyze &amp; document your screen' : 'Off — toggle to enable') : '⚠ No API key — add one in the Renamer tab'}
        </div>
      </div>
      <button onclick="handleToggleContext()" ${!hasKey ? 'disabled' : ''} style="
        width:36px;height:20px;border-radius:10px;position:relative;
        cursor:${hasKey ? 'pointer' : 'not-allowed'};
        border:none;outline:none;padding:0;flex-shrink:0;
        background:${ctxOn && hasKey ? `linear-gradient(135deg,${c.accent},${c.accentEnd})` : c.surfaceHov};
        opacity:${hasKey ? '1' : '0.4'};
        box-shadow:${ctxOn && hasKey ? `0 0 0 3px ${state.isDark ? 'rgba(123,97,255,0.2)' : 'rgba(123,97,255,0.15)'}` : 'none'};
        transition:all 0.2s;
      " aria-label="Toggle AI Mode" aria-checked="${ctxOn}" role="switch">
        <div style="position:absolute;top:2px;left:${ctxOn && hasKey ? '18px' : '2px'};width:16px;height:16px;background:#fff;border-radius:50%;transition:left 0.15s ease;box-shadow:0 1px 3px rgba(0,0,0,0.3);"></div>
      </button>
    </div>` : '';

  // ── Analyze button ─────────────────────────────────────────────────────────
  const spinSvg = `<svg class="spin" width="13" height="13" viewBox="0 0 12 12" fill="none"><circle cx="6" cy="6" r="4.5" stroke="rgba(255,255,255,0.3)" stroke-width="1.5"/><path d="M6 1.5A4.5 4.5 0 0 1 10.5 6" stroke="white" stroke-width="1.5" stroke-linecap="round"/></svg>`;
  const sparkSvg = `<svg width="13" height="13" viewBox="0 0 13 13" fill="none"><path d="M6.5 1L7.8 5.2H12L8.6 7.8L9.9 12L6.5 9.4L3.1 12L4.4 7.8L1 5.2H5.2L6.5 1Z" stroke="white" stroke-width="1.2" stroke-linejoin="round" fill="rgba(255,255,255,0.15)"/></svg>`;
  const localSvg = `<svg width="13" height="13" viewBox="0 0 13 13" fill="none"><path d="M6.5 2L11 4.5V8.5L6.5 11L2 8.5V4.5L6.5 2Z" stroke="white" stroke-width="1.2" stroke-linejoin="round" fill="rgba(255,255,255,0.15)"/><circle cx="6.5" cy="6.5" r="1.6" fill="white"/></svg>`;

  const aiDisabled    = !isLocal && (running || !hasKey || !ctxOn);
  const localDisabled = isLocal && running;
  const btnDisabled   = isLocal ? localDisabled : aiDisabled;
  const btnAction     = isLocal ? (running ? '' : 'handleLocalAnalyze()') : (aiDisabled ? '' : 'handleAnalyzeContext()');
  const btnLabel      = running
    ? spinSvg + `<span style="margin-left:2px;">${state.contextStatus || 'Analyzing…'}</span>`
    : isLocal ? localSvg + ' Analyze Screen' : sparkSvg + ' Analyze Screen';

  const analyzeBtn = `
    <button class="ctx-btn" onclick="${btnAction}" ${btnDisabled ? 'disabled' : ''}
      aria-label="Analyze screen and generate documentation" aria-busy="${running}">
      ${btnLabel}
    </button>`;

  // ── Summary card ──────────────────────────────────────────────────────────
  const summaryCard = sum ? `
    <div style="margin-top:14px;background:${c.surface};border:1.5px solid ${c.border};border-radius:10px;overflow:hidden;">
      <div style="padding:10px 14px 9px;border-bottom:1px solid ${c.border};display:flex;align-items:center;gap:7px;">
        <div style="width:6px;height:6px;border-radius:50%;background:linear-gradient(135deg,${c.accent},${c.accentEnd});flex-shrink:0;"></div>
        <span style="font-size:11px;font-weight:600;color:${c.text};overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;">${sum.screenName}</span>
        <span style="font-size:9px;font-weight:700;color:${c.success};letter-spacing:0.4px;">DONE</span>
      </div>
      <div style="display:flex;border-bottom:1px solid ${c.border};">
        <div style="flex:1;padding:10px 12px;border-right:1px solid ${c.border};text-align:center;">
          <div style="font-size:18px;font-weight:700;color:${c.accent};line-height:1;">${sum.totalLayers}</div>
          <div style="font-size:10px;color:${c.textMuted};margin-top:3px;line-height:1.2;">layers<br>renamed</div>
        </div>
        <div style="flex:1;padding:10px 12px;text-align:center;">
          <div style="font-size:18px;font-weight:700;color:${c.accentAI};line-height:1;">${sum.interactions}</div>
          <div style="font-size:10px;color:${c.textMuted};margin-top:3px;line-height:1.2;">user<br>interactions</div>
        </div>
      </div>
      <div style="padding:8px 14px;display:flex;align-items:center;gap:5px;">
        <svg width="9" height="9" viewBox="0 0 9 9" fill="none"><rect x="1" y="1" width="7" height="7" rx="1.5" stroke="${c.textMuted}" stroke-width="1.2"/><path d="M2.5 3h4M2.5 5h3" stroke="${c.textMuted}" stroke-width="1" stroke-linecap="round"/></svg>
        <span style="font-size:10px;color:${c.textMuted};">Documentation frame created above screen</span>
      </div>
    </div>` : '';

  return `
    <div class="ctx-wrap" id="panel-context" role="tabpanel" aria-labelledby="tab-context">
      ${modeSwitcher}
      ${description}
      ${aiModeRow}
      ${analyzeBtn}
      ${running ? `<div style="font-size:10px;color:${c.accent};margin-top:8px;text-align:center;font-style:italic;">${state.contextStatus}</div>` : ''}
      ${summaryCard}
    </div>`;
}

// ─── Log Overlay ─────────────────────────────────────────────────────────────
function renderLogOverlay(c: ReturnType<typeof t>): string {
  const items = state.log.length === 0
    ? `<div class="sr-log-empty">Nothing renamed yet — start designing!</div>`
    : state.log.map((entry, i) => {
        const isNew = i === 0;
        const bg = isNew ? c.logItemNew : c.logItem;
        const color = isNew ? c.accent : c.textSub;
        const borderColor = isNew ? c.logBorderNew : 'transparent';
        return `<div class="sr-log-item" onclick="focusNode('${entry.nodeId}')"
          title="${entry.prevName ? 'Was: ' + entry.prevName : 'Click to jump to layer'}"
          role="button" aria-label="Jump to layer: ${entry.name}"
          style="background:${bg};color:${color};border-color:${borderColor};">
          <span class="sr-log-tag" style="background:${entry.ai ? c.tagAI : c.tagAuto};color:${entry.ai ? c.tagAIText : c.tagAutoText};">${entry.ai ? 'AI' : 'auto'}</span>
          <span class="sr-log-name">${entry.name}</span>
          <svg class="sr-jump-icon" width="9" height="9" viewBox="0 0 9 9" fill="none" aria-hidden="true">
            <path d="M1 8L8 1M8 1H3M8 1V6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </div>`;
      }).join('');

  return `
    <div class="sr-log-overlay" role="dialog" aria-label="Recent Renames" aria-modal="true">
      <div class="sr-log-overlay-header">
        <span class="sr-log-overlay-title">Recent Renames</span>
        <div class="sr-log-overlay-actions">
          ${state.log.length > 0 ? `<button class="sr-log-clear" onclick="clearLog()" aria-label="Clear rename history">clear</button>` : ''}
          <button class="sr-log-overlay-close" onclick="handleLogOverlay()" aria-label="Close overlay" title="Close">
            <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
              <path d="M2 2L11 11M11 2L2 11" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
            </svg>
          </button>
        </div>
      </div>
      <div class="sr-log-overlay-list" role="list">${items}</div>
    </div>`;
}

// ─── Render ───────────────────────────────────────────────────────────────────
function renderCollapsed() {
  injectStyles();
  const root = document.getElementById('root')!;
  // Ensure root itself has zero margin/padding so collapsed button is truly centered
  root.style.cssText = 'width:100%;height:100%;margin:0;padding:0;overflow:hidden;';
  root.innerHTML = `
    <div class="collapsed-wrap">
      <button class="collapsed-btn" onclick="handleExpand()" title="Expand Smart Renamer" aria-label="Expand Smart Renamer">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
          <path d="M3 9L7 5L11 9" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </button>
    </div>
  `;
}

function renderFull() {
  injectStyles();
  const c = t();
  const root = document.getElementById('root')!;

  // Status dot + label — reflects the true active state
  let dotClass = 'dot-paused';
  let statusLabel = 'Paused';
  if (state.isAnalyzing) {
    dotClass = 'dot-ai';
    statusLabel = `Analyzing${state.analyzeProgress ? ' · ' + state.analyzeProgress : '…'}`;
  } else if (state.isThinking) {
    dotClass = 'dot-ai';
    statusLabel = 'AI thinking…';
  } else if (state.isEnabled) {
    const activeAI = state.useAI && state.hasApiKey;
    dotClass = activeAI ? 'dot-ai' : 'dot-active';
    statusLabel = activeAI ? 'AI rename active' : 'Local rename active';
  }

  // aiToggleOn: only true when renamer is ON + key exists + AI enabled
  const aiToggleOn = state.isEnabled && state.useAI && state.hasApiKey;
  const mainToggleOn = state.isEnabled;

  const logItems = state.log.map((entry, i) => {
    const isNew = i === 0;
    const bg = isNew ? c.logItemNew : c.logItem;
    const color = isNew ? c.accent : c.textSub;
    const borderColor = isNew ? c.logBorderNew : 'transparent';
    return `
      <div
        class="sr-log-item"
        onclick="focusNode('${entry.nodeId}')"
        title="${entry.prevName ? 'Was: ' + entry.prevName : 'Click to jump to layer'}"
        role="button"
        aria-label="Jump to layer: ${entry.name}"
        style="background:${bg};color:${color};border-color:${borderColor};"
      >
        <span class="sr-log-tag" style="background:${entry.ai ? c.tagAI : c.tagAuto};color:${entry.ai ? c.tagAIText : c.tagAutoText};">
          ${entry.ai ? 'AI' : 'auto'}
        </span>
        <span class="sr-log-name">${entry.name}</span>
        <svg class="sr-jump-icon" width="9" height="9" viewBox="0 0 9 9" fill="none" aria-hidden="true">
          <path d="M1 8L8 1M8 1H3M8 1V6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </div>
    `;
  }).join('');

  root.innerHTML = `
    <div class="plugin-wrap" role="main">

      <!-- Header — branding + status only, no duplicate toggle -->
      <header class="sr-header">
        <img src="data:image/png;base64,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" alt="AI Realtime Renamer logo" style="width:24px;height:24px;border-radius:6px;display:block;" aria-hidden="true" />
        <div style="flex:1;min-width:0;">
          <div class="sr-title">AI Realtime Renamer</div>
          <div class="sr-subtitle">
            <span class="sr-dot ${dotClass}" aria-hidden="true"></span>
            <span>${statusLabel}</span>
          </div>
        </div>
      </header>

      <!-- Tab bar -->
      <nav class="sr-tabs" role="tablist" aria-label="Plugin sections">
        <button class="sr-tab ${state.activeTab === 'rename' ? 'active' : ''}" onclick="handleTabSwitch('rename')" role="tab" aria-selected="${state.activeTab === 'rename'}" id="tab-rename">Renamer</button>
        <button class="sr-tab ${state.activeTab === 'context' ? 'active' : ''}" onclick="handleTabSwitch('context')" role="tab" aria-selected="${state.activeTab === 'context'}" id="tab-context">Documentation</button>
      </nav>

      ${state.activeTab === 'rename' ? `

      <!-- Realtime Renamer — master toggle + AI Mode as nested sub-setting -->
      <div class="sr-section">

        <!-- Master row -->
        <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px;">
          <div style="flex:1;min-width:0;">
            <div style="font-size:12px;font-weight:600;color:${c.text};">Realtime Renamer</div>
            <div style="font-size:11px;color:${c.textSub};margin-top:2px;line-height:1.4;">
              ${!mainToggleOn
                ? 'Paused — toggle to start renaming'
                : aiToggleOn
                  ? 'Renaming with Claude AI as you design'
                  : 'Renaming with local rules as you design'}
            </div>
          </div>
          <button
            class="sr-toggle"
            onclick="handleToggle()"
            aria-pressed="${mainToggleOn}"
            aria-label="${mainToggleOn ? 'Pause' : 'Enable'} Realtime Renamer"
            style="margin-top:1px;flex-shrink:0;background:${mainToggleOn ? `linear-gradient(135deg,${c.accent},${c.accentEnd})` : c.surfaceHov};"
          >
            <div class="sr-toggle-thumb" style="left:${mainToggleOn ? '18px' : '2px'};"></div>
          </button>
        </div>

        <!-- AI Mode — sub-setting, indented, only interactive when Renamer is ON -->
        <div style="
          margin-top:10px;
          padding:10px 12px;
          border-radius:8px;
          background:${state.isDark ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.03)'};
          border:1px solid ${c.border};
          opacity:${mainToggleOn ? '1' : '0.4'};
          transition:opacity 0.2s;
        ">
          <!-- AI Mode header row -->
          <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px;">
            <div style="flex:1;min-width:0;">
              <div style="display:flex;align-items:center;gap:5px;">
                <span style="font-size:11px;font-weight:600;color:${c.text};">AI Mode</span>
                <div class="sr-info-wrap">
                  <div
                    class="sr-info-icon"
                    onmouseenter="showTooltip(this,'When enabled, Claude Haiku renames every frame in real time — local rules are bypassed. Rename Selected uses Claude Sonnet with full tree context. Real-time: ~$0.0002/rename. Rename Selected: ~$0.002/tree.')"
                    onmouseleave="hideTooltip()"
                  >i</div>
                </div>
              </div>
              <div style="font-size:10px;color:${c.textSub};margin-top:2px;">
                ${!state.hasApiKey
                  ? `<span style="color:${c.textMuted};">Add API key to enable</span>`
                  : aiToggleOn
                    ? `<span style="color:${c.accentAI};">● Active — Claude Haiku</span>`
                    : `<span style="color:${c.textMuted};">Off — using local rules</span>`
                }
              </div>
            </div>
            <button
              class="sr-toggle"
              onclick="${mainToggleOn ? 'handleToggleAI()' : ''}"
              aria-pressed="${aiToggleOn}"
              aria-label="${aiToggleOn ? 'Disable' : 'Enable'} AI Mode"
              style="
                flex-shrink:0;
                margin-top:1px;
                background:${aiToggleOn ? `linear-gradient(135deg,${c.accentAI},#FFAE00)` : c.surfaceHov};
                opacity:${(mainToggleOn && state.hasApiKey) ? '1' : '0.4'};
                cursor:${(mainToggleOn && state.hasApiKey) ? 'pointer' : 'not-allowed'};
              "
            >
              <div class="sr-toggle-thumb" style="left:${aiToggleOn ? '18px' : '2px'};"></div>
            </button>
          </div>

          <!-- API key input — shown when AI is on or no key saved yet -->
          ${(state.useAI || !state.hasApiKey) ? `
          <div style="margin-top:8px;">
            <div class="sr-input-row">
              <input
                id="apiKeyInput"
                type="password"
                class="sr-input"
                placeholder="${state.hasApiKey ? '••••••••••••••••' : 'sk-ant-api...'}"
                aria-label="Anthropic API Key"
                autocomplete="off"
              />
              <button class="sr-btn sr-btn-primary" onclick="handleSaveKey()" aria-label="Save API key">Save</button>
            </div>
            ${state.hasApiKey ? `
            <div class="sr-test-row">
              <span id="test-status" aria-live="polite" style="font-size:10px;color:${c.textMuted};">Verify your key works</span>
              <button class="sr-btn sr-btn-ghost" onclick="handleTestKey()" style="padding:4px 10px;font-size:10px;" aria-label="Test API connection">
                Test
              </button>
            </div>
            ` : ''}
          </div>
          ` : ''}
        </div>
      </div>

      <!-- Layer Health (computed before template) -->
      ${renderHealthPanel(c)}

      <!-- Actions -->
      <div class="sr-section">
        <div class="sr-actions">
          <div class="sr-actions-row">
            <button class="sr-action-btn ${state.loadingBtn === 'renameSelected' ? 'sr-btn-loading' : ''}" onclick="${state.loadingBtn ? '' : 'handleFixSelected()'}" title="${state.useAI ? 'Analyze selected frame + full tree with Claude Sonnet for best accuracy' : 'Re-evaluate selected frame with local rules'}" aria-label="Quick rename selected frame or layer">
              ${state.loadingBtn === 'renameSelected' ? `<svg class=\"spin\" width=\"11\" height=\"11\" viewBox=\"0 0 12 12\" fill=\"none\"><circle cx=\"6\" cy=\"6\" r=\"4.5\" stroke=\"rgba(123,97,255,0.25)\" stroke-width=\"1.5\"/><path d=\"M6 1.5A4.5 4.5 0 0 1 10.5 6\" stroke=\"currentColor\" stroke-width=\"1.5\" stroke-linecap=\"round\"/></svg> Processing…` : `<svg width="11" height="11" viewBox="0 0 11 11" fill="none" aria-hidden="true">
                <path d="M9.5 5.5A4 4 0 1 1 5.5 1.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
                <path d="M5.5 1.5L7.5 0M5.5 1.5L7.5 3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
              Quick Rename`}
            </button>
            <button class="sr-action-btn ${state.loadingBtn === 'renameEverything' ? 'sr-btn-loading' : ''}" onclick="${state.loadingBtn ? '' : 'handleRenamePage()'}" title="Rename all unnamed layers on this page" aria-label="Rename all unnamed layers on this page">
              ${state.loadingBtn === 'renameEverything' ? `<svg class=\"spin\" width=\"11\" height=\"11\" viewBox=\"0 0 12 12\" fill=\"none\"><circle cx=\"6\" cy=\"6\" r=\"4.5\" stroke=\"rgba(123,97,255,0.25)\" stroke-width=\"1.5\"/><path d=\"M6 1.5A4.5 4.5 0 0 1 10.5 6\" stroke=\"currentColor\" stroke-width=\"1.5\" stroke-linecap=\"round\"/></svg> Processing…` : `<svg width="11" height="11" viewBox="0 0 11 11" fill="none" aria-hidden="true">
                <rect x="1" y="1" width="3.5" height="3.5" rx="1" stroke="currentColor" stroke-width="1.3"/>
                <rect x="6.5" y="1" width="3.5" height="3.5" rx="1" stroke="currentColor" stroke-width="1.3"/>
                <rect x="1" y="6.5" width="3.5" height="3.5" rx="1" stroke="currentColor" stroke-width="1.3"/>
                <rect x="6.5" y="6.5" width="3.5" height="3.5" rx="1" stroke="currentColor" stroke-width="1.3"/>
              </svg>
              Rename Entire Page`}
            </button>
          </div>
          <button
            class="ctx-btn"
            style="margin-top:4px;"
            onclick="${state.isAnalyzing ? '' : 'handleScanNested()'}"
            ${state.isAnalyzing ? 'disabled' : ''}
            aria-label="Analyze and rename all nested layers"
            aria-busy="${state.isAnalyzing}"
          >
            ${state.isAnalyzing ? `
              <svg class="spin" width="13" height="13" viewBox="0 0 12 12" fill="none">
                <circle cx="6" cy="6" r="4.5" stroke="rgba(255,255,255,0.3)" stroke-width="1.5"/>
                <path d="M6 1.5A4.5 4.5 0 0 1 10.5 6" stroke="white" stroke-width="1.5" stroke-linecap="round"/>
              </svg>
              Analyzing…
            ` : `Analyze and Rename Nested Layers`}
          </button>
        </div>
      </div>

      <!-- Recent Renames -->
      <div class="sr-log-wrap">
        <div class="sr-log-header">
          <span class="sr-log-title">Recent Renames</span>
          <div style="display:flex;align-items:center;gap:8px;">
            ${state.log.length > 0 ? `<button class="sr-log-clear" onclick="clearLog()" aria-label="Clear rename history">clear</button>` : ''}
            <button
              class="sr-log-expand-btn"
              onclick="handleLogOverlay()"
              aria-label="View all recent renames"
              title="Expand"
            >
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                <path d="M1.5 4.5L4.5 1.5M4.5 1.5H2M4.5 1.5V4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
                <path d="M10.5 7.5L7.5 10.5M7.5 10.5H10M7.5 10.5V8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
            </button>
          </div>
        </div>
        <div class="sr-log-list" role="list" aria-label="Recent renames">
          ${state.log.length === 0
            ? `<div class="sr-log-empty">Nothing renamed yet — start designing!</div>`
            : logItems
          }
        </div>
      </div>

      <!-- Status -->
      <div class="sr-status" aria-live="polite">${state.statusText}</div>

      ` : renderContextPanel(c)}

      <!-- Footer -->
      <footer class="sr-footer">
        <div class="sr-author" style="position:relative;display:flex;align-items:center;gap:16px;">
          <span class="sr-byline" style="cursor:default;">by
            <span
              onmouseenter="showAuthorTooltip()"
              onmouseleave="hideAuthorTooltip()"
              style="cursor:pointer;text-decoration:underline dotted;text-underline-offset:2px;"
            >Pleurat</span>
          </span>
          <a href="https://pleurat.com/ai-realtime-renamer-plugin" target="_blank"
            style="display:flex;align-items:center;gap:4px;font-size:11px;color:${c.textMuted};text-decoration:none;cursor:pointer;"
            onmouseenter="this.style.color='${c.textSub}'"
            onmouseleave="this.style.color='${c.textMuted}'"
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
              <path d="M2 2h3.5M2 5h6M2 8h6M2 11h4.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
              <path d="M7 1h3.5V4.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
            Docs
          </a>
        </div>
        <button class="sr-collapse-btn" onclick="handleCollapse()" aria-label="Collapse plugin">
          <svg width="11" height="11" viewBox="0 0 11 11" fill="none" aria-hidden="true">
            <path d="M1.5 3.5L5.5 7.5L9.5 3.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          Collapse
        </button>
      </footer>

      <!-- Log overlay — shown when user clicks expand on Recent Renames -->
      ${state.isLogOverlay ? renderLogOverlay(c) : ''}

      <!-- Global floating tooltip (JS-positioned, never overflows) -->
      <div id="sr-global-tooltip" style="
        display:none;
        position:fixed;
        left:16px;right:16px;
        background:${c.surface};
        border:1px solid ${c.border};
        border-radius:8px;
        padding:10px 12px;
        font-size:11px;
        color:${c.textSub};
        line-height:1.55;
        z-index:9999;
        box-shadow:${c.shadow};
        pointer-events:none;
      "></div>

      <!-- Author tooltip — pointer-events:all so link is clickable;
           padding-bottom extends the hit area to bridge gap to footer -->
      <div id="sr-author-tooltip"
        onmouseenter="keepAuthorTooltip()"
        onmouseleave="hideAuthorTooltip()"
        style="
          display:none;
          position:fixed;
          left:16px;right:16px;bottom:42px;
          background:${c.surface};
          border:1px solid ${c.border};
          border-radius:8px;
          padding:10px 12px 14px;
          font-size:11px;
          color:${c.textSub};
          line-height:1.6;
          z-index:9999;
          box-shadow:${c.shadow};
          pointer-events:all;
        ">
        Want to know more about the author?<br>
        Visit the <a href="https://www.linkedin.com/in/pleuratshala/" target="_blank" style="color:${c.accent};text-decoration:underline;">LinkedIn profile ↗</a>
      </div>

    </div>
  `;
}

function render() {
  if (state.isCollapsed) renderCollapsed();
  else renderFull();
}

// ─── Tooltip handlers (JS-positioned, never overflow) ────────────────────────
(window as any).showTooltip = (anchor: HTMLElement, text: string) => {
  const el = document.getElementById('sr-global-tooltip');
  if (!el) return;
  el.textContent = text;
  // Position below anchor, but clamp so it stays inside viewport
  const rect = anchor.getBoundingClientRect();
  const winH = window.innerHeight;
  const tooltipH = 80; // estimated
  let top = rect.bottom + 6;
  if (top + tooltipH > winH - 16) top = rect.top - tooltipH - 6;
  el.style.top = `${Math.max(8, top)}px`;
  el.style.display = 'block';
};
(window as any).hideTooltip = () => {
  const el = document.getElementById('sr-global-tooltip');
  if (el) el.style.display = 'none';
};
let _authorHideTimer: ReturnType<typeof setTimeout> | null = null;

(window as any).showAuthorTooltip = () => {
  if (_authorHideTimer) { clearTimeout(_authorHideTimer); _authorHideTimer = null; }
  const el = document.getElementById('sr-author-tooltip');
  if (el) el.style.display = 'block';
};
// keepAuthorTooltip — called when mouse enters the tooltip itself
(window as any).keepAuthorTooltip = () => {
  if (_authorHideTimer) { clearTimeout(_authorHideTimer); _authorHideTimer = null; }
};
(window as any).hideAuthorTooltip = () => {
  // Small delay so moving mouse from "Pleurat" → tooltip doesn't flicker
  _authorHideTimer = setTimeout(() => {
    const el = document.getElementById('sr-author-tooltip');
    if (el) el.style.display = 'none';
    _authorHideTimer = null;
  }, 120);
};
(window as any).handleToggle = () => {
  state.isEnabled = !state.isEnabled;
  // When Realtime Renamer is turned OFF, AI Mode must also be off —
  // there's nothing to apply AI to, so the sub-setting is meaningless active.
  if (!state.isEnabled && state.useAI) {
    state.useAI = false;
    parent.postMessage({ pluginMessage: { type: 'toggleAI', value: false } }, '*');
  }
  parent.postMessage({ pluginMessage: { type: 'toggle', value: state.isEnabled } }, '*');
  render();
};

(window as any).handleToggleAI = () => {
  // Guard: Realtime Renamer must be ON and API key must exist
  if (!state.isEnabled || !state.hasApiKey) return;
  state.useAI = !state.useAI;
  parent.postMessage({ pluginMessage: { type: 'toggleAI', value: state.useAI } }, '*');
  render();
};

(window as any).handleSaveKey = () => {
  const val = (document.getElementById('apiKeyInput') as HTMLInputElement)?.value?.trim();
  if (!val) return;
  state.hasApiKey = true;
  state.useAI = true;
  parent.postMessage({ pluginMessage: { type: 'setApiKey', value: val } }, '*');
  parent.postMessage({ pluginMessage: { type: 'toggleAI', value: true } }, '*');
  render();
};

(window as any).handleTestKey = () => {
  const statusEl = document.getElementById('test-status');
  if (statusEl) { statusEl.textContent = 'Testing…'; (statusEl as HTMLElement).style.color = t().accent; }
  parent.postMessage({ pluginMessage: { type: 'getApiKey' } }, '*');
};

(window as any).runApiTest = async (apiKey: string) => {
  const statusEl = document.getElementById('test-status');
  const c = t();
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 5,
        messages: [{ role: 'user', content: 'Say: ok' }],
      }),
    });
    const data = await res.json();
    if (res.ok && data?.content?.[0]?.text) {
      if (statusEl) { statusEl.textContent = '✓ Connected — key works!'; (statusEl as HTMLElement).style.color = c.success; }
    } else {
      const errMsg = data?.error?.message || `HTTP ${res.status}`;
      if (statusEl) { statusEl.textContent = `✗ ${errMsg}`; (statusEl as HTMLElement).style.color = c.danger; }
    }
  } catch {
    if (statusEl) { statusEl.textContent = '✗ Network error'; (statusEl as HTMLElement).style.color = c.danger; }
  }
};

// ─── Loading helper ───────────────────────────────────────────────────────────
let _loadingTimer: ReturnType<typeof setTimeout> | null = null;
function startLoading(btn: string) {
  if (_loadingTimer) clearTimeout(_loadingTimer);
  _loadingTimer = setTimeout(() => {
    state.loadingBtn = btn;
    render();
    _loadingTimer = null;
  }, 600); // show loading after 600ms — avoids flash on fast ops
}
function stopLoading() {
  if (_loadingTimer) { clearTimeout(_loadingTimer); _loadingTimer = null; }
  if (state.loadingBtn !== null) { state.loadingBtn = null; render(); }
}

(window as any).handleFixSelected = () => {
  parent.postMessage({ pluginMessage: { type: 'checkSelection', then: 'fixSelected' } }, '*');
};

(window as any).handleRenamePage = () => {
  startLoading('renameEverything');
  parent.postMessage({ pluginMessage: { type: 'renameAll' } }, '*');
};

(window as any).handleAnalyzeRename = () => {
  if (state.isAnalyzing) return;
  state.isAnalyzing = true;
  state.analyzeProgress = '';
  render();
  parent.postMessage({ pluginMessage: { type: 'analyzeRename' } }, '*');
};

(window as any).handleCollapse = () => {
  state.isCollapsed = true;
  state.isLogOverlay = false;
  render();
  parent.postMessage({ pluginMessage: { type: 'resize', width: 64, height: 64 } }, '*');
};

(window as any).handleExpand = () => {
  state.isCollapsed = false;
  render();
  parent.postMessage({ pluginMessage: { type: 'resize', width: 320, height: 560 } }, '*');
};

(window as any).clearLog = () => {
  state.log = [];
  parent.postMessage({ pluginMessage: { type: 'saveLog', log: [] } }, '*');
  render();
};

(window as any).handleToggleHealth = () => {
  state.isHealthExpanded = !state.isHealthExpanded;
  render();
};

(window as any).handlePointLayers = () => {
  parent.postMessage({ pluginMessage: { type: 'pointLayers' } }, '*');
};

(window as any).handleCheckLayerHealth = () => {
  startLoading('checkHealth');
  parent.postMessage({ pluginMessage: { type: 'healthScan' } }, '*');
};

(window as any).handleScanNested = () => {
  if (state.isAnalyzing) return;
  parent.postMessage({ pluginMessage: { type: 'checkSelection', then: 'scanNested' } }, '*');
};


(window as any).focusNode = (nodeId: string) => {
  parent.postMessage({ pluginMessage: { type: 'focusNode', nodeId } }, '*');
};

(window as any).handleTabSwitch = (tab: string) => {
  state.activeTab = tab as 'rename' | 'context';
  render();
};

// handleCopyDoc removed — doc is now shown in Figma frame only

(window as any).handleToggleContext = () => {
  if (!state.hasApiKey) return;
  state.contextEnabled = !state.contextEnabled;
  render();
};

(window as any).handleLogOverlay = () => {
  state.isLogOverlay = !state.isLogOverlay;
  render();
};

(window as any).handleAnalyzeContext = () => {
  if (state.isContextRunning || !state.hasApiKey || !state.contextEnabled) return;
  state.isContextRunning = true;
  state.contextStatus = 'Reading screen…';
  state.contextSummary = null;
  render();
  parent.postMessage({ pluginMessage: { type: 'contextAnalyze' } }, '*');
};

(window as any).handleDocModeSwitch = (mode: string) => {
  state.docMode = mode as 'ai' | 'local';
  state.contextSummary = null;
  render();
};

(window as any).handleLocalAnalyze = () => {
  if (state.isContextRunning) return;
  state.isContextRunning = true;
  state.contextStatus = 'Analyzing layers…';
  state.contextSummary = null;
  render();
  parent.postMessage({ pluginMessage: { type: 'localDocAnalyze' } }, '*');
};

// ─── Messages from Plugin ─────────────────────────────────────────────────────
window.onmessage = async (event) => {
  const msg = event.data.pluginMessage;
  if (!msg) return;

  if (msg.type === 'init') {
    state.isEnabled = msg.isEnabled;
    state.useAI = msg.useAI;
    state.hasApiKey = msg.hasApiKey;
    render();
  }

  if (msg.type === 'renamed') {
    state.log.unshift({
      name: msg.layerName,
      prevName: msg.prevName || '',
      ai: !!msg.ai,
      nodeId: msg.nodeId || '',
    });
    if (state.log.length > 50) state.log.pop();
    // Persist log so it survives plugin close/reopen
    parent.postMessage({ pluginMessage: { type: 'saveLog', log: state.log } }, '*');
    render();
  }

  if (msg.type === 'restoreLog') {
    if (Array.isArray(msg.log)) {
      state.log = msg.log.slice(0, 50);
      render();
    }
  }

  if (msg.type === 'renameAllDone') { stopLoading(); render(); }

  if (msg.type === 'checkSelectionOk') {
    if (msg.then === 'fixSelected') {
      startLoading('renameSelected');
      render();
      parent.postMessage({ pluginMessage: { type: 'fixSelected' } }, '*');
    } else if (msg.then === 'scanNested') {
      state.isAnalyzing = true;
      state.analyzeProgress = '';
      render();
      if (state.hasApiKey) {
        parent.postMessage({ pluginMessage: { type: 'contextAnalyze', scanOnly: true } }, '*');
      } else {
        parent.postMessage({ pluginMessage: { type: 'analyzeRename' } }, '*');
      }
    }
  }

  if (msg.type === 'aiThinking') {
    state.isThinking = msg.value;
    render();
  }

  if (msg.type === 'status') {
    state.statusText = msg.text;
    stopLoading();
    render();
    setTimeout(() => { state.statusText = ''; render(); }, 3500);
  }

  if (msg.type === 'analyzeProgress') {
    state.analyzeProgress = msg.text;
    render();
  }

  if (msg.type === 'analyzeDone') {
    state.isAnalyzing = false;
    state.analyzeProgress = '';
    stopLoading();
    render();
  }

  if (msg.type === 'healthResult') {
    state.health = { total: msg.total, unnamed: msg.unnamed };
    stopLoading();
    render();
  }

  if (msg.type === 'apiKeyForTest') {
    (window as any).runApiTest(msg.apiKey);
  }

  if (msg.type === 'contextProgress') {
    state.contextStatus = msg.text;
    render();
  }

  if (msg.type === 'contextSummary') {
    // Main has finished building the doc frame — now show the summary
    state.isContextRunning = false;
    state.contextStatus = '';
    state.contextSummary = {
      totalLayers: msg.totalLayers,
      components: msg.components,
      interactions: msg.interactions,
      screenName: msg.screenName,
    };
    render();
  }

  if (msg.type === 'contextNodes') {
    (window as any)._pendingContextNodes = msg.nodes;
    (window as any)._pendingContextTexts = msg.textSamples;
    (window as any)._pendingScreenName = msg.screenName || 'Screen';
    (window as any)._pendingScreenNodeId = msg.screenNodeId || null;
    (window as any)._pendingScanOnly = !!msg.scanOnly;
    if (!msg.scanOnly) {
      state.contextStatus = 'Reading your screen…';
      render();
    }
  }

  if (msg.type === 'apiKeyForContext') {
    const nodes = (window as any)._pendingContextNodes;
    const texts = (window as any)._pendingContextTexts || [];
    const screenName = (window as any)._pendingScreenName || 'Screen';
    const screenNodeId = (window as any)._pendingScreenNodeId || null;
    if (!nodes) return;
    if (!msg.apiKey) {
      const fromScan = (window as any)._pendingScanOnly;
      if (fromScan) {
        state.isAnalyzing = false;
        stopLoading();
      } else {
        state.isContextRunning = false;
        state.contextStatus = '✗ No API key — add one in the Rename tab';
      }
      render();
      return;
    }
    try {
      state.contextStatus = 'Claude is analyzing your screen…';
      render();
      const scanOnly = !!(window as any)._pendingScanOnly;
      const result = await callClaudeContext(msg.apiKey, nodes, texts, scanOnly);
      if (!result) throw new Error('No result');

      // Count bullet items per section for stats
      const secParts = result.doc.split('## ');
      let intCount = 0;
      for (const part of secParts) {
        const bullets = (part.match(/^[-•*]/gm) || []).length;
        if (part.startsWith('User Interactions')) intCount = bullets;
      }
      const nameCount = Object.keys(result.names).length;

      state.contextStatus = 'Renaming layers…';
      render();
      const fromScan = (window as any)._pendingScanOnly;
      if (fromScan) {
        // Scan & Rename path — apply names then finish, no doc frame, no summary card
        parent.postMessage({ pluginMessage: { type: 'contextApplyNames', names: result.names } }, '*');
        state.isAnalyzing = false;
        state.analyzeProgress = '';
        stopLoading();
        render();
        return;
      }

      parent.postMessage({ pluginMessage: { type: 'contextApplyNames', names: result.names } }, '*');

      state.contextStatus = 'Building documentation frame…';
      render();
      parent.postMessage({
        pluginMessage: {
          type: 'contextBuildDocFrame',
          doc: result.doc,
          screenName,
          screenNodeId,
          stats: {
            totalLayers: nameCount,
            components: 0,
            interactions: intCount || 4,
          },
        },
      }, '*');
      // Wait for contextSummary message from main before finishing
      // (main sends it after the frame is actually created on canvas)
    } catch {
      const fromScan = (window as any)._pendingScanOnly;
      if (fromScan) {
        state.isAnalyzing = false;
        stopLoading();
      } else {
        state.isContextRunning = false;
        state.contextStatus = '✗ Claude could not analyze this screen';
      }
      render();
    }
  }

  if (msg.type === 'aiRequest') {
    try {
      const name = await callClaudeAPI(msg.apiKey, msg.structure);
      if (name) {
        state.log.unshift({ name, prevName: '', ai: true, nodeId: msg.nodeId || '' });
        if (state.log.length > 50) state.log.pop();
        render();
      }
      parent.postMessage({ pluginMessage: { type: 'aiResponse', id: msg.id, name } }, '*');
    } catch {
      parent.postMessage({ pluginMessage: { type: 'aiResponse', id: msg.id, name: null } }, '*');
    }
  }

  if (msg.type === 'localDocResult') {
    if (msg.error) {
      state.isContextRunning = false;
      state.contextStatus = '✗ Select a frame first';
      render();
      setTimeout(() => { state.contextStatus = ''; render(); }, 3000);
      return;
    }
    state.contextStatus = 'Building documentation frame…';
    render();
    parent.postMessage({
      pluginMessage: {
        type: 'contextBuildDocFrame',
        doc: msg.doc,
        screenName: msg.screenName,
        screenNodeId: msg.screenNodeId,
        stats: msg.stats,
      },
    }, '*');
  }

  if (msg.type === 'aiAnalyzeBatch') {
    try {
      const nameMap = await callClaudeBatch(msg.apiKey, msg.nodes);
      const result: Record<string, string> = {};
      nameMap.forEach((v, k) => { result[k] = v; });
      parent.postMessage({ pluginMessage: { type: 'aiAnalyzeBatchResult', id: msg.id || null, result } }, '*');
    } catch {
      parent.postMessage({ pluginMessage: { type: 'aiAnalyzeBatchResult', id: msg.id || null, result: {} } }, '*');
    }
  }
};

// Update manifest resize on init
parent.postMessage({ pluginMessage: { type: 'resize', width: 320, height: 560 } }, '*');
render();
