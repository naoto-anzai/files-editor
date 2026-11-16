// files-editor: テキストファイルを編集して保存するペイン(タブ付き。md-viewer 相当の表示も持つ)。props {file, on, viewer}。
// - ローカル: writeTextFile の expected に「読み込んだ時点の内容」を渡し、ディスクが変わっていたら拒否 → 競合バナー。
// - リモート(on あり): writeTextFile が local only なので、読み直して比較 → hc file write --on で書く → 読み戻して照合。
//   比較から書き込みまでの間の変更は拾えない(ローカルより弱い)。本文はローカルの sh にだけ引数で渡し、リモートへは標準入力で送る
//   (リモート Linux の 1 引数 128 KiB 上限を避ける。500 KiB まで実機で確認済み)。
// - 1 MiB 超などで読めないファイルは開かない(一部だけ読んで全体を上書きする事故を避けるため、切り詰めない)。
// - 「表示」では、行頭の ``` フェンスのコードを読み取り専用 Editor でハイライトし、```mermaid は mermaid-cli で SVG にして図で出す
//   (md-viewer からの移植。導入: setup-mermaid.sh。リモートのファイルの図も変換はこの computer で行う)。
// - Files からの「ここで開く」依頼: shared("files-editor:open:<viewer>") = {file, on, seq}(Files = files-md が書く)。
import { View, div, image } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState, TextView } from "gpui-base";
import { theme, shared, props, exec, readTextFile, writeTextFile, watchFolder, settings, home, appHome } from "herdr";

const dirname = (p) => p.replace(/\/[^/]*$/, "") || "/";
const basename = (p) => p.split("/").pop();
const isMd = (f) => /\.(md|markdown)$/i.test(f);
const LANG = { ts: "js", tsx: "js", mts: "js", cts: "js", jsx: "js", mjs: "js", javascript: "js", typescript: "js", toml: "yaml", jsonc: "json", svelte: "html", vue: "html", md: "markdown", markdown: "markdown", shell: "sh", bash: "sh", zsh: "sh", py: "python" };
const WRAP = new Set(["md", "markdown", "txt", "rst", "tex"]);
// リモート保存で本文を引数に載せられる上限(macOS の ARG_MAX 1 MiB に余裕を持たせる)。
const REMOTE_MAX_BYTES = 800 * 1024;
const utf8Length = (t) => { let n = 0; for (let i = 0; i < t.length; i++) { const c = t.charCodeAt(i); n += c < 0x80 ? 1 : c < 0x800 ? 2 : c >= 0xd800 && c <= 0xdfff ? 2 : 3; } return n; };
class Stale extends Error {}

const MAX_MD = 400000;        // 「表示」に渡す本文の上限(超えた分は省略。編集・保存には影響しない)
const MAX_CODE_BLOCKS = 40;
const MERMAID_DIR = () => `${home()}/.local/share/md-viewer-mermaid`; // mermaid-cli の置き場(setup-mermaid.sh)

function hash(str) { let h = 5381; for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0; return h.toString(36) + str.length.toString(36); }

// フェンス(```lang ... ```)で本文とコードに分ける。行頭から始まるフェンスだけが対象(リスト内などは TextView に任せる)。
function parse(text) {
  const out = [], re = /^```([^\n`]*)\n([\s\S]*?)\n?^```[ \t]*$/gm;
  let last = 0, m, blocks = 0;
  while ((m = re.exec(text))) {
    if (++blocks > MAX_CODE_BLOCKS) break;
    if (m.index > last) out.push({ type: "md", text: text.slice(last, m.index) });
    const lang = m[1].trim().split(/\s+/)[0].toLowerCase();
    out.push(lang === "mermaid" ? { type: "mermaid", src: m[2], hash: hash(m[2]) } : { type: "code", lang, body: m[2] });
    last = re.lastIndex;
  }
  if (last < text.length) out.push({ type: "md", text: text.slice(last) });
  return out;
}

// ---- コードブロックの自前ハイライト(Editor を使わない: 高さが自動・折り返し・スクロールなし・ホイールは外側へ) ----
const KW = (s) => new Set(s.split(" "));
const HL = {
  js: { alias: "js ts tsx jsx mjs cjs mts cts javascript typescript", line: "//", block: true, q: "\"'`",
    kw: KW("const let var function return if else for while do switch case break continue new class extends import from export default async await try catch finally throw typeof instanceof in of this super static get set yield void delete interface type enum implements public private protected readonly as"),
    consts: KW("true false null undefined NaN Infinity") },
  py: { alias: "py python", line: "#", triple: true, q: "\"'",
    kw: KW("def class return if elif else for while in not and or is import from as with try except finally raise pass break continue lambda yield global nonlocal async await del assert self"),
    consts: KW("True False None") },
  sh: { alias: "sh bash zsh shell fish", line: "#", q: "\"'",
    kw: KW("if then else elif fi for while until do done case esac function in return export local set unset source exit cd"), consts: KW("true false") },
  c: { alias: "c cpp c++ h hpp rust rs go java kotlin kt swift cs csharp php", line: "//", block: true, q: "\"'",
    kw: KW("if else for while do switch case break continue return fn let mut const static struct enum impl trait pub use mod match loop func package import type var interface class new public private protected void int long char float double bool string self this extends implements throw try catch finally"),
    consts: KW("true false null nil None NULL") },
  json: { alias: "json jsonc json5", line: "//", block: true, q: "\"", kw: new Set(), consts: KW("true false null"), keys: true },
  yaml: { alias: "yaml yml toml ini", line: "#", q: "\"'", kw: new Set(), consts: KW("true false null yes no on off"), keys: true },
  html: { alias: "html xml svg vue svelte", q: "\"'", tags: true, kw: new Set(), consts: new Set() },
};
const HL_BY = {};
for (const [fam, c] of Object.entries(HL)) for (const a of c.alias.split(" ")) HL_BY[a] = fam;
const reEsc = (x) => x.replace(/[.*+?^${}()|[\]\\\/]/g, "\\$&");
const HL_RE = {};
function hlRegex(fam) {
  if (HL_RE[fam]) return HL_RE[fam];
  const c = HL[fam], parts = [];
  if (c.tags) parts.push(["comment", "<!--[\\s\\S]*?(?:-->|$)"]);
  if (c.block) parts.push(["comment", "\\/\\*[\\s\\S]*?(?:\\*\\/|$)"]);
  if (c.line) parts.push(["comment", reEsc(c.line) + "[^\\n]*"]);
  if (c.triple) parts.push(["string", "\"\"\"[\\s\\S]*?(?:\"\"\"|$)|'''[\\s\\S]*?(?:'''|$)"]);
  for (const q of c.q) parts.push(["string", q === "`" ? "`(?:\\\\[\\s\\S]|[^`\\\\])*`?" : `${q}(?:\\\\[\\s\\S]|[^${q}\\\\\\n])*${q}?`]);
  if (c.tags) parts.push(["keyword", "<\\/?[A-Za-z][\\w:-]*"]);
  parts.push(["number", "\\b(?:0[xX][\\da-fA-F_]+|\\d[\\d_]*(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)\\b"]);
  parts.push(["word", "[A-Za-z_$][\\w$]*"]);
  return (HL_RE[fam] = { kinds: parts.map((x) => x[0]), re: new RegExp(parts.map((x) => `(${x[1]})`).join("|"), "g") });
}
// 本文を [[文字列, 種別|null], ...] の行の配列にする(種別: keyword string comment function type number constant)。
function highlight(body, lang) {
  if (lang === "diff" || lang === "patch") {
    return body.split("\n").map((l) => [[l, l.startsWith("+") ? "string" : l.startsWith("-") ? "number" : l.startsWith("@@") ? "function" : null]]);
  }
  if (!HL_BY[lang]) return body.split("\n").map((l) => [[l, null]]);
  const fam = HL_BY[lang], c = HL[fam], { kinds, re } = hlRegex(fam), toks = [];
  let last = 0, m; re.lastIndex = 0;
  while ((m = re.exec(body))) {
    if (m[0] === "") { re.lastIndex++; continue; }
    if (m.index > last) toks.push([body.slice(last, m.index), null]);
    let k = kinds[m.slice(1).findIndex((x) => x !== undefined)];
    if (k === "word") {
      const w = m[0], rest = body.slice(re.lastIndex).match(/^[ \t]*(.)/);
      k = c.kw.has(w) ? "keyword" : c.consts.has(w) ? "constant" : /^[A-Z]/.test(w) ? "type" : rest && rest[1] === "(" ? "function" : null;
    } else if (k === "string" && c.keys && /^[ \t]*:/.test(body.slice(re.lastIndex))) k = "function";
    toks.push([m[0], k]); last = re.lastIndex;
  }
  if (last < body.length) toks.push([body.slice(last), null]);
  const rows = [[]];
  for (const [text, k] of toks) text.split("\n").forEach((part, j) => { if (j > 0) rows.push([]); if (part) rows[rows.length - 1].push([part, k]); });
  return rows;
}

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
  saving: false, armed: false, mode: isMd(file) ? "view" : "edit", segs: [], builtFrom: null,
});

export default class FilesEditor extends View {
  init(_props, cx) {
    const p = props() ?? {};
    this.viewer = p.viewer ?? null; // Files がこのペインを特定するための ID
    this.tabs = p.file ? [newTab(p.file, p.on)] : [];
    this.active = 0;
    this.seq = 0;
    this.watchGen = 0;
    this.mermaid = new Map(); // hash -> {status: "pending"|"ok"|"error", w, h, rel, error}
    if (storybook("files-editor")) {
      // モック中は本番のファイル読み書き・監視・変換をしない。EditorState は render で作れないので init で作る。
      this.mockEdits = {}; this.mockSegs = {};
      for (const [k, text] of Object.entries(MOCK_DOCS)) { this.mockEdits[k] = editorState("sample.md", text); this.mockSegs[k] = this.build(text); }
      return;
    }
    if (this.tabs[0]) { this.load(this.tabs[0], cx); this.watchActive(cx); }
  }

  get cur() { return this.tabs[this.active] ?? null; }

  // 本文をセグメントに分け、コードにはハイライト済みの行を作る(変換はここでは始めない)。
  build(text) {
    const segs = parse(text);
    for (const g of segs) if (g.type === "code") g.rows = highlight(g.body, g.lang);
    return segs;
  }

  release(segs) { for (const g of segs ?? []) g.state?.release?.(); }

  // 「表示」用のセグメントを、本文が変わったときだけ作り直す。mermaid は SVG への変換を始める。
  rebuild(t, cx) {
    if (!isMd(t.file) || !t.state) return;
    const text = t.state.value();
    if (text === t.builtFrom) return;
    this.release(t.segs);
    t.segs = this.build(text.length > MAX_MD ? text.slice(0, MAX_MD) + "\n\n… (長いため省略)" : text);
    t.builtFrom = text;
    for (const g of t.segs) if (g.type === "mermaid") this.convert(g, cx);
  }

  convert(g, cx) {
    if (this.mermaid.has(g.hash)) return;
    this.mermaid.set(g.hash, { status: "pending" });
    const dir = `${appHome()}/data/files-editor`, out = `${dir}/${g.hash}.svg`, mm = MERMAID_DIR();
    cx.spawn(async (cx) => {
      try {
        // キャッシュがあれば変換しない。env.sh は setup-mermaid.sh が書く(アプリの環境には node の PATH が無い)。
        const r = await exec("sh", ["-c", 'mkdir -p "$1" && { [ -s "$2" ] || { . "$3/env.sh"; printf "%s" "$4" | "$3/node_modules/.bin/mmdc" -p "$3/pp.json" -c "$3/mm.json" -i - -o "$2" -b transparent; }; }', "sh", dir, out, mm, g.src], { timeout: 60000 });
        if (r.code !== 0) throw new Error((r.stderr || "mmdc failed").trim().split("\n").pop());
        const svg = (await readTextFile(out)) ?? "";
        const vb = svg.match(/viewBox="[-\d.]+ [-\d.]+ ([\d.]+) ([\d.]+)"/);
        if (!vb) throw new Error("SVG の大きさが読めません");
        this.mermaid.set(g.hash, { status: "ok", w: Number(vb[1]), h: Number(vb[2]), rel: `data/files-editor/${g.hash}.svg` });
      } catch (e) { this.mermaid.set(g.hash, { status: "error", error: String(e.message ?? e).slice(0, 200) }); }
      cx.notify();
    });
  }

  // コードブロック: 言語名とコピーボタンの帯 + 色付きの行(折り返す。内側でスクロールしない)。
  codeBlock(g, i, mock, t) {
    const pal = { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 };
    const key = `code-${i}`, copied = this.copied === key;
    const copy = (_e, cx) => {
      if (mock) return;
      cx.write_to_clipboard(g.body);
      this.copied = key; cx.notify();
      cx.spawn(async (cx) => { await exec("sleep", ["1.5"]); if (this.copied === key) { this.copied = null; cx.notify(); } });
    };
    const piece = ([text, k]) => div().text_color(k ? pal[k] : t.foreground).child(text);
    // 長いトークンも収まるよう 40 文字ごとに分ける。
    const chunk = (tok) => (tok[0].length > 40 && !/\s/.test(tok[0])) ? tok[0].match(/[\s\S]{1,40}/g).map((x) => [x, tok[1]]) : [tok];
    return v_flex().id(`fe-code-${i}`).flex_none().rounded(6).overflow_hidden().border_1().border_color(t.border).bg(t.chrome)
      .child(h_flex().h(24).flex_none().px(10).items_center().text_size(11).text_color(t.dim)
        .child(div().flex_1().child(g.lang || "text"))
        .child(div().id(`fe-copy-${i}`).px(6).rounded(4).cursor_pointer().hover((s) => s.opacity(0.8)).on_click(copy).child(copied ? "コピーしました" : "コピー")))
      .child(v_flex().px(10).pb(8).font_family(settings().font_family).text_size(12)
        .children(g.rows.map((row) => h_flex().flex_wrap().children(row.length ? row.flatMap(chunk).map(piece) : [div().child(" ")]))));
  }

  segments(segs, mock, t) {
    return segs.map((g, i) => {
      if (g.type === "code") {
        return this.codeBlock(g, i, mock, t);
      }
      if (g.type === "mermaid") {
        const m = mock ? { status: "mock" } : this.mermaid.get(g.hash) ?? { status: "pending" };
        if (m.status === "ok") { const w = Math.min(m.w, 860); return image(m.rel).w(w).h(m.h * w / m.w).flex_none(); }
        const note = m.status === "error" ? `mermaid の変換に失敗: ${m.error}` : m.status === "mock" ? "mermaid 図(モック: 変換しない)" : "mermaid を変換中…";
        return div().id(`fe-mm-${i}`).flex_none().p(8).rounded(6).border_1().border_color(t.border).text_size(12).text_color(t.dim)
          .child(div().child(note)).child(div().mt(4).text_color(t.muted).child(g.src));
      }
      return TextView.markdown(`fe-md-${i}`, g.text).flex_none().selectable(true).on_link_click((url, cx) => this.link(url, cx)); // flex_none: 縮むとスクロール領域が内容より小さく見えてスクロールできない
    });
  }

  load(t, cx) {
    cx.spawn(async (cx) => {
      try {
        const text = await readTextFile(t.file, { on: t.on });
        if (text === null) t.error = "ファイルが見つかりません";
        else if (text.includes("\0")) t.error = "バイナリファイルは編集できません";
        else this.attach(t, text, cx);
      } catch { t.error = "読み込めません(1 MiB を超える、または権限がありません)"; }
      cx.notify();
    });
  }

  attach(t, text, cx) {
    t.base = text; t.dirty = false; t.conflict = null; t.error = null;
    t.state = editorState(t.file, text);
    if (t.mode === "view") this.rebuild(t, cx);
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
    else if (!t.dirty) { t.base = disk; t.state.set_value(disk); t.dirty = false; t.conflict = null; if (t.mode === "view") this.rebuild(t, cx); }
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
    t.state?.release(); this.release(t.segs);
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
        if (t.mode === "view") this.rebuild(t, cx);
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
      mode: c?.mode ?? "edit", isMd: c ? isMd(c.file) : false, segs: c?.segs ?? [],
    };
    // モック中はクリックしても何も起きない(実ファイルに触れない)。
    const act = (fn) => (cx) => { if (!mock) fn(cx); };
    const setMode = (m) => act((cx) => { if (c) { c.mode = m; if (m === "view") this.rebuild(c, cx); cx.notify(); } });

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
          ? div().id("fe-md-scroll").flex_1().min_h(0).overflow_y_scrollbar().p(16).flex().flex_col().gap(8)
              .children(this.segments(v.segs, mock, t))
          : v.state ? Editor.new(v.state).flex_1().min_h(0) : div().p(12).text_color(t.dim).child("読み込み中…"));
  }
}

// ===== STORYBOOK MOCK =====
// モック中(Story が開いたプレビュー)は選択値、本番なら null (STORYBOOK.md §3 の正本)。
export function storybook(mod) {
  const id = props()?.storybook;
  return id ? (shared(`storybook:${mod}:${id}`)?.values ?? {}) : null;
}

const DEFAULTS = { status: "clean", tabs: "single", view: "edit", doc: "sample" };
const LONG = "長い行 ".repeat(40);
const MOCK_DOCS = {
  sample: "# 見出し\n\n本文。とても長い行は折り返される。" + LONG + "\n\n- 項目A\n- 項目B\n\n> 引用文\n\n[相対リンク](./other.md) / [外部](https://example.com)\n",
  code: "本文\n\n```js\nconst x = 1;\nfunction hello() {\n  return 'world';\n}\n```\n\n```sh\necho " + "very-long-token-".repeat(20) + "\n```\n",
  mermaid: "## mermaid\n\n```mermaid\nflowchart LR\n  A[Files] --> B{md?}\n  B -->|yes| C[files-editor]\n```\n\n続きの本文。\n",
};
const MOCK_TABS = ["README.md", "notes.md", "main.js", "very-long-file-name-for-testing.md"];

// status ごとの表示入力。本番のデータ関数・副作用は使わない。
function mockView(sb, self) {
  const many = sb.tabs === "many", file = "/Users/me/project/docs/sample.md";
  const noTabs = sb.status === "empty";
  const names = noTabs ? [] : (many ? MOCK_TABS : ["sample.md"]).map((name, i) => ({ name, dirty: sb.status === "dirty" && i === (many ? 1 : 0), armed: false }));
  const base = { names, active: many ? 1 : 0, file, on: null, error: null, state: self.mockEdits[sb.doc] ?? self.mockEdits.sample, dirty: false, conflict: null, notice: null, saving: false, mode: sb.view, isMd: true, segs: self.mockSegs[sb.doc] ?? self.mockSegs.sample };
  switch (sb.status) {
    case "dirty": return { ...base, dirty: true };
    case "conflict": return { ...base, dirty: true, conflict: "changed" };
    case "deleted": return { ...base, dirty: true, conflict: "deleted" };
    case "remote": return { ...base, on: "vps", dirty: true };
    case "saveError": return { ...base, dirty: true, notice: "保存できません: Permission denied" };
    case "error": return { ...base, error: "読み込めません(1 MiB を超える、または権限がありません)", state: null, segs: [] };
    case "empty": return { ...base, file: null, error: "開いているファイルはありません", state: null, isMd: false, segs: [] };
    default: return base;
  }
}
