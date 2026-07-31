import * as vscode from "vscode";
import { compileToText, CompileOptions } from "./luauCompiler";
import { BytecodePanel } from "./bytecodePanel";

const SUPPORTED_EXTENSIONS = [".lua", ".luau"];
let debounceTimer: NodeJS.Timeout | undefined;
let currentDocument: vscode.TextDocument | undefined;
let sessionOptions: Partial<CompileOptions> = {};
let compileSelectionOnly = false;
let autoHealAttempts = 0;
const MAX_AUTO_HEAL_ATTEMPTS = 3;
let outputChannel: vscode.OutputChannel;

function isSupported(document: vscode.TextDocument): boolean {
    const fileName = document.fileName.toLowerCase();
    return SUPPORTED_EXTENSIONS.some((ext) => fileName.endsWith(ext));
}

function baseName(document: vscode.TextDocument): string {
    return document.fileName.split(/[\\/]/).pop() || document.fileName;
}

function getCompileOptions(): CompileOptions {
    const config = vscode.workspace.getConfiguration("luauBytecode");
    return {
        optimizationLevel: sessionOptions.optimizationLevel ?? config.get<number>("optimizationLevel", 1),
        debugLevel: sessionOptions.debugLevel ?? config.get<number>("debugLevel", 1),
        dumpConstants: sessionOptions.dumpConstants ?? config.get<boolean>("dumpConstants", false),
        expandOneLiners: sessionOptions.expandOneLiners ?? config.get<boolean>("expandOneLiners", false)
    };
}

function getSourceForCompile(document: vscode.TextDocument): { text: string; usingSelection: boolean } {
    if (compileSelectionOnly) {
        const editor = vscode.window.activeTextEditor;
        if (editor && editor.document === document && !editor.selection.isEmpty) {
            return { text: editor.document.getText(editor.selection), usingSelection: true };
        }
    }
    return { text: document.getText(), usingSelection: false };
}

function wirePanelMessages(panel: BytecodePanel) {
    panel.onMessage((msg) => {
        if (msg.type === "ready") {
            autoHealAttempts = 0;
        }

        if (msg.type === "refresh" && currentDocument) {
            void runCompile(currentDocument, false);
        }

        if (msg.type === "copy") {
            const raw = panel.getLastRawOutput();
            if (raw) {
                void vscode.env.clipboard.writeText(raw);
                void vscode.window.showInformationMessage("Bytecode copied to clipboard.");
            }
        }

        if (msg.type === "setOptions") {
            sessionOptions = {
                optimizationLevel: msg.optimizationLevel,
                debugLevel: msg.debugLevel,
                dumpConstants: msg.dumpConstants,
                expandOneLiners: msg.expandOneLiners
            };
            if (currentDocument) void runCompile(currentDocument, false);
        }

        if (msg.type === "toggleSelectionMode") {
            compileSelectionOnly = Boolean(msg.enabled);
            if (compileSelectionOnly) {
                const editor = vscode.window.activeTextEditor;
                if (!editor || editor.selection.isEmpty) {
                    vscode.window.showInformationMessage("Select a function's code in the editor to compile just that selection.");
                }
            }
            if (currentDocument) void runCompile(currentDocument, false);
        }
    });
}

function handleStuckPanel() {
    autoHealAttempts++;
    outputChannel?.appendLine(
        `[watchdog] Webview did not signal ready in time — auto-recreating (attempt ${autoHealAttempts}/${MAX_AUTO_HEAL_ATTEMPTS}).`
    );

    if (autoHealAttempts > MAX_AUTO_HEAL_ATTEMPTS) {
        void vscode.window
            .showWarningMessage(
                "Luau Bytecode panel failed to load after several automatic retries. This looks like a VS Code webview issue rather than something the extension can fix directly.",
                "Reload Panel Manually"
            )
            .then((choice) => {
                if (choice === "Reload Panel Manually") {
                    void vscode.commands.executeCommand("roblox-bytecode-dissassembler.reload");
                }
            });
        return;
    }

    const panel = BytecodePanel.forceRecreate(handleStuckPanel);
    wirePanelMessages(panel);
    if (currentDocument) void runCompile(currentDocument, false);
}

function ensurePanel(): BytecodePanel {
    const isNew = !BytecodePanel.isOpen();
    const panel = BytecodePanel.getOrCreate(handleStuckPanel);
    if (isNew) wirePanelMessages(panel);
    return panel;
}

async function runCompile(document: vscode.TextDocument, forceOpen: boolean) {
    if (!isSupported(document)) return;

    const config = vscode.workspace.getConfiguration("luauBytecode");
    const autoShow = config.get<boolean>("autoShow", true);

    if (!BytecodePanel.isOpen() && !autoShow && !forceOpen) {
        return;
    }

    currentDocument = document;

    const panel = ensurePanel();
    if (forceOpen) panel.reveal();

    const fileName = baseName(document);
    const { text: sourceCode, usingSelection } = getSourceForCompile(document);
    panel.showLoading(fileName, usingSelection);

    const options = getCompileOptions();
    const result = await compileToText(sourceCode, document.fileName, options);

    outputChannel.appendLine(
        `[${new Date().toISOString()}] ${fileName}${usingSelection ? " (selection)" : ""} — ${result.ok ? "OK" : "FAILED"} (${result.elapsedMs}ms)`
    );
    if (result.commandLine) outputChannel.appendLine(`  cmd: ${result.commandLine}`);
    if (result.rawStderr) outputChannel.appendLine(`  stderr: ${result.rawStderr}`);
    if (result.rawError) outputChannel.appendLine(`  error: ${result.rawError}`);
    if (result.hint) outputChannel.appendLine(`  hint: ${result.hint}`);

    panel.showResult(fileName, result, options, usingSelection);
}

export function activate(context: vscode.ExtensionContext) {
    outputChannel = vscode.window.createOutputChannel("Luau Bytecode");
    context.subscriptions.push(outputChannel);

    context.subscriptions.push(
        vscode.window.registerWebviewPanelSerializer("luauBytecodeView", {
            async deserializeWebviewPanel(panel: vscode.WebviewPanel) {
                const revived = BytecodePanel.revive(panel, handleStuckPanel);
                wirePanelMessages(revived);

                const editor = vscode.window.activeTextEditor;
                const doc = currentDocument ?? (editor && isSupported(editor.document) ? editor.document : undefined);

                if (doc) {
                    void runCompile(doc, false);
                } else {
                    revived.showLoading("Open a .lua or .luau file");
                }
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand("roblox-bytecode-dissassembler.show", () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor || !isSupported(editor.document)) {
                vscode.window.showErrorMessage("Open a .lua or .luau file first.");
                return;
            }
            void runCompile(editor.document, true);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand("roblox-bytecode-dissassembler.reload", () => {
            autoHealAttempts = 0;
            const panel = BytecodePanel.forceRecreate(handleStuckPanel);
            wirePanelMessages(panel);
            panel.reveal();

            if (currentDocument) {
                void runCompile(currentDocument, false);
            } else {
                const editor = vscode.window.activeTextEditor;
                if (editor && isSupported(editor.document)) void runCompile(editor.document, false);
            }
        })
    );

    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor((editor) => {
            if (editor && isSupported(editor.document)) void runCompile(editor.document, false);
        })
    );

    context.subscriptions.push(
        vscode.workspace.onDidChangeTextDocument((event) => {
            if (!isSupported(event.document)) return;
            const activeEditor = vscode.window.activeTextEditor;
            if (!activeEditor || activeEditor.document !== event.document) return;

            const delay = vscode.workspace.getConfiguration("luauBytecode").get<number>("debounceMs", 350);
            if (debounceTimer) clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => void runCompile(event.document, false), delay);
        })
    );

    context.subscriptions.push(
        vscode.window.onDidChangeTextEditorSelection((event) => {
            if (!compileSelectionOnly) return;
            if (!isSupported(event.textEditor.document)) return;

            const delay = vscode.workspace.getConfiguration("luauBytecode").get<number>("debounceMs", 350);
            if (debounceTimer) clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => void runCompile(event.textEditor.document, false), delay);
        })
    );

    context.subscriptions.push(
        vscode.workspace.onDidSaveTextDocument((document) => {
            if (isSupported(document)) void runCompile(document, false);
        })
    );

    const initialEditor = vscode.window.activeTextEditor;
    if (initialEditor && isSupported(initialEditor.document) && !BytecodePanel.isOpen()) {
        void runCompile(initialEditor.document, false);
    }
}

export function deactivate() {
    if (debounceTimer) clearTimeout(debounceTimer);
}