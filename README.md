# Roblox Bytecode Disassembler

A custom Visual Studio Code extension built to provide a Luau bytecode disassembler panel for learning and analysis.

## Features

* **Live Bytecode View**: Automatically compiles and displays Luau bytecode in a side panel whenever you edit or save `.lua` and `.luau` files.
* **Interactive Toolbar**: Includes search filtering for instructions, options settings, a copy button to grab raw output, and a manual refresh button.
* **Compiler Settings Popover**: Adjust optimization levels, debug levels, constant table dumping, and original source line visibility right from the webview panel.
* **Diagnostic Reporting**: Displays compilation errors and diagnostics inline with precise line and column numbers.

## How to Use

1. Make sure you have the `luau-compile` executable available on your system. The extension automatically checks default folders like `C:/Luau` and `H:/Luau` or custom paths configured in your settings.
2. Open any `.lua` or `.luau` file in Visual Studio Code.
3. If autoShow is enabled, the Luau Bytecode panel will open automatically beside your editor. You can also open it manually using the Command Palette by running the command **Luau: Show Bytecode Panel**.
4. Type in your file and watch the bytecode update automatically based on your configured debounce delay.

## Extension Settings

You can configure the extension through your Visual Studio Code settings under the `luauBytecode` namespace:

* `luauBytecode.compilerPath`: Absolute path to the `luau-compile` executable which overrides auto-detection.
* `luauBytecode.searchDirectories`: Extra folder paths to search for the compiler before checking default locations.
* `luauBytecode.optimizationLevel`: Optimization level passed to the compiler from 0 to 2 with a default of 1.
* `luauBytecode.debugLevel`: Debug level passed to the compiler from 0 to 2 with a default of 1.
* `luauBytecode.dumpConstants`: Boolean option to include each function's constant table in the disassembly output.
* `luauBytecode.autoShow`: Boolean option to automatically open or update the panel on active files.
* `luauBytecode.debounceMs`: Time in milliseconds to wait after you stop typing before recompiling with a default of 350.

## Commands

* **Luau: Show Bytecode Panel**: Opens the disassembler webview panel for the currently active script.