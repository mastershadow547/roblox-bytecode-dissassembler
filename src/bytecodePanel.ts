import * as vscode from "vscode";
import { CompileResult, CompileOptions } from "./luauCompiler";
import { highlightBytecode } from "./highlighter";

export class BytecodePanel {
    private static instance: BytecodePanel | undefined;

    private readonly panel: vscode.WebviewPanel;
    private disposed = false;
    private ready = false;
    private pending: any[] = [];
    private lastRawOutput = "";
    private watchdogTimer: NodeJS.Timeout | undefined;

    private constructor(panel: vscode.WebviewPanel, onStuck?: () => void) {
        this.panel = panel;
        this.panel.webview.options = { enableScripts: true };

        this.panel.onDidDispose(() => {
            this.disposed = true;
            if (this.watchdogTimer) clearTimeout(this.watchdogTimer);
            if (BytecodePanel.instance === this) {
                BytecodePanel.instance = undefined;
            }
        });

        this.panel.webview.onDidReceiveMessage((msg) => {
            if (msg?.type === "ready") {
                this.ready = true;
                if (this.watchdogTimer) clearTimeout(this.watchdogTimer);
                this.flushPending();
            }
        });

        if (onStuck) {
            this.watchdogTimer = setTimeout(() => {
                if (!this.ready && !this.disposed) {
                    onStuck();
                }
            }, 4000);
        }

        this.panel.webview.html = this.renderShell();
    }

    static isOpen(): boolean {
        return BytecodePanel.instance !== undefined && !BytecodePanel.instance.disposed;
    }

    static createNew(onStuck?: () => void): BytecodePanel {
        const panel = vscode.window.createWebviewPanel(
            "luauBytecodeView",
            "Luau Bytecode",
            { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
            { enableScripts: true, retainContextWhenHidden: true }
        );
        const instance = new BytecodePanel(panel, onStuck);
        BytecodePanel.instance = instance;
        return instance;
    }

    static revive(panel: vscode.WebviewPanel, onStuck?: () => void): BytecodePanel {
        if (BytecodePanel.instance && !BytecodePanel.instance.disposed) {
            try { BytecodePanel.instance.panel.dispose(); } catch { /* already gone */ }
        }
        const instance = new BytecodePanel(panel, onStuck);
        BytecodePanel.instance = instance;
        return instance;
    }

    static getOrCreate(onStuck?: () => void): BytecodePanel {
        if (!BytecodePanel.instance || BytecodePanel.instance.disposed) {
            return BytecodePanel.createNew(onStuck);
        }
        return BytecodePanel.instance;
    }

    static forceRecreate(onStuck?: () => void): BytecodePanel {
        if (BytecodePanel.instance && !BytecodePanel.instance.disposed) {
            try { BytecodePanel.instance.panel.dispose(); } catch { /* already gone */ }
        }
        BytecodePanel.instance = undefined;
        return BytecodePanel.createNew(onStuck);
    }

    reveal() {
        this.panel.reveal(vscode.ViewColumn.Beside, true);
    }

    onMessage(handler: (msg: any) => void) {
        this.panel.webview.onDidReceiveMessage(handler);
    }

    getLastRawOutput(): string {
        return this.lastRawOutput;
    }

    private flushPending() {
        for (const msg of this.pending) this.panel.webview.postMessage(msg);
        this.pending = [];
    }

    private post(msg: any) {
        if (this.ready) {
            this.panel.webview.postMessage(msg);
        } else {
            this.pending.push(msg);
            if (this.pending.length > 20) this.pending.shift();
        }
    }

    showLoading(fileName: string, usingSelection = false) {
        this.post({ type: "loading", fileName, usingSelection });
    }

    showResult(fileName: string, result: CompileResult, options: CompileOptions, usingSelection: boolean) {
        const debug = {
            commandLine: result.commandLine,
            compilerPath: result.compilerPath,
            rawStderr: result.rawStderr,
            stats: result.stats,
            elapsedMs: result.elapsedMs,
            hint: result.hint
        };

        if (!result.ok && result.rawError) {
            this.lastRawOutput = "";
            this.post({ type: "error", fileName, message: result.rawError, options, debug, usingSelection });
            return;
        }

        if (result.diagnostics.length > 0) {
            this.lastRawOutput = "";
            this.post({ type: "diagnostics", fileName, diagnostics: result.diagnostics, options, debug, usingSelection });
            return;
        }

        this.lastRawOutput = result.output;

        const threshold = vscode.workspace
            .getConfiguration("luauBytecode")
            .get<number>("largeOutputThreshold", 4000);

        const { html, totalLines, simplified, edges, rawOutput } = highlightBytecode(
            result.output,
            result.usedSourceCode,
            threshold
        );

        this.post({
            type: "result",
            fileName,
            html,
            totalLines,
            simplified,
            rawOutput,
            edges,
            stats: result.stats,
            elapsedMs: result.elapsedMs,
            options,
            debug,
            usingSelection
        });
    }

    private renderShell(): string {
        return /* html */ `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8" />
<style>
    :root { 
        color-scheme: dark light;
        --indent-size: 15px; 
    }
    * { box-sizing: border-box; }

    body {
        font-family: var(--vscode-editor-font-family, monospace);
        font-size: 13px;
        background: var(--vscode-editor-background);
        color: var(--vscode-editor-foreground);
        margin: 0;
    }

    #header { position: sticky; top: 0; z-index: 5; background: var(--vscode-editor-background); border-bottom: 1px solid var(--vscode-panel-border); }
    #toolbar { display: flex; align-items: center; gap: 6px; padding: 8px 10px; flex-wrap: wrap; }

    #searchBox {
        flex: 1; min-width: 120px;
        background: var(--vscode-input-background); color: var(--vscode-input-foreground);
        border: 1px solid var(--vscode-input-border, transparent);
        padding: 5px 8px; border-radius: 4px; font-family: inherit; font-size: 12px;
    }
    #searchBox:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }

    .icon-btn {
        background: transparent; color: var(--vscode-foreground);
        border: 1px solid var(--vscode-panel-border);
        padding: 5px 10px; border-radius: 4px; cursor: pointer;
        font-size: 12px; font-family: inherit; white-space: nowrap; position: relative;
    }
    .icon-btn:hover { background: var(--vscode-toolbar-hoverBackground); }
    .icon-btn.active { border-color: var(--vscode-focusBorder); color: var(--vscode-focusBorder); }

    #infoRow { display: flex; align-items: center; gap: 8px; padding: 0 10px 8px 10px; font-size: 11px; opacity: 0.75; flex-wrap: wrap; }
    #fileName { font-weight: 600; opacity: 1; }
    .spinner {
        width: 10px; height: 10px; border: 2px solid var(--vscode-panel-border);
        border-top-color: var(--vscode-focusBorder); border-radius: 50%;
        animation: spin 0.7s linear infinite; display: inline-block; vertical-align: middle; margin-right: 4px;
    }
    @keyframes spin { to { transform: rotate(360deg); } }

    .pill { background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); padding: 1px 8px; border-radius: 10px; font-size: 10.5px; }
    .pill.warn { background: var(--vscode-editorWarning-foreground, #cca700); color: #000; }
    .pill.info { background: var(--vscode-focusBorder); color: #fff; }

    .popover {
        display: none; position: absolute; right: 10px; top: 46px;
        background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
        border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 12px; z-index: 6;
        box-shadow: 0 4px 14px rgba(0,0,0,0.4); min-width: 260px; max-width: 420px;
        max-height: 70vh; overflow-y: auto;
    }
    .popover.open { display: block; }

    .setting-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 5px 0; font-size: 12px; }
    .setting-row select {
        background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground);
        border: 1px solid var(--vscode-dropdown-border, transparent); border-radius: 4px; padding: 2px 4px; font-family: inherit; font-size: 12px;
    }
    .setting-row label { display: flex; align-items: center; gap: 6px; cursor: pointer; }
    .setting-title { font-size: 10.5px; text-transform: uppercase; opacity: 0.55; letter-spacing: 0.04em; margin: 6px 0 2px 0; }
    .setting-title:first-child { margin-top: 0; }
    .setting-hint { font-size: 10px; opacity: 0.55; margin-top: -2px; margin-bottom: 4px; }

    #debugPanel .debug-row { font-size: 11px; margin-bottom: 8px; }
    #debugPanel .debug-label { opacity: 0.6; margin-bottom: 2px; }
    #debugPanel pre {
        background: var(--vscode-textCodeBlock-background, rgba(127,127,127,0.1));
        padding: 6px 8px; border-radius: 4px; margin: 0; white-space: pre-wrap; word-break: break-all;
        font-size: 11px; max-height: 160px; overflow-y: auto;
    }
    .debug-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; font-size: 11px; }
    .debug-grid .k { opacity: 0.6; }

    #hintBanner, #largeBanner {
        display: none; margin: 10px 14px 0 14px; padding: 8px 12px; border-radius: 4px;
        border-left: 3px solid var(--vscode-editorWarning-foreground, #cca700);
        background: var(--vscode-inputValidation-warningBackground, transparent);
        font-size: 11.5px;
    }
    #hintBanner.show, #largeBanner.show { display: block; }

    #stringsPanel .string-row {
        border: 1px solid var(--vscode-panel-border); border-radius: 4px;
        padding: 6px 8px; margin-bottom: 6px; font-size: 11px;
    }
    #stringsPanel .string-original { word-break: break-all; margin-bottom: 4px; }
    #stringsPanel .string-actions { display: flex; gap: 4px; flex-wrap: wrap; }
    #stringsPanel .string-actions button {
        font-size: 10px; padding: 2px 6px; border-radius: 3px; cursor: pointer;
        border: 1px solid var(--vscode-panel-border); background: transparent; color: var(--vscode-foreground);
    }
    #stringsPanel .string-actions button:hover { background: var(--vscode-toolbar-hoverBackground); }
    #stringsPanel .decode-result {
        margin-top: 4px; padding: 4px 6px; border-radius: 3px;
        background: var(--vscode-textCodeBlock-background, rgba(127,127,127,0.1));
        white-space: pre-wrap; word-break: break-all; display: none;
    }
    #stringsPanel .decode-result.show { display: block; }
    #stringsEmpty { opacity: 0.6; font-size: 11px; padding: 10px; text-align: center; }

    #contentWrapper { position: relative; }
    #arrowLayer { position: absolute; top: 0; left: 0; pointer-events: none; z-index: 1; }

    /* The new 165px wide gutter completely isolates the arrows from the text */
    #content { 
        position: relative; 
        z-index: 2; 
        padding: 10px 14px 60px 165px; 
        white-space: pre; 
        line-height: 1.5; 
        overflow-x: auto; 
    }
    /* Gutter anchor line */
    #content::before {
        content: '';
        position: absolute;
        top: 0; bottom: 0; left: 155px;
        width: 1px;
        background: var(--vscode-panel-border);
        opacity: 0.3;
        z-index: -1;
    }

    #content.wrap { white-space: pre-wrap; word-break: break-word; }
    #content.compact { line-height: 1.25; }
    #content.relaxed { line-height: 1.85; }

    .bc-line { 
        white-space: inherit; 
        padding: 0 4px; 
        border-radius: 3px; 
        margin-left: calc(var(--depth, 0) * var(--indent-size)); 
        transition: margin-left 0.25s ease;
    }
    .bc-line:hover { background: var(--vscode-list-hoverBackground); }
    .bc-line.bc-hit { background: var(--vscode-editor-findMatchHighlightBackground, rgba(255,255,0,0.15)); }
    .bc-line.bc-flash { background: var(--vscode-focusBorder) !important; opacity: 0.4; transition: opacity 0.6s ease; }
    
    /* Strict overrides for hidden elements */
    #content.hide-source .bc-source-line { display: none !important; }
    #content.hide-indent .bc-line { margin-left: 0 !important; }

    .bc-index { color: var(--vscode-editorLineNumber-foreground, #858585); opacity: 0.7; }
    .bc-comment { color: #6a9955; opacity: 0.85; }
    .bc-function-header {
        color: #dcdcaa; font-weight: 600; display: block; margin-top: 10px; padding-top: 6px;
        border-top: 1px dashed var(--vscode-panel-border); margin-left: 0 !important;
    }
    .bc-opcode { color: #569cd6; font-weight: 600; }
    .bc-register { color: #9cdcfe; }
    .bc-number { color: #b5cea8; }
    .bc-jump-target { cursor: pointer; text-decoration: underline dotted; text-underline-offset: 2px; }
    .bc-jump-target:hover { filter: brightness(1.3); }

    #error, #diagnostics { padding: 14px; }
    #error {
        color: var(--vscode-errorForeground); white-space: pre-wrap;
        border-left: 3px solid var(--vscode-errorForeground);
        background: var(--vscode-inputValidation-errorBackground, transparent);
        border-radius: 4px; margin: 10px; padding: 12px;
    }
    .diag-card {
        border-left: 3px solid var(--vscode-errorForeground);
        background: var(--vscode-inputValidation-errorBackground, transparent);
        border-radius: 4px; padding: 8px 10px; margin-bottom: 8px;
    }
    .diag-kind { font-weight: 600; font-size: 11px; opacity: 0.85; }
    .diag-loc { font-size: 10.5px; opacity: 0.6; margin-left: 6px; }
    .diag-msg { margin-top: 3px; font-size: 12px; }

    #empty { padding: 60px 20px; opacity: 0.5; text-align: center; font-size: 12px; }
</style>
</head>
<body>
    <div id="header">
        <div id="toolbar">
            <input id="searchBox" type="text" placeholder="Filter instructions (e.g. LOADK, R0, MOVE)" />
            <button class="icon-btn" id="settingsBtn">⚙ Options</button>
            <button class="icon-btn" id="stringsBtn">🔤 Strings</button>
            <button class="icon-btn" id="debugBtn">🐞 Debug</button>
            <button class="icon-btn" id="copyBtn">Copy</button>
            <button class="icon-btn" id="refreshBtn">↻ Refresh</button>
        </div>
        <div id="infoRow">
            <span id="fileName"></span>
            <span id="stats"></span>
        </div>

        <div class="popover" id="settingsPopover">
            <div class="setting-title">Compiler</div>
            <div class="setting-row">
                <span>Optimization</span>
                <select id="optSelect">
                    <option value="0">-O0 (none)</option>
                    <option value="1">-O1 (default)</option>
                    <option value="2">-O2 (aggressive)</option>
                </select>
            </div>
            <div class="setting-row">
                <span>Debug info</span>
                <select id="dbgSelect">
                    <option value="0">-g0 (stripped)</option>
                    <option value="1">-g1 (default)</option>
                    <option value="2">-g2 (full)</option>
                </select>
            </div>
            <div class="setting-row"><label><input type="checkbox" id="constCheck" /> Show constant tables</label></div>
            <div class="setting-row"><label><input type="checkbox" id="expandCheck" /> Expand one-liner source</label></div>
            <div class="setting-hint">Breaks minified scripts into multiple lines before compiling, for readable per-instruction source context.</div>
            <div class="setting-row"><label><input type="checkbox" id="selectionCheck" /> Compile selection only</label></div>

            <div class="setting-title">Display</div>
            <div class="setting-row"><label><input type="checkbox" id="sourceCheck" checked /> Show original source lines</label></div>
            <div class="setting-row"><label><input type="checkbox" id="indentCheck" checked /> Indent by control-flow depth</label></div>
            <div class="setting-row">
                <span>Indent Size</span>
                <select id="indentSizeSelect">
                    <option value="10">10px</option>
                    <option value="15" selected>15px</option>
                    <option value="25">25px</option>
                </select>
            </div>
            <div class="setting-row"><label><input type="checkbox" id="arrowsCheck" checked /> Show jump arrows</label></div>
            <div class="setting-row">
                <span>Arrow Style</span>
                <select id="arrowStyleSelect">
                    <option value="curved" selected>Curved & Directional</option>
                    <option value="straight">Straight Monotone</option>
                </select>
            </div>
            <div class="setting-row"><label><input type="checkbox" id="wrapCheck" /> Wrap long lines</label></div>
            <div class="setting-row">
                <span>Font size</span>
                <select id="fontSelect">
                    <option value="11">11px</option><option value="12">12px</option>
                    <option value="13" selected>13px</option><option value="14">14px</option><option value="16">16px</option>
                </select>
            </div>
            <div class="setting-row">
                <span>Line spacing</span>
                <select id="densitySelect">
                    <option value="compact">Compact</option><option value="normal" selected>Normal</option><option value="relaxed">Relaxed</option>
                </select>
            </div>
        </div>

        <div class="popover" id="stringsPopover">
            <div class="setting-title">Constants / String Decoder</div>
            <div id="stringsPanel"><div id="stringsEmpty">No string constants found yet.</div></div>
        </div>

        <div class="popover" id="debugPopover">
            <div class="setting-title">Compile Debug Info</div>
            <div id="debugPanel"><div style="opacity:0.6; font-size:11px;">Compile something to see debug info.</div></div>
        </div>
    </div>

    <div id="hintBanner"></div>
    <div id="largeBanner"></div>

    <div id="contentWrapper">
        <svg id="arrowLayer" width="0" height="0">
            <defs>
                <!-- Forward Jump Markers -->
                <marker id="arrow-fwd" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
                    <path d="M 0 1 L 9 5 L 0 9 z" fill="var(--vscode-charts-green, #89d185)" opacity="0.95"/>
                </marker>
                <marker id="dot-fwd" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="4" markerHeight="4">
                    <circle cx="5" cy="5" r="3" fill="var(--vscode-charts-green, #89d185)" opacity="0.95"/>
                </marker>
                
                <!-- Backward Jump (Loop) Markers -->
                <marker id="arrow-back" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
                    <path d="M 0 1 L 9 5 L 0 9 z" fill="var(--vscode-charts-red, #f14c4c)" opacity="0.95"/>
                </marker>
                <marker id="dot-back" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="4" markerHeight="4">
                    <circle cx="5" cy="5" r="3" fill="var(--vscode-charts-red, #f14c4c)" opacity="0.95"/>
                </marker>
            </defs>
        </svg>
        <div id="content"><div id="empty">Open a .lua or .luau file to see its bytecode here.</div></div>
    </div>

<script>
    const vscode = acquireVsCodeApi();
    const content = document.getElementById("content");
    const contentWrapper = document.getElementById("contentWrapper");
    const arrowLayer = document.getElementById("arrowLayer");
    const fileNameEl = document.getElementById("fileName");
    const statsEl = document.getElementById("stats");
    const searchBox = document.getElementById("searchBox");
    const hintBanner = document.getElementById("hintBanner");
    const largeBanner = document.getElementById("largeBanner");

    const settingsBtn = document.getElementById("settingsBtn");
    const settingsPopover = document.getElementById("settingsPopover");
    const stringsBtn = document.getElementById("stringsBtn");
    const stringsPopover = document.getElementById("stringsPopover");
    const stringsPanel = document.getElementById("stringsPanel");
    const debugBtn = document.getElementById("debugBtn");
    const debugPopover = document.getElementById("debugPopover");
    const debugPanel = document.getElementById("debugPanel");

    const optSelect = document.getElementById("optSelect");
    const dbgSelect = document.getElementById("dbgSelect");
    const constCheck = document.getElementById("constCheck");
    const expandCheck = document.getElementById("expandCheck");
    const selectionCheck = document.getElementById("selectionCheck");
    const sourceCheck = document.getElementById("sourceCheck");
    const indentCheck = document.getElementById("indentCheck");
    const indentSizeSelect = document.getElementById("indentSizeSelect");
    const arrowsCheck = document.getElementById("arrowsCheck");
    const arrowStyleSelect = document.getElementById("arrowStyleSelect");
    const wrapCheck = document.getElementById("wrapCheck");
    const fontSelect = document.getElementById("fontSelect");
    const densitySelect = document.getElementById("densitySelect");

    let currentEdges = [];

    document.getElementById("refreshBtn").addEventListener("click", () => vscode.postMessage({ type: "refresh" }));
    document.getElementById("copyBtn").addEventListener("click", () => vscode.postMessage({ type: "copy" }));

    function togglePopover(popover, btn) {
        const isOpening = !popover.classList.contains("open");
        [settingsPopover, stringsPopover, debugPopover].forEach((p) => p.classList.remove("open"));
        [settingsBtn, stringsBtn, debugBtn].forEach((b) => b.classList.remove("active"));
        if (isOpening) { popover.classList.add("open"); btn.classList.add("active"); }
    }
    settingsBtn.addEventListener("click", (e) => { e.stopPropagation(); togglePopover(settingsPopover, settingsBtn); });
    stringsBtn.addEventListener("click", (e) => { e.stopPropagation(); togglePopover(stringsPopover, stringsBtn); });
    debugBtn.addEventListener("click", (e) => { e.stopPropagation(); togglePopover(debugPopover, debugBtn); });
    document.addEventListener("click", (e) => {
        [[settingsPopover, settingsBtn], [stringsPopover, stringsBtn], [debugPopover, debugBtn]].forEach(([p, b]) => {
            if (!p.contains(e.target) && e.target !== b) { p.classList.remove("open"); b.classList.remove("active"); }
        });
    });

    function sendOptions() {
        vscode.postMessage({
            type: "setOptions",
            optimizationLevel: Number(optSelect.value),
            debugLevel: Number(dbgSelect.value),
            dumpConstants: constCheck.checked,
            expandOneLiners: expandCheck.checked
        });
    }
    optSelect.addEventListener("change", sendOptions);
    dbgSelect.addEventListener("change", sendOptions);
    constCheck.addEventListener("change", sendOptions);
    expandCheck.addEventListener("change", sendOptions);

    selectionCheck.addEventListener("change", () => {
        vscode.postMessage({ type: "toggleSelectionMode", enabled: selectionCheck.checked });
    });

    // DISPLAY TOGGLES
    sourceCheck.addEventListener("change", () => { 
        content.classList.toggle("hide-source", !sourceCheck.checked); 
        redrawArrows(); 
    });
    
    indentCheck.addEventListener("change", () => { 
        content.classList.toggle("hide-indent", !indentCheck.checked); 
        setTimeout(redrawArrows, 260); 
    });
    
    indentSizeSelect.addEventListener("change", () => { 
        document.documentElement.style.setProperty("--indent-size", indentSizeSelect.value + "px"); 
        setTimeout(redrawArrows, 260); 
    });
    
    arrowsCheck.addEventListener("change", () => { 
        arrowLayer.style.display = arrowsCheck.checked ? "" : "none"; 
        redrawArrows(); 
    });
    
    arrowStyleSelect.addEventListener("change", () => redrawArrows());
    
    wrapCheck.addEventListener("change", () => { 
        content.classList.toggle("wrap", wrapCheck.checked); 
        redrawArrows(); 
    });
    
    fontSelect.addEventListener("change", () => { 
        content.style.fontSize = fontSelect.value + "px"; 
        redrawArrows(); 
    });
    
    densitySelect.addEventListener("change", () => {
        content.classList.remove("compact", "normal", "relaxed");
        content.classList.add(densitySelect.value);
        redrawArrows();
    });

    let searchDebounce;
    searchBox.addEventListener("input", () => {
        clearTimeout(searchDebounce);
        searchDebounce = setTimeout(() => { applyFilter(searchBox.value.trim().toLowerCase()); redrawArrows(); }, 150);
    });

    function applyFilter(query) {
        content.querySelectorAll(".bc-line").forEach((el) => {
            const text = el.textContent.toLowerCase();
            const match = !query || text.includes(query);
            el.style.display = match ? "" : "none";
            el.classList.toggle("bc-hit", Boolean(query) && match);
        });
    }

    function escapeHtml(text) {
        return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    }

    function syncOptions(options) {
        if (!options) return;
        optSelect.value = String(options.optimizationLevel);
        dbgSelect.value = String(options.debugLevel);
        constCheck.checked = Boolean(options.dumpConstants);
        expandCheck.checked = Boolean(options.expandOneLiners);
    }

    function renderDebug(debug) {
        if (!debug) return;
        const rows = [];
        rows.push('<div class="debug-row"><div class="debug-label">Command</div><pre>' + escapeHtml(debug.commandLine || "n/a") + '</pre></div>');
        if (debug.stats) {
            rows.push(
                '<div class="debug-row"><div class="debug-label">Timing</div><div class="debug-grid">' +
                '<span class="k">read</span><span>' + debug.stats.readTime.toFixed(4) + 's</span>' +
                '<span class="k">parse</span><span>' + debug.stats.parseTime.toFixed(4) + 's</span>' +
                '<span class="k">compile</span><span>' + debug.stats.compileTime.toFixed(4) + 's</span>' +
                '<span class="k">total (roundtrip)</span><span>' + debug.elapsedMs + 'ms</span>' +
                '</div></div>'
            );
        }
        if (debug.rawStderr) {
            rows.push('<div class="debug-row"><div class="debug-label">stderr</div><pre>' + escapeHtml(debug.rawStderr) + '</pre></div>');
        }
        debugPanel.innerHTML = rows.join("");

        if (debug.hint) {
            hintBanner.textContent = "💡 " + debug.hint;
            hintBanner.classList.add("show");
        } else {
            hintBanner.classList.remove("show");
        }
    }

    // ---- string decoder ----
    function hexToText(s) {
        const clean = s.replace(/\\\\s+/g, "").replace(/^0x/i, "");
        if (!/^[0-9a-fA-F]+$/.test(clean) || clean.length < 2) return null;
        let out = "";
        for (let i = 0; i + 1 < clean.length; i += 2) out += String.fromCharCode(parseInt(clean.substr(i, 2), 16));
        return out;
    }
    function base64ToText(s) {
        try { return atob(s.trim()); } catch { return null; }
    }
    function xorBruteForce(s) {
        const bytes = Array.from(s).map((c) => c.charCodeAt(0));
        const results = [];
        for (let key = 1; key < 256; key++) {
            const decoded = bytes.map((b) => String.fromCharCode(b ^ key)).join("");
            const printable = decoded.split("").filter((c) => { const code = c.charCodeAt(0); return code >= 32 && code < 127; }).length;
            const ratio = bytes.length ? printable / bytes.length : 0;
            if (ratio > 0.85) results.push({ key, decoded, ratio });
        }
        results.sort((a, b) => b.ratio - a.ratio);
        return results.slice(0, 5);
    }

    let stringExtractQueue = [];
    let stringExtractTimer = null;
    let extractedStrings = new Set();

    function decodeLuauStringLiteralFrontend(literal) {
        const inner = literal.slice(1, -1);
        try {
            return inner.replace(/\\\\(x[0-9a-fA-F]{2}|\\\\d{1,3}|.)/g, (match, esc) => {
                if (esc[0] === "x") return String.fromCharCode(parseInt(esc.slice(1), 16));
                if (/^\\\\d+$/.test(esc)) return String.fromCharCode(parseInt(esc, 10));
                const map = { n: "\\n", t: "\\t", r: "\\r", '"': '"', "'": "'", "\\\\": "\\\\" };
                return map[esc] || esc;
            });
        } catch {
            return null;
        }
    }

    function startChunkedStringExtraction(rawText) {
        if (stringExtractTimer) cancelAnimationFrame(stringExtractTimer);
        extractedStrings.clear();
        
        stringsPanel.innerHTML = '<div id="stringsEmpty"><span class="spinner"></span> Extracting strings in background...</div>';
        const lines = rawText.split(/\\r?\\n/);
        stringExtractQueue = [];
        
        const chunkSize = 1000;
        for (let i = 0; i < lines.length; i += chunkSize) {
            stringExtractQueue.push(lines.slice(i, i + chunkSize).join("\\n"));
        }
        
        processStringChunk();
    }

    function processStringChunk() {
        if (stringExtractQueue.length === 0 || extractedStrings.size >= 1000) {
            renderStrings(Array.from(extractedStrings));
            return;
        }

        const chunk = stringExtractQueue.shift();
        const strRegex = /"(?:[^"\\\\]|\\\\.)*"/g;
        let m;
        
        while ((m = strRegex.exec(chunk)) !== null && extractedStrings.size < 1000) {
            const clean = decodeLuauStringLiteralFrontend(m[0]);
            if (clean) extractedStrings.add(clean);
        }

        const emptyEl = document.getElementById("stringsEmpty");
        if (emptyEl) emptyEl.innerHTML = '<span class="spinner"></span> Extracting strings... (' + extractedStrings.size + ' found so far)';

        stringExtractTimer = requestAnimationFrame(processStringChunk);
    }

    function renderStrings(strings) {
        if (!strings || strings.length === 0) {
            stringsPanel.innerHTML = '<div id="stringsEmpty">No string constants found.</div>';
            return;
        }
        stringsPanel.innerHTML = strings.map((s, i) => {
            const safe = escapeHtml(s);
            return '<div class="string-row">' +
                '<div class="string-original">' + safe + '</div>' +
                '<div class="string-actions">' +
                '<button data-action="hex" data-idx="' + i + '">Hex → Text</button>' +
                '<button data-action="b64" data-idx="' + i + '">Base64 → Text</button>' +
                '<button data-action="xor" data-idx="' + i + '">XOR brute-force</button>' +
                '</div>' +
                '<div class="decode-result" id="decode-' + i + '"></div>' +
                '</div>';
        }).join("");

        stringsPanel.querySelectorAll("button").forEach((btn) => {
            btn.addEventListener("click", () => {
                const idx = Number(btn.dataset.idx);
                const action = btn.dataset.action;
                const original = strings[idx];
                const resultEl = document.getElementById("decode-" + idx);
                let text;

                if (action === "hex") text = hexToText(original);
                else if (action === "b64") text = base64ToText(original);
                else if (action === "xor") {
                    const candidates = xorBruteForce(original);
                    text = candidates.length
                        ? candidates.map((c) => "key=" + c.key + " (" + Math.round(c.ratio * 100) + "% printable): " + c.decoded).join("\\n")
                        : null;
                }

                resultEl.textContent = text !== null && text !== undefined && text !== ""
                    ? text
                    : "(no valid decode found)";
                resultEl.classList.add("show");
            });
        });
    }

    // ---- jump navigation + collision-free routing arrows ----
    function navigateToIdx(idx) {
        const target = content.querySelector('[data-idx="' + idx + '"]');
        if (!target) return;
        target.scrollIntoView({ behavior: "smooth", block: "center" });
        target.classList.add("bc-flash");
        setTimeout(() => target.classList.remove("bc-flash"), 700);
    }

    content.addEventListener("click", (e) => {
        const jt = e.target.closest(".bc-jump-target");
        if (jt && jt.dataset.targetIdx) navigateToIdx(jt.dataset.targetIdx);
    });

    const MAX_ARROWS_DRAWN = 250;
    const BASE_X = 155; // The exact pixel column the gutter line sits on

    function redrawArrows() {
        if (!arrowsCheck.checked || !currentEdges.length) {
            arrowLayer.innerHTML = arrowLayer.querySelector("defs").outerHTML;
            return;
        }

        const wrapperRect = contentWrapper.getBoundingClientRect();
        arrowLayer.setAttribute("width", String(contentWrapper.scrollWidth));
        arrowLayer.setAttribute("height", String(content.scrollHeight));
        arrowLayer.style.width = contentWrapper.scrollWidth + "px";
        arrowLayer.style.height = content.scrollHeight + "px";

        // Step 1: Gather coordinates for all visible edges
        const edgeData = [];
        for (const edge of currentEdges) {
            const fromEl = content.querySelector('[data-idx="' + edge.fromIdx + '"]');
            const toEl = content.querySelector('[data-idx="' + edge.toIdx + '"]');
            
            if (!fromEl || !toEl || fromEl.style.display === "none" || toEl.style.display === "none") continue;

            const fromRect = fromEl.getBoundingClientRect();
            const toRect = toEl.getBoundingClientRect();
            
            const y1 = fromRect.top - wrapperRect.top + fromRect.height / 2 + content.scrollTop;
            const y2 = toRect.top - wrapperRect.top + toRect.height / 2 + content.scrollTop;

            edgeData.push({ 
                edge, y1, y2, 
                top: Math.min(y1, y2), 
                bottom: Math.max(y1, y2), 
                dist: Math.abs(edge.toIdx - edge.fromIdx) 
            });
        }

        // Step 2: Lane Assignment Algorithm (Prevents overlapping lines)
        // Shorter jumps stay closer to the text, longer jumps arch further left
        edgeData.sort((a, b) => a.dist - b.dist);
        
        const lanes = [];
        for (const data of edgeData) {
            let laneIdx = 0;
            let placed = false;
            while (!placed) {
                if (!lanes[laneIdx]) {
                    lanes[laneIdx] = [data];
                    placed = true;
                } else {
                    // Check if this jump's vertical span overlaps with any existing line in this lane
                    const overlap = lanes[laneIdx].some(existing => {
                        const padding = 12; // Buffer to prevent tangents from bunching up
                        return Math.max(data.top, existing.top) < Math.min(data.bottom, existing.bottom) + padding;
                    });
                    
                    if (!overlap) {
                        lanes[laneIdx].push(data);
                        placed = true;
                    } else {
                        laneIdx++; // Move out one lane left
                    }
                }
            }
            data.lane = laneIdx;
        }

        // Step 3: Render the SVG Paths
        let svg = arrowLayer.querySelector("defs").outerHTML || "";
        let drawn = 0;
        const style = arrowStyleSelect.value;
        const isCurved = style === "curved";

        for (const data of edgeData) {
            if (drawn >= MAX_ARROWS_DRAWN) break;

            const isForward = data.y2 > data.y1;
            const color = isCurved ? (isForward ? "var(--vscode-charts-green, #89d185)" : "var(--vscode-charts-red, #f14c4c)") : "var(--vscode-focusBorder, #3794ff)";
            
            const markerStart = isCurved ? (isForward ? "url(#dot-fwd)" : "url(#dot-back)") : "";
            const markerEnd = isCurved ? (isForward ? "url(#arrow-fwd)" : "url(#arrow-back)") : "";
            
            // Calculate how far left this line swings based on its collision lane
            let curveX = BASE_X - 16 - (data.lane * 14);
            if (curveX < 5) curveX = 5; // Clamp so it doesn't vanish off the left edge

            let pathD = "";
            if (isCurved) {
                // Perfect Cubic Bezier: Start horizontally Left (-X), curve down, finish horizontally Right (+X)
                pathD = 'M ' + BASE_X + ',' + data.y1 + 
                        ' C ' + curveX + ',' + data.y1 + 
                        ' ' + curveX + ',' + data.y2 + 
                        ' ' + BASE_X + ',' + data.y2;
            } else {
                // Straight angular lines
                pathD = 'M ' + BASE_X + ',' + data.y1 + 
                        ' L ' + curveX + ',' + data.y1 + 
                        ' L ' + curveX + ',' + data.y2 + 
                        ' L ' + BASE_X + ',' + data.y2;
            }

            svg += '<path d="' + pathD + '" ' +
                'stroke="' + color + '" stroke-width="' + (isCurved ? '1.5' : '1.4') + '" ' +
                'fill="none" opacity="' + (isCurved ? '0.85' : '0.6') + '" ' +
                (markerStart ? 'marker-start="' + markerStart + '" ' : '') +
                (markerEnd ? 'marker-end="' + markerEnd + '" ' : '') + '/>';
                
            drawn++;
        }

        arrowLayer.innerHTML = svg;
    }

    content.addEventListener("scroll", () => { if (arrowsCheck.checked) redrawArrows(); });
    window.addEventListener("resize", () => { if (arrowsCheck.checked) redrawArrows(); });

    window.addEventListener("message", (event) => {
        const msg = event.data;

        if (msg.type === "loading") {
            fileNameEl.innerHTML = '<span class="spinner"></span>' + escapeHtml(msg.fileName) + (msg.usingSelection ? " (selection)" : "") + " — compiling...";
            largeBanner.classList.remove("show");
            hintBanner.classList.remove("show");
            return;
        }
        if (msg.type === "error") {
            syncOptions(msg.options);
            renderDebug(msg.debug);
            fileNameEl.textContent = msg.fileName + (msg.usingSelection ? " (selection)" : "");
            statsEl.textContent = "";
            largeBanner.classList.remove("show");
            currentEdges = [];
            arrowLayer.innerHTML = arrowLayer.querySelector("defs").outerHTML;
            content.innerHTML = '<div id="error">' + escapeHtml(msg.message) + '</div>';
            return;
        }
        if (msg.type === "diagnostics") {
            syncOptions(msg.options);
            renderDebug(msg.debug);
            fileNameEl.textContent = msg.fileName + (msg.usingSelection ? " (selection)" : "");
            statsEl.textContent = "";
            largeBanner.classList.remove("show");
            currentEdges = [];
            arrowLayer.innerHTML = arrowLayer.querySelector("defs").outerHTML;
            content.innerHTML = '<div id="diagnostics">' + msg.diagnostics.map((d) =>
                '<div class="diag-card"><span class="diag-kind">' + d.kind + '</span>' +
                '<span class="diag-loc">line ' + d.line + ', col ' + d.column + '</span>' +
                '<div class="diag-msg">' + escapeHtml(d.message) + '</div></div>'
            ).join("") + '</div>';
            return;
        }
        if (msg.type === "result") {
            syncOptions(msg.options);
            renderDebug(msg.debug);
            fileNameEl.textContent = msg.fileName + (msg.usingSelection ? " (selection)" : "") + (msg.elapsedMs !== undefined ? ' · ' + msg.elapsedMs + 'ms' : '');
            statsEl.innerHTML = msg.stats
                ? '<span class="pill">' + msg.stats.lines + ' lines</span> ' +
                  '<span class="pill">' + msg.stats.bytecodeBytes + ' bytes</span> ' +
                  '<span class="pill">' + msg.stats.instructionCount + ' instr</span>' +
                  (msg.usingSelection ? ' <span class="pill info">selection only</span>' : '')
                : (msg.usingSelection ? '<span class="pill info">selection only</span>' : '');

            if (msg.simplified) {
                largeBanner.textContent = "⚡ Large output (" + msg.totalLines + " lines) — using simplified highlighting; jump arrows are skipped for performance.";
                largeBanner.classList.add("show");
            } else {
                largeBanner.classList.remove("show");
            }

            content.innerHTML = msg.html;
            applyFilter(searchBox.value.trim().toLowerCase());

            currentEdges = msg.edges || [];
            
            if (msg.rawOutput) {
                startChunkedStringExtraction(msg.rawOutput);
            }

            // Small timeout before initially drawing arrows to ensure DOM has computed positions
            setTimeout(() => requestAnimationFrame(redrawArrows), 50);
        }
    });

    vscode.postMessage({ type: "ready" });
</script>
</body>
</html>`;
    }
}