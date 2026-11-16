# files-editor 引き継ぎ

herdr-app の Mod。テキストファイルを編集して保存する、タブ付きのペイン。

## できること(実装済み・実機で確認済み)
- props `{file, on, viewer}` を受けて開く。`file` は絶対パス、`on` はマシン名(リモート)、`viewer` は Files がこのペインを特定する ID。
- タブ列(未保存の●、未保存タブは × → 「破棄?」の 2 段階で閉じる)。
- `.md` は既定が「表示」(整形)、「編集」(ソース)とトグル。相対リンクの `.md` は新しいタブ、`http` は `open`。
- 保存(ヘッダーのボタン / Cmd+S)。
  - ローカル: `writeTextFile(path, text, expected)`。`expected` は読み込んだ時点の内容。
  - リモート(`on` あり): 読み直して比較 → `hc file write --on <マシン>` で書く → 読み戻して照合。
    本文はローカルの `sh` の引数にだけ載せ、リモートへは標準入力で送る(リモート Linux の 1 引数 128 KiB 上限を避ける。500 KiB まで確認)。
    比較から書き込みまでの間の変更は拾えない(ローカルより弱い)。上限は 800 KiB。
- 競合: 未編集なら外部変更を黙って読み直す。編集中・削除されたときはバナー
  (「ディスクの内容を読み込む」/「上書き保存」/「再作成して保存」)。編集は失わない。
- 1 MiB 超などで読めないファイルは開かない(切り詰めて上書きする事故を避けるため)。バイナリは開かない。

## Files からの入口
同梱 `files` の clone(`files-md`、`layouts/mine.json` が参照)が、クリックしたテキストを files-editor のタブで開く。
画像・zip などバイナリだけは Files 内の読み取り専用プレビュー。
shared のキー: `files-editor:pane:<pane>`(ペイン → viewer ID)/ `files-editor:open:<viewer>` = `{file,on,seq}` / `files-editor:pending`(結び付け待ち)。
`files-md` は git 管理外(`~/.config/herdr-app/mods/files-md`)。元の版は `main.js.before-files-editor`。

## md-viewer との関係
files-editor の「表示」は、md-viewer の方式(`TextView.markdown(...).selectable(true).on_link_click`)を写したもの。
md-viewer は別 Mod・別リポジトリで、Markdown のレンダリング改善は md-viewer 側の担当。
Mod 同士は import できないので、改善を files-editor に反映するには手で写す(`render()` 内の `fe-md-scroll` の数行)。

## 「表示」のコードブロック(自前ハイライト)
Editor は高さを自動で決められず、ホイールも奪うので使わない。`highlight()`(言語ごとの正規表現)で行を色付きの小片に分け、`codeBlock()` が div で描く。
外側の `fe-md-scroll` は縦のみ(`overflow_y_scrollbar`)。縦横両方にすると中身の幅が領域に収まらず、折り返しも縦スクロールも効かなかった。
そのため幅の広い表の横スクロールは無い(未確認)。

## 既知の制約・未確認
- 保存失敗の表示(権限のないファイルなど)は実機で未確認(モックでは確認済み)。
- ペインはコードを直しても入れ替わらない。直したあとは閉じて開き直す。
- 保存せずにペインを閉じると、警告なしで編集が失われる(`close()` は 250 ms の制限で確認ダイアログを出せない)。
- Windows のリモートは未確認。

## Story(モック)
`storybook.json` と `main.js` 末尾の `STORYBOOK MOCK` が対。状態は `status`(保存状態)、`tabs`、`view`。
状態が増減したら両方を同時に直す(契約: `~/Projects/herdr-mods/ModsStoryBook/STORYBOOK.md`)。

## 開発
- `herdr-app check ~/.config/herdr-app/mods/files-editor` と `herdr-app shot` で確認する。
- 同梱 Mod / layout は直接編集しない(`mod.clone` / `layout.clone`)。
