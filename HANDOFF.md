# files-editor 引き継ぎ(md-viewer のセッション t2y からの依頼を、t3v が転記)

## 目的
Files(同梱 files の clone)の拡張として、Markdown などのテキストを実際に「編集」できるようにする Mod。
今の md-viewer(閲覧専用・ペイン内タブ)とは切り離して、このセッションで進める。

## 既存
- ~/Projects/herdr-mods/md-viewer(naoto-anzai/md-viewer): props {file, on, viewer} を受け取り、ペイン内タブで Markdown を表示する閲覧専用 Mod。
- ~/.config/herdr-app/mods/files-md = 同梱 files の clone。.md を選ぶと md-viewer のタブで開く(git 管理外。layouts/mine.json の Files 参照をこれに向けてある)。

## 守ること
- 同梱 Mod は直接編集しない(mod.clone で複製)。
- 画面を持つ Mod は storybook.json と main.js 内のモックを必ず合わせる(~/Projects/herdr-mods/CLAUDE.md 参照)。
- 編集機能の設計(Files の clone を拡張するか、別 Mod にするか、保存・競合・リモート対応 `on`)は、このセッションで検討する。
- 画面の挙動が変わる操作(layout 切替、Files の差し替え)は、実行前にユーザーへ報告する。
- md-viewer 側は触らない。必要なら md-viewer のセッション(t2y)に相談する。
- GitHub のリポジトリは、まだ作っていない(公開リポジトリは、ユーザーの了承待ち)。push しない。
