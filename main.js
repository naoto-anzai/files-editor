// files-editor: テキストファイルを編集して保存するペイン。props {file, on}。
// - ローカル: writeTextFile の expected に「読み込んだ時点の内容」を渡し、ディスクが変わっていたら拒否 → 競合バナー。
// - リモート(on あり): writeTextFile が local only なので、読み直して比較 → hc file write --on で書く → 読み戻して照合。
//   比較から書き込みまでの間の変更は拾えない(ローカルより弱い)。本文はローカルの sh にだけ引数で渡し、リモートへは標準入力で送る
//   (リモート Linux の 1 引数 128 KiB 上限を避ける。500 KiB まで実機で確認済み)。
// - 1 MiB 超などで読めないファイルは開かない(一部だけ読んで全体を上書きする事故を避けるため、切り詰めない)。
import { View, div } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState } from "gpui-base";
import { theme, shared, props, exec, readTextFile, writeTextFile, watchFolder, settings } from "herdr";

const dirname = (p) => p.replace(/\/[^/]*$/, "") || "/";
const basename = (p) => p.split("/").pop();
const LANG = { ts: "js", tsx: "js", mts: "js", cts: "js", jsx: "js", mjs: "js", toml: "yaml", jsonc: "json", svelte: "html", vue: "html", md: "markdown", markdown: "markdown" };
const WRAP = new Set(["md", "markdown", "txt", "rst", "tex"]);
// リモート保存で本文を引数に載せられる上限(macOS の ARG_MAX 1 MiB に余裕を持たせる)。
const REMOTE_MAX_BYTES = 800 * 1024;
const utf8Length = (t) => { let n = 0; for (let i = 0; i < t.length; i++) { const c = t.charCodeAt(i); n += c < 0x80 ? 1 : c < 0x800 ? 2 : c >= 0xd800 && c <= 0xdfff ? 2 : 3; } return n; };
class Stale extends Error {}

function editorState(file, text, readonly) {
  const t = theme(), ext = file.includes(".") ? file.split(".").pop().toLowerCase() : "txt";
  return EditorState.new({
    language: LANG[ext] ?? ext, readonly, value: text, soft_wrap: WRAP.has(ext),
    font_family: settings().font_family, font_size: 13,
    syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 },
  });
}

export default class FilesEditor extends View {
  init(_props, cx) {
    const p = props() ?? {};
    this.file = p.file ?? null;
    this.on = p.on ?? null;
    this.state = null;     // EditorState(本番)
    this.base = null;      // 最後に読み込んだ/保存したディスクの内容(競合検出の expected)
    this.dirty = false;
    this.conflict = null;  // null | "changed" | "deleted"
    this.error = null;     // 開けない理由
    this.notice = null;    // 保存失敗などの一言
    this.saving = false;
    if (storybook("files-editor")) {
      // モック中は本番のファイル読み書き・監視をしない。状態表示用に編集器だけ作る。
      this.mockEdit = editorState("sample.md", MOCK_TEXT, false);
      return;
    }
    this.load(cx);
    this.watch(cx);
  }

  load(cx) {
    if (!this.file) { this.error = "開いているファイルはありません"; return; }
    const file = this.file, on = this.on;
    cx.spawn(async (cx) => {
      try {
        const text = await readTextFile(file, { on });
        if (text === null) this.error = "ファイルが見つかりません";
        else if (text.includes("\0")) this.error = "バイナリファイルは編集できません";
        else this.attach(text, cx);
      } catch { this.error = "読み込めません(1 MiB を超える、または権限がありません)"; }
      cx.notify();
    });
  }

  attach(text, _cx) {
    this.base = text; this.dirty = false; this.conflict = null;
    this.state = editorState(this.file, text, false);
    this.state.on("change", (_e, cx) => { this.dirty = this.state.value() !== this.base; cx.notify(); });
  }

  // 外部での変更を拾う。未編集なら黙って読み直し、編集中なら競合として知らせる(編集は失わない)。
  watch(cx) {
    if (!this.file) return;
    if (this.on) { cx.timer.every(10000, (cx) => this.sync(cx)); return; }
    const dir = dirname(this.file);
    cx.spawn(async (cx) => {
      for (;;) {
        try { await watchFolder(dir); } catch { return; }
        await this.sync(cx);
      }
    });
  }

  async sync(cx) {
    if (!this.state || this.saving) return;
    let disk;
    try { disk = await readTextFile(this.file, { on: this.on }); } catch { return; }
    if (disk === this.base) { if (this.conflict) { this.conflict = null; cx.notify(); } return; }
    if (disk === null) this.conflict = "deleted";
    else if (!this.dirty) { this.base = disk; this.state.set_value(disk); this.dirty = false; this.conflict = null; }
    else this.conflict = "changed";
    cx.notify();
  }

  // 書き込みの本体。ディスクが expected と違えば Stale を投げる。
  async persist(file, text, expected) {
    if (!this.on) {
      try { await writeTextFile(file, text, expected); } catch (e) {
        let disk; try { disk = await readTextFile(file); } catch { disk = undefined; }
        if (disk !== undefined && disk !== expected) throw new Stale(disk === null ? "deleted" : "changed");
        throw e;
      }
      return;
    }
    if (utf8Length(text) > REMOTE_MAX_BYTES) throw new Error("リモートへは 800 KiB を超えるファイルを保存できません");
    const disk = await readTextFile(file, { on: this.on });
    if (disk !== expected) throw new Stale(disk === null ? "deleted" : "changed");
    const r = await exec("sh", ["-c", 'printf %s "$1" | hc file write --on "$3" "$2"', "files-editor", text, file, this.on]);
    if (r.code !== 0) throw new Error(r.stderr.trim() || "hc file write が失敗しました");
    const back = await readTextFile(file, { on: this.on });
    if (back !== text) throw new Error("書き込み後の読み戻しが一致しません(リモートのファイルを確認してください)");
  }

  save(cx) {
    if (!this.state || this.saving || !this.dirty || this.conflict) return;
    const file = this.file, text = this.state.value(), expected = this.base;
    this.saving = true; this.notice = null;
    cx.spawn(async (cx) => {
      try {
        await this.persist(file, text, expected);
        this.base = text; this.dirty = this.state.value() !== text;
      } catch (e) {
        if (e instanceof Stale) this.conflict = e.message; else this.notice = `保存できません: ${String(e.message ?? e)}`;
      } finally { this.saving = false; cx.notify(); }
    });
  }

  // 競合の解消: 編集を捨ててディスクの内容を読む / 今のディスクを確認した上で編集内容で上書きする。
  reloadFromDisk(cx) {
    cx.spawn(async (cx) => {
      try {
        const disk = await readTextFile(this.file, { on: this.on });
        if (disk === null) { this.notice = "ファイルが削除されています"; return; }
        this.base = disk; this.state.set_value(disk); this.dirty = false; this.conflict = null; this.notice = null;
      } catch (e) { this.notice = `読み込めません: ${String(e)}`; }
      finally { cx.notify(); }
    });
  }

  overwrite(cx) {
    const file = this.file, text = this.state.value();
    this.saving = true;
    cx.spawn(async (cx) => {
      try {
        const disk = await readTextFile(file, { on: this.on });
        await this.persist(file, text, disk);
        this.base = text; this.dirty = this.state.value() !== text; this.conflict = null; this.notice = null;
      } catch (e) { this.notice = `上書きできません: ${String(e.message ?? e)}`; }
      finally { this.saving = false; cx.notify(); }
    });
  }

  button(t, id, label, onClick, { primary = false, enabled = true } = {}) {
    return div().id(id).flex_none().px(10).h(24).flex().items_center().rounded(6).text_size(12)
      .when(primary, (el) => el.bg(enabled ? t.solid : t.raised).text_color(enabled ? t.solid_foreground : t.dim))
      .when(!primary, (el) => el.border_1().border_color(t.border).text_color(t.foreground))
      .when(enabled, (el) => el.cursor_pointer().hover((s) => s.opacity(0.85)).on_click((_e, cx) => onClick(cx)))
      .child(label);
  }

  render(_cx) {
    const t = theme(), mock = storybook("files-editor");
    const v = mock ? mockView({ ...DEFAULTS, ...mock }, this) : {
      file: this.file, on: this.on, error: this.error, state: this.state, dirty: this.dirty,
      conflict: this.conflict, notice: this.notice, saving: this.saving,
    };
    // モック中はクリックしても何も起きない(実ファイルに触れない)。
    const act = (fn) => (cx) => { if (!mock) fn(cx); };

    const badge = v.saving ? ["保存中…", t.dim] : v.dirty ? ["● 未保存", t.blocked] : ["保存済み", t.dim];
    return v_flex().id("files-editor").size_full().min_h(0).bg(t.surface).text_color(t.foreground).text_size(13)
      .on_key_down((e, cx) => { if (e.keystroke === "cmd-s") { act((cx) => this.save(cx))(cx); } })
      .child(h_flex().h(34).flex_none().px(12).gap(10).items_center().border_b(1).border_color(t.border).bg(t.chrome)
        .child(div().font_semibold().min_w(0).truncate().child(v.file ? basename(v.file) : "files-editor"))
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(v.file ? dirname(v.file) : ""))
        .when(Boolean(v.on), (el) => el.child(div().flex_none().text_size(11).px(6).rounded(4).bg(t.raised).text_color(t.muted).child(v.on)))
        .when(!v.error, (el) => el.child(div().flex_none().text_size(11).text_color(badge[1]).child(badge[0])))
        .when(!v.error, (el) => el.child(this.button(t, "fe-save", "保存", act((cx) => this.save(cx)), { primary: true, enabled: v.dirty && !v.conflict && !v.saving }))))
      // 細いペインでも崩れないよう、メッセージの行とボタンの行を分ける。
      .when(Boolean(v.conflict), (el) => el.child(v_flex().flex_none().px(12).py(8).gap(8).bg(t.raised).border_b(1).border_color(t.border)
        .child(div().text_size(12).text_color(t.blocked).child(v.conflict === "deleted" ? "ディスク上のファイルが削除されました" : "ディスク上のファイルが変更されました"))
        .child(h_flex().gap(8).flex_wrap()
          .when(v.conflict === "changed", (el) => el.child(this.button(t, "fe-reload", "ディスクの内容を読み込む", act((cx) => this.reloadFromDisk(cx)))))
          .child(this.button(t, "fe-overwrite", v.conflict === "deleted" ? "再作成して保存" : "上書き保存", act((cx) => this.overwrite(cx)))))))
      .when(Boolean(v.notice), (el) => el.child(div().flex_none().px(12).py(6).text_size(12).text_color(t.ansi1).bg(t.raised).border_b(1).border_color(t.border).child(v.notice)))
      .child(v.error
        ? div().p(12).text_color(t.dim).child(v.error)
        : v.state ? Editor.new(v.state).flex_1().min_h(0) : div().p(12).text_color(t.dim).child("読み込み中…"));
  }
}

// ===== STORYBOOK MOCK =====
// モック中(Story が開いたプレビュー)は選択値、本番なら null (STORYBOOK.md §3 の正本)。
export function storybook(mod) {
  const id = props()?.storybook;
  return id ? (shared(`storybook:${mod}:${id}`)?.values ?? {}) : null;
}

const DEFAULTS = { status: "clean" };
const MOCK_TEXT = "# 見出し\n\n本文。とても長い行は折り返される。" + "長い行 ".repeat(40) + "\n\n- 項目A\n- 項目B\n\n```js\nconst x = 1;\n```\n";

// status ごとの表示入力。本番のデータ関数・副作用は使わない。
function mockView(sb, self) {
  const base = { file: "/Users/me/project/docs/sample.md", on: null, error: null, state: self.mockEdit, dirty: false, conflict: null, notice: null, saving: false };
  switch (sb.status) {
    case "dirty": return { ...base, dirty: true };
    case "conflict": return { ...base, dirty: true, conflict: "changed" };
    case "deleted": return { ...base, dirty: true, conflict: "deleted" };
    case "remote": return { ...base, on: "vps", dirty: true };
    case "saveError": return { ...base, dirty: true, notice: "保存できません: Permission denied" };
    case "error": return { ...base, error: "読み込めません(1 MiB を超える、または権限がありません)", state: null };
    case "empty": return { ...base, file: null, error: "開いているファイルはありません", state: null };
    default: return base;
  }
}
