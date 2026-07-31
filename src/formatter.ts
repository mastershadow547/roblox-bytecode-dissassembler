/**
 * Best-effort expansion of minified/one-line Luau source into multiple lines,
 * purely so luau-compile's per-instruction "-- <line>" annotations become
 * distinct and readable instead of every instruction citing the same giant
 * one-line script. Does NOT change program semantics — only inserts newlines
 * at statement boundaries, carefully skipping over strings/comments/long
 * brackets so nothing inside them gets split. Not a real pretty-printer —
 * if you have stylua installed, format the actual file for better results.
 */
export function expandOneLiner(source: string): string {
    let out = "";
    let i = 0;
    const n = source.length;

    const breakAfter = () => {
        out = out.replace(/[ \t]+$/, "");
        out += "\n";
    };
    const breakBefore = () => {
        out = out.replace(/[ \t]+$/, "");
        if (!out.endsWith("\n")) out += "\n";
    };

    const BREAK_BEFORE = new Set(["end", "else", "elseif", "until"]);
    const BREAK_AFTER = new Set(["do", "then", "else", "repeat"]);

    while (i < n) {
        const ch = source[i];

        // -- comment or --[[ long comment ]]
        if (ch === "-" && source[i + 1] === "-") {
            if (source[i + 2] === "[") {
                const eqMatch = /^\[(=*)\[/.exec(source.slice(i + 2));
                if (eqMatch) {
                    const closer = `]${eqMatch[1]}]`;
                    const end = source.indexOf(closer, i + 2 + eqMatch[0].length);
                    const stop = end === -1 ? n : end + closer.length;
                    out += source.slice(i, stop);
                    i = stop;
                    continue;
                }
            }
            const end = source.indexOf("\n", i);
            const stop = end === -1 ? n : end;
            out += source.slice(i, stop);
            i = stop;
            continue;
        }

        // quoted strings
        if (ch === '"' || ch === "'") {
            const quote = ch;
            let j = i + 1;
            while (j < n && source[j] !== quote) {
                if (source[j] === "\\") j++;
                j++;
            }
            j = Math.min(j + 1, n);
            out += source.slice(i, j);
            i = j;
            continue;
        }

        // long strings [[ ]] / [=[ ]=]
        if (ch === "[") {
            const eqMatch = /^\[(=*)\[/.exec(source.slice(i));
            if (eqMatch) {
                const closer = `]${eqMatch[1]}]`;
                const end = source.indexOf(closer, i + eqMatch[0].length);
                const stop = end === -1 ? n : end + closer.length;
                out += source.slice(i, stop);
                i = stop;
                continue;
            }
        }

        if (ch === ";") {
            out += ";";
            i++;
            breakAfter();
            continue;
        }

        const prevChar = source[i - 1] ?? " ";
        const isWordBoundaryBefore = !/[a-zA-Z0-9_]/.test(prevChar);

        if (isWordBoundaryBefore) {
            const kwMatch = /^[a-zA-Z_][a-zA-Z0-9_]*/.exec(source.slice(i));
            if (kwMatch) {
                const word = kwMatch[0];
                const nextChar = source[i + word.length] ?? " ";
                const isWordBoundaryAfter = !/[a-zA-Z0-9_]/.test(nextChar);

                if (isWordBoundaryAfter && BREAK_BEFORE.has(word)) {
                    breakBefore();
                    out += word;
                    i += word.length;
                    continue;
                }
                if (isWordBoundaryAfter && BREAK_AFTER.has(word)) {
                    out += word;
                    i += word.length;
                    breakAfter();
                    continue;
                }
            }
        }

        out += ch;
        i++;
    }

    return out
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .join("\n");
}

/** Heuristic: does this look like a minified/one-line script worth expanding? */
export function looksMinified(source: string): boolean {
    const lines = source.split(/\r?\n/).filter((l) => l.trim().length > 0);
    if (lines.length <= 2 && source.length > 200) return true;
    const longestLine = Math.max(...lines.map((l) => l.length), 0);
    return longestLine > 500 && lines.length < source.length / 400;
}