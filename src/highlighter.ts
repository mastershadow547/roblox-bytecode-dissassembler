import { analyzeCfg, JumpEdge } from "./cfgAnalyzer";

function escapeHtml(text: string): string {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Lua lexer for original source lines
const LUA_TOKEN_PATTERN = /(?<string>"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|(?<comment>--.*)|(?<keyword>\b(?:and|break|do|else|elseif|end|false|for|function|if|in|local|nil|not|or|repeat|return|then|true|until|while)\b)|(?<number>\b\d+(?:\.\d+)?\b)/g;

function highlightLuaSource(code: string): string {
    let pieces: string[] = [];
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    LUA_TOKEN_PATTERN.lastIndex = 0;
    while ((match = LUA_TOKEN_PATTERN.exec(code)) !== null) {
        pieces.push(escapeHtml(code.slice(lastIndex, match.index)));
        
        const g = match.groups!;
        if (g.string) pieces.push(`<span class="bc-string">${escapeHtml(g.string)}</span>`);
        else if (g.comment) pieces.push(`<span class="bc-comment">${escapeHtml(g.comment)}</span>`);
        else if (g.keyword) pieces.push(`<span style="color:#c586c0; font-weight:bold;">${escapeHtml(g.keyword)}</span>`);
        else if (g.number) pieces.push(`<span class="bc-number">${escapeHtml(g.number)}</span>`);
        
        lastIndex = match.index + match[0].length;
    }
    pieces.push(escapeHtml(code.slice(lastIndex)));
    return pieces.join("");
}

// Luau Bytecode lexer for instructions
const INSTR_TOKEN_PATTERN = /(?<label>^L\d+:)|(?<string>"(?:[^"\\]|\\.)*")|(?<opcode>\b[A-Z][A-Z0-9_]{2,}\b)|(?<register>\b[RKULG]\d+\b)|(?<number>-?\d+(?:\.\d+)?\b)/g;

function highlightInstruction(code: string, targetIdx?: number): string {
    let pieces: string[] = [];
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    const leadWs = code.match(/^\s*/)?.[0] || "";
    const workCode = code.slice(leadWs.length);
    
    INSTR_TOKEN_PATTERN.lastIndex = 0;
    let lastTokenPieceIdx = -1;

    while ((match = INSTR_TOKEN_PATTERN.exec(workCode)) !== null) {
        pieces.push(escapeHtml(workCode.slice(lastIndex, match.index)));

        const g = match.groups!;
        if (g.label) pieces.push(`<span style="color:#dcdcaa; font-weight:bold;">${escapeHtml(g.label)}</span>`);
        else if (g.string) pieces.push(`<span class="bc-string">${escapeHtml(g.string)}</span>`);
        else if (g.opcode) pieces.push(`<span class="bc-opcode">${escapeHtml(g.opcode)}</span>`);
        else if (g.register) pieces.push(`<span class="bc-register">${escapeHtml(g.register)}</span>`);
        else if (g.number) pieces.push(`<span class="bc-number">${escapeHtml(g.number)}</span>`);

        lastTokenPieceIdx = pieces.length - 1;
        lastIndex = match.index + match[0].length;
    }
    pieces.push(escapeHtml(workCode.slice(lastIndex)));
    
    if (targetIdx !== undefined && lastTokenPieceIdx >= 0) {
        pieces[lastTokenPieceIdx] = `<span class="bc-jump-target" data-target-idx="${targetIdx}" title="Jump to instruction index ${targetIdx}">${pieces[lastTokenPieceIdx]}</span>`;
    }

    return leadWs + pieces.join("");
}

export interface HighlightResult {
    html: string;
    totalLines: number;
    simplified: boolean;
    rawOutput: string;
    edges: JumpEdge[];
}

export function highlightBytecode(
    output: string,
    usedSourceCode: string | undefined,
    maxFullHighlightLines: number = 4000
): HighlightResult {
    const lines = output.split(/\r?\n/);
    const totalLines = lines.length;
    const simplified = totalLines > maxFullHighlightLines;

    let edges: JumpEdge[] = [];
    let depths: number[] = [];
    let cfg: ReturnType<typeof analyzeCfg> | undefined;
    
    if (!simplified) {
        cfg = analyzeCfg(output);
        edges = cfg.edges;
        
        const maxIdx = Math.max(0, ...edges.flatMap(e => [e.fromIdx, e.toIdx]));
        const delta = new Array(maxIdx + 2).fill(0);
        
        for (const e of edges) {
            const lo = Math.min(e.fromIdx, e.toIdx);
            const hi = Math.max(e.fromIdx, e.toIdx);
            delta[lo] += 1;
            delta[hi + 1] -= 1;
        }
        
        let running = 0;
        for (let i = 0; i <= maxIdx; i++) {
            running += delta[i];
            depths[i] = Math.max(0, running);
        }
    }

    let currentInstrIdx = 0;

    const html = lines.map((line) => {
        const trimmed = line.trim();
        if (!trimmed) return `<div class="bc-line">&nbsp;</div>`;

        // 1. Source Line (e.g. "   12: status = \"high\"")
        const srcMatch = line.match(/^(\s*\d+:\s)(.*)$/);
        if (srcMatch) {
            const prefix = escapeHtml(srcMatch[1]);
            const coloredSrc = simplified ? escapeHtml(srcMatch[2]) : highlightLuaSource(srcMatch[2]);
            return `<div class="bc-line bc-source-line"><span class="bc-index">${prefix}</span>${coloredSrc}</div>`;
        }

        // 2. Headers, Constants, Remarks
        if (trimmed.startsWith("Function ") || /^K\d+:/.test(trimmed) || trimmed.startsWith("REMARK")) {
            let headerCls = trimmed.startsWith("Function ") ? "bc-function-header" : "bc-comment";
            return `<div class="bc-line ${headerCls}">${escapeHtml(line)}</div>`;
        }

        // 3. True Bytecode Instruction
        const myIdx = currentInstrIdx++;
        
        if (simplified) {
            return `<div class="bc-line" data-idx="${myIdx}">${escapeHtml(line)}</div>`;
        }

        let depth = depths[myIdx] || 0;
        depth = Math.min(depth, 15); // Cap depth to prevent infinite scroll
        
        const indentStyle = depth > 0 ? ` style="--depth: ${depth}"` : "";
        
        // Find jump targets for clickable links
        const labelTargetMatch = /\b(L\d+)\b$/.exec(trimmed);
        let targetIdx: number | undefined;
        if (labelTargetMatch && cfg?.labelMap[labelTargetMatch[1]] !== undefined) {
            targetIdx = cfg.labelMap[labelTargetMatch[1]];
        }

        const innerHtml = highlightInstruction(line, targetIdx);
        return `<div class="bc-line" data-idx="${myIdx}"${indentStyle}>${innerHtml}</div>`;
    }).join("");

    return { html, totalLines, simplified, rawOutput: output, edges };
}