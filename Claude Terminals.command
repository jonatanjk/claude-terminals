#!/bin/zsh -il
# macOS launcher: double-click in Finder. An interactive login shell, so node and claude are on PATH even when set up in ~/.zshrc (nvm, fnm).
cd "${0:A:h}" && nohup node_modules/electron/dist/Electron.app/Contents/MacOS/Electron . >/dev/null 2>&1 &
