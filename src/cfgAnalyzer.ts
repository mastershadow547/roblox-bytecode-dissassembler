export interface JumpEdge {
    fromIdx: number;
    toIdx: number;
}

export interface CfgAnalysis {
    edges: JumpEdge[];
    labelMap: Record<string, number>;
}

export function analyzeCfg(output: string): CfgAnalysis {
    const lines = output.split(/\r?\n/);
    const edges: { fromIdx: number; toLabel: string }[] = [];
    const labelMap: Record<string, number> = {};
    
    let instrIdx = 0;

    for (let i = 0; i < lines.length; i++) {
        const trimmed = lines[i].trim();

        if (!trimmed) continue;
        
        // Skip headers, constants, remarks, and source lines
        if (trimmed.startsWith("Function ")) continue;
        if (/^K\d+:/.test(trimmed)) continue;
        if (trimmed.startsWith("REMARK")) continue;
        if (/^\d+:\s/.test(trimmed)) continue;

        // At this point, we are guaranteed to be on a real bytecode instruction.
        
        // 1. Check if the instruction has a label prefix (e.g., "L2: LOADN R3 50")
        const labelMatch = /^L(\d+):\s*(.*)$/.exec(trimmed);
        let instrText = trimmed;
        
        if (labelMatch) {
            labelMap["L" + labelMatch[1]] = instrIdx;
            instrText = labelMatch[2];
        }

        // 2. Check if the instruction jumps to a label (e.g., "JUMP L4", "FORNPREP R2 L1")
        const jumpMatch = /\b(L\d+)\b$/.exec(instrText);
        if (jumpMatch && /JUMP|FOR|SETUP/.test(instrText)) {
            edges.push({ fromIdx: instrIdx, toLabel: jumpMatch[1] });
        }

        instrIdx++;
    }

    // Resolve labels to actual instruction indices
    const resolvedEdges: JumpEdge[] = [];
    for (const e of edges) {
        const toIdx = labelMap[e.toLabel];
        if (toIdx !== undefined) {
            resolvedEdges.push({ fromIdx: e.fromIdx, toIdx });
        }
    }

    return { edges: resolvedEdges, labelMap };
}