# files-editor

[herdr-app](https://herdr.dev) の Mod。テキストファイルを編集して保存する、タブ付きのペイン。Markdown は整形表示もできる。

## 導入

    git clone git@github.com:naoto-anzai/files-editor.git ~/Projects/herdr-mods/files-editor
    ln -s ~/Projects/herdr-mods/files-editor ~/.config/herdr-app/mods/files-editor

(ホットリロードまで使うなら、`mods-watcher` のファイル単位 symlink にする。)

## 開く

    herdr-app do pane.split --direction right --mod files-editor --props '{"file":"/abs/path/file.md"}'
    # リモートのファイルは "on":"<machine>" を足す

Files からは、同梱 `files` の clone(`files-md`)が `shared("files-editor:open:<viewer>")` に `{file,on,seq}` を書いて開く。

## 機能

- タブ列(未保存の●。未保存のタブは × を 2 回押して閉じる)。
- 保存(ヘッダーのボタン / Cmd+S)。ローカルは `writeTextFile` の `expected` で競合を検出する。
  リモートは「読み直して比較 → `hc file write --on` → 読み戻して照合」(本文はローカルの `sh` の引数 → 標準入力でリモートへ。800 KiB まで)。
- 外部での変更: 未編集なら黙って読み直し、編集中・削除ならバナー(読み込む / 上書き / 再作成)。
- `.md` は既定が「表示」(整形)、「編集」(ソース)と切り替え。相対の `.md` リンクは新しいタブ。
- 「表示」では、行頭の ``` フェンスのコードを自前でハイライトし(js/ts・python・sh・c 系・json・yaml・html・diff。未対応の言語は無色)、```` ```mermaid ```` を図にする(コードブロックは 40 個まで)。
  各ブロックに言語名とコピーボタンがある。長い行は折り返し、ブロック内はスクロールしない(外側の縦スクロールに任せる)。

## mermaid の図

mermaid-cli で SVG に変換する。事前に 1 回 `./setup-mermaid.sh` を実行する(Google Chrome が必要、約 440MB)。
結果は `~/.config/herdr-app/data/files-editor/<hash>.svg` にキャッシュ。未導入・変換失敗のときは、エラーとソースを表示する。
リモートのファイルの図も、変換はこの computer で行う。

## 制約

- 1 MiB を超えるファイルとバイナリは開かない(切り詰めて上書きする事故を避けるため)。
- 保存せずにペインを閉じると、警告なしで編集が失われる。
- すでに開いているペインは、コードを直しても入れ替わらない(閉じて開き直す)。
- 詳細・引き継ぎ: [HANDOFF.md](HANDOFF.md)

## 経緯

Markdown の整形表示は、md-viewer(アーカイブ済み)から移植した。
