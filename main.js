// files-editor: テキストファイルを編集して保存するペイン(タブ付き。md-viewer 相当の表示も持つ)。props {file, on, viewer}。
// - ローカル: writeTextFile の expected に「読み込んだ時点の内容」を渡し、ディスクが変わっていたら拒否 → 競合バナー。
// - リモート(on あり): writeTextFile が local only なので、読み直して比較 → hc file write --on で書く → 読み戻して照合。
//   比較から書き込みまでの間の変更は拾えない(ローカルより弱い)。本文はローカルの sh にだけ引数で渡し、リモートへは標準入力で送る
//   (リモート Linux の 1 引数 128 KiB 上限を避ける。500 KiB まで実機で確認済み)。
// - 1 MiB 超などで読めないファイルは開かない(一部だけ読んで全体を上書きする事故を避けるため、切り詰めない)。
// - Files からの「ここで開く」依頼: shared("files-editor:open:<viewer>") = {file, on, seq}(Files = files-md が書く)。
import { View, div } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState, TextView } from "gpui-base";
import { theme, shared, props, exec, readTextFile, writeTextFile, watchFolder, settings } from "herdr";

const dirname = (p) => p.replace(/\/[^/]*$/, "") || "/";
const basename = (p) => p.split("/").pop();
const isMd = (f) => /\.(md|markdown)$/i.test(f);
const LANG = { ts: "js", tsx: "js", mts: "js", cts: "js", jsx: "js", mjs: "js", toml: "yaml", jsonc: "json", svelte: "html", vue: "html", md: "markdown", markdown: "markdown" };
const WRAP = new Set(["md", "markdown", "txt", "rst", "tex"]);
// リモート保存で本文を引数に載せられる上限(macOS の ARG_MAX 1 MiB に余裕を持たせる)。
const REMOTE_MAX_BYTES = 800 * 1024;
const utf8Length = (t) => { let n = 0; for (let i = 0; i < t.length; i++) { const c = t.charCodeAt(i); n += c < 0x80 ? 1 : c < 0x800 ? 2 : c >= 0xd800 && c <= 0xdfff ? 2 : 3; } return n; };
class Stale extends Error {}

// 相対パスを file のあるフォルダ基準で解決する(. と .. を畳む)。
function resolve(base, rel) {
  const out = rel.startsWith("/") ? [] : base.split("/");
  for (const seg of rel.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") out.pop(); else out.push(seg);
  }
  return out.join("/") || "/";
}

function editorState(file, text) {
  const t = theme(), ext = file.includes(".") ? file.split(".").pop().toLowerCase() : "txt";
  return EditorState.new({
    language: LANG[ext] ?? ext, readonly: false, value: text, soft_wrap: WRAP.has(ext),
    font_family: settings().font_family, font_size: 13,
    syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 },
  });
}

// タブ 1 つ分の状態。base は最後に読み込んだ/保存したディスクの内容(競合検出の expected)。
const newTab = (file, on) => ({
  file, on: on ?? null, state: null, base: null, dirty: false, conflict: null, error: null, notice: null,
  saving: false, armed: false, mode: isMd(file) ? "view" : "edit",
});

export default class FilesEditor extends View {
  init(_props, cx) {
    const p = props() ?? {};
    this.viewer = p.viewer ?? null; // Files がこのペインを特定するための ID
    this.tabs = p.file ? [newTab(p.file, p.on)] : [];
    this.active = 0;
    this.seq = 0;
    this.watchGen = 0;
    if (storybook("files-editor")) {
      // モック中は本番のファイル読み書き・監視をしない。状態表示用に編集器だけ作る。
      this.mockEdit = editorState("sample.md", MOCK_TEXT);
      return;
    }
    if (this.tabs[0]) { this.load(this.tabs[0], cx); this.watchActive(cx); }
  }

  get cur() { return this.tabs[this.active] ?? null; }

  load(t, cx) {
    cx.spawn(async (cx) => {
      try {
        const text = await readTextFile(t.file, { on: t.on });
        if (text === null) t.error = "ファイルが見つかりません";
        else if (text.includes("\0")) t.error = "バイナリファイルは編集できません";
        else this.attach(t, text);
      } catch { t.error = "読み込めません(1 MiB を超える、または権限がありません)"; }
      cx.notify();
    });
  }

  attach(t, text) {
    t.base = text; t.dirty = false; t.conflict = null; t.error = null;
    t.state = editorState(t.file, text);
    t.state.on("change", (_e, cx) => { t.dirty = t.state.value() !== t.base; t.armed = false; cx.notify(); });
  }

  // 表示中のタブのあるフォルダを見張る。ローカルは watchFolder、リモートは 10 秒ごと。
  watchActive(cx) {
    const t = this.cur, gen = ++this.watchGen;
    if (!t) return;
    cx.spawn(async (cx) => {
      while (this.watchGen === gen) {
        try { if (t.on) await exec("sleep", ["10"]); else await watchFolder(dirname(t.file)); } catch { return; }
        if (this.watchGen !== gen) return;
        await this.sync(t, cx);
      }
    });
  }

  // 外部での変更を拾う。未編集なら黙って読み直し、編集中なら競合として知らせる(編集は失わない)。
  async sync(t, cx) {
    if (!t.state || t.saving) return;
    let disk;
    try { disk = await readTextFile(t.file, { on: t.on }); } catch { return; }
    if (disk === t.base) { if (t.conflict) { t.conflict = null; cx.notify(); } return; }
    if (disk === null) t.conflict = "deleted";
    else if (!t.dirty) { t.base = disk; t.state.set_value(disk); t.dirty = false; t.conflict = null; }
    else t.conflict = "changed";
    cx.notify();
  }

  // --- タブ操作 ---
  // 同じファイルが開いていればそのタブへ、なければ新しいタブを足して切り替える。
  openTab(file, on, cx) {
    const i = this.tabs.findIndex((t) => t.file === file && t.on === (on ?? null));
    if (i >= 0) { this.active = i; this.sync(this.tabs[i], cx); }
    else { const t = newTab(file, on); this.tabs.push(t); this.active = this.tabs.length - 1; this.load(t, cx); }
    this.watchActive(cx);
    cx.notify();
  }

  select(i, cx) {
    if (i === this.active) return;
    this.active = i;
    this.watchActive(cx);
    this.sync(this.tabs[i], cx);
    cx.notify();
  }

  // 未保存のタブは、1 回目の × で「破棄?」に変わり、もう一度押すと閉じる(編集を黙って捨てない)。
  closeTab(i, cx) {
    const t = this.tabs[i];
    if (t.dirty && !t.armed) { t.armed = true; cx.notify(); return; }
    t.state?.release();
    this.tabs.splice(i, 1);
    this.active = Math.min(this.active > i ? this.active - 1 : this.active, Math.max(this.tabs.length - 1, 0));
    this.watchActive(cx);
    cx.notify();
  }

  link(url, cx) {
    const t = this.cur;
    if (/^https?:\/\//.test(url)) { exec("open", [url]); return; }
    if (url.startsWith("#") || !t) return;
    const path = decodeURIComponent(url.replace(/^file:\/\//, "").split("#")[0]);
    const target = resolve(dirname(t.file), path);
    if (isMd(target)) this.openTab(target, t.on, cx);
    else if (!t.on) exec("open", [target]);
  }

  // --- 保存 ---
  // 書き込みの本体。ディスクが expected と違えば Stale を投げる。
  async persist(t, text, expected) {
    if (!t.on) {
      try { await writeTextFile(t.file, text, expected); } catch (e) {
        let disk; try { disk = await readTextFile(t.file); } catch { disk = undefined; }
        if (disk !== undefined && disk !== expected) throw new Stale(disk === null ? "deleted" : "changed");
        throw e;
      }
      return;
    }
    if (utf8Length(text) > REMOTE_MAX_BYTES) throw new Error("リモートへは 800 KiB を超えるファイルを保存できません");
    const disk = await readTextFile(t.file, { on: t.on });
    if (disk !== expected) throw new Stale(disk === null ? "deleted" : "changed");
    const r = await exec("sh", ["-c", 'printf %s "$1" | hc file write --on "$3" "$2"', "files-editor", text, t.file, t.on]);
    if (r.code !== 0) throw new Error(r.stderr.trim() || "hc file write が失敗しました");
    const back = await readTextFile(t.file, { on: t.on });
    if (back !== text) throw new Error("書き込み後の読み戻しが一致しません(リモートのファイルを確認してください)");
  }

  save(t, cx) {
    if (!t?.state || t.saving || !t.dirty || t.conflict) return;
    const text = t.state.value(), expected = t.base;
    t.saving = true; t.notice = null;
    cx.spawn(async (cx) => {
      try {
        await this.persist(t, text, expected);
        t.base = text; t.dirty = t.state.value() !== text;
      } catch (e) {
        if (e instanceof Stale) t.conflict = e.message; else t.notice = `保存できません: ${String(e.message ?? e)}`;
      } finally { t.saving = false; cx.notify(); }
    });
  }

  // 競合の解消: 編集を捨ててディスクの内容を読む / 今のディスクを確認した上で編集内容で上書きする。
  reloadFromDisk(t, cx) {
    cx.spawn(async (cx) => {
      try {
        const disk = await readTextFile(t.file, { on: t.on });
        if (disk === null) { t.notice = "ファイルが削除されています"; return; }
        t.base = disk; t.state.set_value(disk); t.dirty = false; t.conflict = null; t.notice = null;
      } catch (e) { t.notice = `読み込めません: ${String(e)}`; }
      finally { cx.notify(); }
    });
  }

  overwrite(t, cx) {
    const text = t.state.value();
    t.saving = true;
    cx.spawn(async (cx) => {
      try {
        const disk = await readTextFile(t.file, { on: t.on });
        await this.persist(t, text, disk);
        t.base = text; t.dirty = t.state.value() !== text; t.conflict = null; t.notice = null;
      } catch (e) { t.notice = `上書きできません: ${String(e.message ?? e)}`; }
      finally { t.saving = false; cx.notify(); }
    });
  }

  button(t, id, label, onClick, { primary = false, enabled = true } = {}) {
    return div().id(id).flex_none().px(10).h(24).flex().items_center().rounded(6).text_size(12)
      .when(primary, (el) => el.bg(enabled ? t.solid : t.raised).text_color(enabled ? t.solid_foreground : t.dim))
      .when(!primary, (el) => el.border_1().border_color(t.border).text_color(t.foreground))
      .when(enabled, (el) => el.cursor_pointer().hover((s) => s.opacity(0.85)).on_click((_e, cx) => onClick(cx)))
      .child(label);
  }

  render(cx) {
    const t = theme(), mock = storybook("files-editor");
    // Files からの「このペインで開く」依頼を受け取る。
    const req = this.viewer && !mock ? shared(`files-editor:open:${this.viewer}`) : null;
    if (req && req.seq > this.seq) { this.seq = req.seq; this.openTab(req.file, req.on ?? null, cx); }

    const c = this.cur;
    const v = mock ? mockView({ ...DEFAULTS, ...mock }, this) : {
      names: this.tabs.map((x) => ({ name: basename(x.file), dirty: x.dirty, armed: x.armed })), active: this.active,
      file: c?.file ?? null, on: c?.on ?? null, error: c ? c.error : "開いているファイルはありません", state: c?.state ?? null,
      dirty: c?.dirty ?? false, conflict: c?.conflict ?? null, notice: c?.notice ?? null, saving: c?.saving ?? false,
      mode: c?.mode ?? "edit", isMd: c ? isMd(c.file) : false, text: c?.state?.value() ?? "",
    };
    // モック中はクリックしても何も起きない(実ファイルに触れない)。
    const act = (fn) => (cx) => { if (!mock) fn(cx); };
    const setMode = (m) => act((cx) => { if (c) { c.mode = m; cx.notify(); } });

    const badge = v.saving ? ["保存中…", t.dim] : v.dirty ? ["● 未保存", t.blocked] : ["保存済み", t.dim];
    const viewing = v.isMd && v.mode === "view";
    return v_flex().id("files-editor").size_full().min_h(0).bg(t.surface).text_color(t.foreground).text_size(13)
      .on_key_down((e, cx) => { if (e.keystroke === "cmd-s") act((cx) => this.save(this.cur, cx))(cx); })
      // タブ列
      .when(v.names.length > 0, (el) => el.child(div().id("fe-tabs").flex().flex_row().h(34).flex_none().overflow_x_scroll().border_b(1).border_color(t.border)
        .children(v.names.map((n, i) => div().id(`fe-tab-${i}`).flex().flex_row().flex_none().items_center().gap(6).h_full().pl(12).pr(6).max_w(220)
          .cursor_pointer().text_size(12).border_r(1).border_color(t.border)
          .bg(i === v.active ? t.surface : t.chrome).text_color(i === v.active ? t.foreground : t.muted)
          .when(i === v.active, (el) => el.border_b(2).border_color(t.accent))
          .on_click((_e, cx) => act((cx) => this.select(i, cx))(cx))
          .when(n.dirty, (el) => el.child(div().flex_none().text_color(t.blocked).child("●")))
          .child(div().min_w(0).truncate().child(n.name))
          .child(div().id(`fe-close-${i}`).h(18).min_w(18).px(n.armed ? 4 : 0).flex().items_center().justify_center().rounded(4)
            .text_size(n.armed ? 11 : 13).text_color(n.armed ? t.blocked : t.dim).hover((s) => s.bg(t.hover))
            .on_click((e, cx) => { e.stopPropagation?.(); act((cx) => this.closeTab(i, cx))(cx); })
            .child(n.armed ? "破棄?" : "×"))))))
      // 情報行: 場所・マシン名・保存状態・表示切替・保存
      .child(h_flex().h(30).flex_none().px(12).gap(10).items_center().border_b(1).border_color(t.border).bg(t.chrome)
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(v.file ? dirname(v.file) : "files-editor"))
        .when(Boolean(v.on), (el) => el.child(div().flex_none().text_size(11).px(6).rounded(4).bg(t.raised).text_color(t.muted).child(v.on)))
        .when(!v.error, (el) => el.child(div().flex_none().text_size(11).text_color(badge[1]).child(badge[0])))
        .when(!v.error && v.isMd, (el) => el.child(h_flex().flex_none().gap(2)
          .child(this.button(t, "fe-mode-view", "表示", setMode("view"), { primary: viewing }))
          .child(this.button(t, "fe-mode-edit", "編集", setMode("edit"), { primary: !viewing }))))
        .when(!v.error, (el) => el.child(this.button(t, "fe-save", "保存", act((cx) => this.save(this.cur, cx)), { primary: true, enabled: v.dirty && !v.conflict && !v.saving }))))
      // 細いペインでも崩れないよう、メッセージの行とボタンの行を分ける。
      .when(Boolean(v.conflict), (el) => el.child(v_flex().flex_none().px(12).py(8).gap(8).bg(t.raised).border_b(1).border_color(t.border)
        .child(div().text_size(12).text_color(t.blocked).child(v.conflict === "deleted" ? "ディスク上のファイルが削除されました" : "ディスク上のファイルが変更されました"))
        .child(h_flex().gap(8).flex_wrap()
          .when(v.conflict === "changed", (el) => el.child(this.button(t, "fe-reload", "ディスクの内容を読み込む", act((cx) => this.reloadFromDisk(this.cur, cx)))))
          .child(this.button(t, "fe-overwrite", v.conflict === "deleted" ? "再作成して保存" : "上書き保存", act((cx) => this.overwrite(this.cur, cx)))))))
      .when(Boolean(v.notice), (el) => el.child(div().flex_none().px(12).py(6).text_size(12).text_color(t.ansi1).bg(t.raised).border_b(1).border_color(t.border).child(v.notice)))
      .child(v.error
        ? div().p(12).text_color(t.dim).child(v.error)
        : viewing
          ? div().id("fe-md-scroll").flex_1().min_h(0).overflow_y_scrollbar().p(16)
              .child(TextView.markdown("fe-md-body", v.text ?? "").selectable(true).on_link_click((url, cx) => act((cx) => this.link(url, cx))(cx)))
          : v.state ? Editor.new(v.state).flex_1().min_h(0) : div().p(12).text_color(t.dim).child("読み込み中…"));
  }
}

// ===== STORYBOOK MOCK =====
// モック中(Story が開いたプレビュー)は選択値、本番なら null (STORYBOOK.md §3 の正本)。
export function storybook(mod) {
  const id = props()?.storybook;
  return id ? (shared(`storybook:${mod}:${id}`)?.values ?? {}) : null;
}

const DEFAULTS = { status: "clean", tabs: "single", view: "edit" };
const MOCK_TEXT = "# 見出し\n\n本文。とても長い行は折り返される。" + "長い行 ".repeat(40) + "\n\n- 項目A\n- 項目B\n\n> 引用文\n\n```js\nconst x = 1;\n```\n";
const MOCK_TABS = ["README.md", "notes.md", "main.js", "very-long-file-name-for-testing.md"];

// status ごとの表示入力。本番のデータ関数・副作用は使わない。
function mockView(sb, self) {
  const many = sb.tabs === "many", file = "/Users/me/project/docs/sample.md";
  const noTabs = sb.status === "empty";
  const names = noTabs ? [] : (many ? MOCK_TABS : ["sample.md"]).map((name, i) => ({ name, dirty: sb.status === "dirty" && i === (many ? 1 : 0), armed: false }));
  const base = { names, active: many ? 1 : 0, file, on: null, error: null, state: self.mockEdit, dirty: false, conflict: null, notice: null, saving: false, mode: sb.view, isMd: true, text: MOCK_TEXT };
  switch (sb.status) {
    case "dirty": return { ...base, dirty: true };
    case "conflict": return { ...base, dirty: true, conflict: "changed" };
    case "deleted": return { ...base, dirty: true, conflict: "deleted" };
    case "remote": return { ...base, on: "vps", dirty: true };
    case "saveError": return { ...base, dirty: true, notice: "保存できません: Permission denied" };
    case "error": return { ...base, error: "読み込めません(1 MiB を超える、または権限がありません)", state: null };
    case "empty": return { ...base, file: null, error: "開いているファイルはありません", state: null, isMd: false };
    default: return base;
  }
}
