#!/bin/sh
# files-editor の「表示」で mermaid 図を出すのに使う mermaid-cli を ~/.local/share/md-viewer-mermaid に入れる。
# (置き場の名前は、md-viewer から移植した経緯で md-viewer-mermaid のまま。導入済みなら再導入は要らない。)
# Chromium は同梱せず、入っている Google Chrome を使う(約 440MB の node_modules が入る)。
set -e
D="$HOME/.local/share/md-viewer-mermaid"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
[ -x "$CHROME" ] || { echo "Google Chrome が見つかりません: $CHROME" >&2; exit 1; }
mkdir -p "$D" && cd "$D"
PUPPETEER_SKIP_DOWNLOAD=1 npm i --silent @mermaid-js/mermaid-cli
printf '{ "executablePath": "%s", "args": ["--no-sandbox"] }\n' "$CHROME" > pp.json
# SVG に HTML ラベル(foreignObject)を使うと herdr の画像描画で文字が出ないため false にする。
echo '{ "htmlLabels": false, "flowchart": { "htmlLabels": false }, "theme": "dark" }' > mm.json
# herdr アプリの環境には node の PATH が無いので、入れたときの node の場所を記録する。
echo "export PATH=\"$(dirname "$(which node)"):\$PATH\"" > env.sh
echo "OK: $D"
