import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as cp from "child_process";
import * as vscode from "vscode";
import { expandOneLiner } from "./formatter";

export interface CompileStats {
    lines: number;
    bytecodeBytes: number;
    instructionCount: number;
    readTime: number;
    parseTime: number;
    compileTime: number;
}

export interface CompileDiagnostic {
    file: string;
    line: number;
    column: number;
    kind: string;
    message: string;
}

export interface CompileResult {
    ok: boolean;
    output: string;
    diagnostics: CompileDiagnostic[];
    stats?: CompileStats;
    rawError?: string;
    rawStderr?: string;
    commandLine?: string;
    compilerPath?: string;
    usedSourceCode: string;
    hint?: string;
    elapsedMs: number;
}

export interface CompileOptions {
    optimizationLevel: number;
    debugLevel: number;
    dumpConstants: boolean;
    expandOneLiners: boolean;
}

const WINDOWS_EXE = "luau-compile.exe";
const UNIX_EXE = "luau-compile";

let cachedCompilerPath: string | undefined;

function candidateDirs(): string[] {
    const configured = vscode.workspace
        .getConfiguration("luauBytecode")
        .get<string[]>("searchDirectories", []);

    return [...configured, "C:/Luau", "H:/Luau"];
}

export function findCompilerPath(): string | undefined {
    const config = vscode.workspace.getConfiguration("luauBytecode");
    const configuredPath = config.get<string>("compilerPath")?.trim();

    if (configuredPath && fs.existsSync(configuredPath)) {
        return configuredPath;
    }

    if (cachedCompilerPath && fs.existsSync(cachedCompilerPath)) {
        return cachedCompilerPath;
    }

    const exeName = process.platform === "win32" ? WINDOWS_EXE : UNIX_EXE;

    for (const dir of candidateDirs()) {
        const full = path.join(dir, exeName);
        if (fs.existsSync(full)) {
            cachedCompilerPath = full;
            return full;
        }
    }

    return undefined;
}

function parseDiagnostics(stderr: string, realFileName: string): CompileDiagnostic[] {
    const diagnostics: CompileDiagnostic[] = [];
    const pattern = /^(.+)\((\d+),(\d+)\):\s*(\w+):\s*(.+)$/;

    for (const rawLine of stderr.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line) continue;

        const match = pattern.exec(line);
        if (match) {
            diagnostics.push({
                file: realFileName,
                line: parseInt(match[2], 10),
                column: parseInt(match[3], 10),
                kind: match[4],
                message: match[5]
            });
        }
    }

    return diagnostics;
}

function readStatsFile(statsPath: string): CompileStats | undefined {
    try {
        const json = JSON.parse(fs.readFileSync(statsPath, "utf8"));
        return {
            lines: json.lines ?? 0,
            bytecodeBytes: json.bytecode ?? 0,
            instructionCount: json.bytecodeInstructionCount ?? 0,
            readTime: json.readTime ?? 0,
            parseTime: json.parseTime ?? 0,
            compileTime: json.compileTime ?? 0
        };
    } catch {
        return undefined;
    }
}

/**
 * Identifies Luau's hard architectural C++ limits and guides the user towards structural workarounds.
 */
function buildHint(text: string | undefined): string | undefined {
    if (!text) return undefined;
    if (/exceeded limit|too many locals|too many upvalues|register overflow|out of .*registers/i.test(text)) {
        return (
            "Luau VM Hard Limit Reached: Registers and upvalues are capped at 200 due to 8-bit bytecode format limitations. " +
            "You cannot bypass this in the compiler flags. To bypass this in your code, wrap your loose local variables and functions " +
            "into a centralized state table (e.g., `local GlobalState = { a = 1, b = 2 }`) to dramatically reduce register pressure. " +
            "Alternatively, use the 'Compile Selection Only' feature in options to compile a specific scope."
        );
    }
    return undefined;
}

export function compileToText(
    sourceCode: string,
    realFileName: string,
    options: CompileOptions
): Promise<CompileResult> {
    return new Promise((resolve) => {
        const start = Date.now();
        const exePath = findCompilerPath();
        const usedSourceCode = options.expandOneLiners ? expandOneLiner(sourceCode) : sourceCode;

        if (!exePath) {
            resolve({
                ok: false,
                output: "",
                diagnostics: [],
                usedSourceCode,
                elapsedMs: 0,
                rawError:
                    "luau-compile executable was not found.\n\n" +
                    "Set 'luauBytecode.compilerPath' in Settings to point directly at it, " +
                    "or place it in C:/Luau or H:/Luau (add more folders via 'luauBytecode.searchDirectories')."
            });
            return;
        }

        const ext = path.extname(realFileName) || ".lua";
        let tmpDir: string;

        try {
            tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "luau-bc-"));
        } catch (err) {
            resolve({
                ok: false,
                output: "",
                diagnostics: [],
                usedSourceCode,
                elapsedMs: Date.now() - start,
                rawError: `Failed to create temp directory: ${String(err)}`,
                compilerPath: exePath
            });
            return;
        }

        const tmpFile = path.join(tmpDir, `input${ext}`);
        const statsFile = path.join(tmpDir, "stats.json");

        try {
            fs.writeFileSync(tmpFile, usedSourceCode, "utf8");
        } catch (err) {
            fs.rm(tmpDir, { recursive: true, force: true }, () => {});
            resolve({
                ok: false,
                output: "",
                diagnostics: [],
                usedSourceCode,
                elapsedMs: Date.now() - start,
                rawError: `Failed to write temp file: ${String(err)}`,
                compilerPath: exePath
            });
            return;
        }

        const args = [
            "--text",
            `-O${options.optimizationLevel}`,
            `-g${options.debugLevel}`,
            "--record-stats=total",
            `--stats-file=${statsFile}`
        ];

        if (options.dumpConstants) {
            args.push("--dump-constants");
        }

        args.push(tmpFile);

        const displayArgs = [...args.slice(0, -1), realFileName];
        const commandLine = `${exePath} ${displayArgs.join(" ")}`;

        cp.execFile(
            exePath,
            args,
            { maxBuffer: 1024 * 1024 * 32, cwd: tmpDir },
            (err, stdout, stderr) => {
                const elapsedMs = Date.now() - start;
                const diagnostics = parseDiagnostics(stderr ?? "", realFileName);
                const stats = readStatsFile(statsFile);
                const combinedMessage = [stderr, ...diagnostics.map((d) => d.message)].join(" ");
                const hint = buildHint(combinedMessage);

                fs.rm(tmpDir, { recursive: true, force: true }, () => {});

                if (err && !stdout) {
                    resolve({
                        ok: false,
                        output: "",
                        diagnostics,
                        usedSourceCode,
                        elapsedMs,
                        rawError: diagnostics.length ? undefined : (stderr?.trim() || err.message),
                        rawStderr: stderr?.trim() || undefined,
                        commandLine,
                        compilerPath: exePath,
                        hint
                    });
                    return;
                }

                resolve({
                    ok: true,
                    output: stdout,
                    diagnostics,
                    stats,
                    usedSourceCode,
                    elapsedMs,
                    rawStderr: stderr?.trim() || undefined,
                    commandLine,
                    compilerPath: exePath,
                    hint
                });
            }
        );
    });
}