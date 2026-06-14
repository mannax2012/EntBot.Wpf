Place a Windows Node runtime here for standalone desktop releases.

Expected file:
- node.exe

Final publish layout:
- EntBot.Wpf.exe
- runtime\node\node.exe
- bot\...

The WPF app will use this bundled node.exe first, and only fall back to PATH when it is missing.
