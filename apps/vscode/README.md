# Beamer Editor for VS Code

Beamer サブセットの `.tex` を編集しながら、LaTeX コンパイルなしの即時 HTML プレビューを表示する拡張。[beamer-editor](https://github.com/ebi-oishii/beamer-editor) プロジェクトの VS Code シェル(Phase 5 / M2)です。

## 使い方

`*.slide.tex` は Beamer Editor が管理するスライドの命名規約です。管理対象を開くか active にすると HTML プレビューを自動で開き、編集すると保存しなくても追従します。同じ文書のプレビューは一つだけです。

通常の `.tex` は管理対象ではないため、lint と自動プレビューは動きません。必要なときはコマンドパレットから **Beamer Editor: Open Preview**(またはエディタタイトルのボタン)を実行してください。手動プレビューは任意のローカル `.tex` で利用でき、未保存の編集にも追従します。

- 全フレームを縦に並べて表示し、スクロールで見る(Marp のプレビューと同じ)。スライドのダブルクリックで対応するソース行へジャンプ
- managed slide の lint 結果は Problems パネルとエディタの波線に表示(規則番号付き)
- キャンバスの画像・図(`deckfigure`)・テキスト箱を選択すると、右上のハンドルで幅を変更できる。画像と図は縦横比を保ち、テキストは幅に合わせて折り返す。ハンドルの左右キーでも変更できる
- 選択した箱は Delete / Backspace で削除、Ctrl/Cmd+`C` / `X` でコピー・切り取り(箱のソース原文がクリップボードに入る)、Ctrl/Cmd+`V` で表示中のフレームの `deckcanvas` へ貼り付け(無ければ新設)。同じ位置に箱があれば少し右下へずらす。いずれも 1 回の undo で戻せる
- テキスト箱を選択すると、文字サイズを tiny〜Large の7種類から選べる。幅変更は `w`、文字サイズ変更は `size` だけをソースへ反映する
- Webview にフォーカスしているとき、←/→ キーでフレーム移動。step のあるフレームでは、プレビューに重なるスライダーでオーバーレイ表示を切替
- Ctrl/Cmd+ホイール、Ctrl/Cmd+`+`/`=`・`-` で倍率を調整。Ctrl/Cmd+`0` で幅にフィット
- Webview にフォーカスしているとき、Ctrl/Cmd+`Z` でソースの取り消し、Shift+Ctrl/Cmd+`Z`(または Ctrl+`Y`)でやり直し。ドラッグや「自由配置にする」の編集をプレビューから戻せる
- ソースからスライドへ: 各 `\begin{frame}` の上の CodeLens「プレビューで表示」、または `Cmd/Ctrl+K V`(Beamer Editor: Reveal Current Slide in Preview)でカーソルのあるフレームを表示。ソースのカーソル移動にプレビューを追従させる設定(`beamerEditor.preview.followCursor`、既定 ON)はプレビュータブのボタンで切り替え
- Explorer の **Beamer Slides** には、現在の managed slide のフレーム一覧を表示。項目を選ぶと対応するソースへ移動する。View は VS Code の標準機能で Side Bar、Secondary Side Bar、Panel の任意の場所へ移動できる
- プレビューのスライド一覧では、キャプションを右クリック（またはカードにフォーカスして Shift+F10 / Context Menu キー）すると順序メニューを開き、スライドを上下へ移動できる
- プレビューのエディタグループは、プレビューが初めてフォーカスされたときにロックされ、他のファイルはソース側のグループに開きます(`beamerEditor.preview.lockGroup` で無効化可)

## 開発版のインストール

```bash
pnpm --dir apps/vscode package   # beamer-editor.vsix を生成
code --install-extension apps/vscode/beamer-editor.vsix
```

外部プロセス(AI エージェントや CLI)がファイルを書き換えた場合、未編集のバッファは自動で追従します。編集中(dirty)のバッファは上書きされず、競合の扱いは VS Code 標準に従います。

## Managed files と LaTeX Workshop

既定の managed pattern は `beamerEditor.managedFiles` の `**/*.slide.tex` です。pattern は文書が属する workspace folder からの相対パスとして解釈される VS Code glob なので、brace や character class なども VS Code の glob 規則に従います。たとえば `slides/**/*.tex` を管理したい場合は、VS Code の resource settings で次のように変更できます。

```json
{
  "beamerEditor.managedFiles": ["slides/**/*.tex"]
}
```

managed 文書をアクティブなエディタで開くと、自動プレビューと lint を行います。通常のローカル `.tex` は自動処理の対象外ですが、**Open Preview** コマンドで手動プレビューできます。プレビューは URI ごとに最大一つで、別の managed 文書は同時に表示できます。

LaTeX Workshop が入っている環境で managed file を初めて開くと、Beamer Editor は自動監視と保存時自動ビルドの ignore リストへ managed patterns を追加するか確認します。書込先は managedFiles と各 Workshop 設定のうち、より具体的な scope (Workspace Folder / Workspace / Global) です。明示的に確認した場合だけ追加され、通常の `.tex` の既定自動ビルド設定は変わりません。「今後表示しない」は同じ workspace scope と managed pattern の組合せに対して永続化されます。managed `.slide.tex` でも language id は `latex` のままなので、LaTeX Workshop の手動 **Build LaTeX project** による PDF build は引き続き利用できます。

## テンプレート(.sty と画像)

会社・組織の Beamer テーマは、そのままデッキのディレクトリ配下に置いて読めます。デッキと同じディレクトリに `beamertheme<Name>.sty` と画像を置いて `%% preamble-extra` に `\usetheme{Name}` を書くか、`templates/<name>/` に一式を置いて `\usepackage{templates/<name>/beamertheme<name>}` を書きます。`.sty` 内の画像パスはデッキのディレクトリ基準です(`templates/<name>/assets/logo.png` など)。

プレビューには `.sty` の `\definecolor` / `\setbeamercolor`(structure・alerted text・example text・normal text・background canvas)、`\setsansfont` / `\setmonofont`、`\logo`、`\usebackgroundtemplate` から取れる色・フォント・ロゴ・背景だけが近似で反映されます(`\addtobeamertemplate{background}`・`\graphicspath`・単純な `\newcommand` の画像パスも読みます)。`%% style` の `\deckbackground{path}` / `\deckbackground[title]{path}` で全スライド / 表紙だけの背景を指定でき(この機能より前に作ったデッキはツール管理プリアンブルに定義が無いため L025 のエラーになり、Quick Fix または `deck init <file> --update-preamble` で管理プリアンブルを最新に差し替えます)、背景指定を `%% preamble-extra` と `%% style` の外(ツール管理プリアンブルの中を含む)に書くと PDF にだけ効くため L024 の警告が出ます。画像のパスはデッキのディレクトリ基準で拡張子まで書きます(`assets/bg.png`)。拡張子の省略や `\graphicspath` は PDF では通りますがプレビューが解決しないため、本文・`%% style` のパスは L004 になり、TeX が拾うファイルが分かるときは Quick Fix で正しいパスへ直せます。それ以外の様式は PDF にだけ効きます。`.sty` や画像を変更するとプレビューと診断は自動で更新されます。参照先の `.sty` や画像が無い場合は Problems パネルに L022 / L023 が出ます。見本は `fixtures/templates/corporate/` と `fixtures/templated.slide.tex` です。

## 生ブロックの部分コンパイル

TikZ などサブセット外のブロックは、プレビューではまず環境名だけの箱(プレースホルダ)で場所を確保し、裏で Tectonic により standalone 文書としてコンパイルして、できた画像を箱に差し込みます。結果は内容とプリアンブル(preamble-extra とマクロ定義)のハッシュでキャッシュされるので、変えていないブロックは再コンパイルされません。キャッシュはデッキのディレクトリごとに分かれ、ブロックが参照する画像や .sty(`\graphicspath` の下も含む)が更新されると作り直します。Tectonic が見つからないときは箱をそのまま残して通知を 1 回出し、「設定を開く」から `beamerEditor.tectonicPath` を直せばプレビューを開き直さずに再試行します。失敗したブロックは赤い枠の箱として残り、ホバーで Tectonic のエラーを確認できます(生成 PDF が 8 MB を超えるものや、極端に大きなページも箱のまま失敗扱いになります)。Tectonic の場所は `beamerEditor.tectonicPath`、無効にするには `beamerEditor.preview.compileRawBlocks` を false にします。Restricted Mode では動きません。

KaTeX が描画できない数式も、独立して組版できる場合は画像で補います。インライン数式は TeX の箱の寸法とベースラインを取得できた場合に差し込みます。組版できなかった箇所や文書全体の文脈が必要な箇所には **PDF確認** へのボタンが付きます。`deckfigure` は画像への差し込み後も移動と幅変更ができます。

## 画像の貼り付け

managed な `.tex` エディターで、クリップボードの画像(PNG / JPEG)を Cmd/Ctrl+V で貼り付けると、デッキと同じディレクトリの `assets/` に `image.png`(既にあれば `image-1.png`、…)として保存し、カーソル位置に `\includegraphics` を挿入します。カーソルが `deckcanvas` の中なら `\deckimage` になります。`decktext` などアイテムの中にカーソルがあるときは、そのアイテムの直後に入ります。保存と挿入は 1 回の undo で戻ります。

フレーム本文の外(プリアンブル・フレームの間・フレームの見出し)と、解釈できないフレーム(raw frame)の `deckcanvas` の中では貼り付けず、通常のテキストの貼り付けに任せます。テキストと画像を同時にコピーしたときも、既定はテキストの貼り付けです(画像として貼るには **Paste As...** から選びます)。ただし、テキストが http(s) の URL 1 つだけのとき(Safari などで Web の画像をコピーしたとき)は画像を貼り付けます。

## PDF 書き出し

プレビュー上部の **編集** と **PDF確認** で表示を切り替えられます。既定の **編集** は未保存の入力を即時に反映する HTML プレビューです。**PDF確認** を初めて開くと、保存済みのデッキ全体を Tectonic で組版します。再組版するには **更新** を押します。未保存の編集がある間は、表示中の PDF が保存済みの版であることを示します。本文を保存したときや、監視対象の画像・`.sty`、Tectonic の設定が変わったときは「要更新」と表示します。デッキのフォルダーへ PDF を初めて保存・書き出ししたときも、条件付きの TeX 参照で次回の組版が変わる可能性があるため「要更新」と表示します。監視範囲外の参照ファイルを変えた場合も **更新** で読み直せます。組版に失敗すると、最後に成功した PDF が残ります。Restricted Mode では PDF確認に利用不可と表示します。

PDF確認は物理ページ単位で前後のページへ移動します。PDF.js の文書とワーカーを再利用し、表示中の 1 ページだけを描画します。確認タブは 64 MiB までの PDF を表示します。上限を超えた場合は前回表示した PDF を残し、通常の書き出しから確認できることを案内します。**表示中の PDF を保存** は、その時点で表示している組版済みファイルを再組版せずに保存するため、保存先の PDF は表示元とバイト単位で一致します。通常の **Beamer Editor: Export...** での PDF 書き出しは編集中の内容を先に保存して組版し、対応する PDF確認で成果物を表示します。書き出し中に PDF確認を開いた場合は、進行中の組版を待ちます。

PDF と同じ組版の SyncTeX で選択中のフレームのページを確認できた場合は、編集タブに **このフレームを PDF で表示** が現れます。対応する物理ページが複数ある場合は、ボタンの隣でページを選べます。対応情報がないときやソースの版が変わったときも、PDF確認タブの前後ページ移動を使えます。

編集タブは画像の読み込み失敗、表示範囲からのはみ出し、編集対象の欠落をブラウザーで検査し、現在の文書と参照ファイルに対応する診断を Problems に表示します。

コマンドパレット、`.tex` エディター、または対応するプレビューのタイトルから **Beamer Editor: Export...** を実行すると、保存先を選んで PDF を書き出せます。コンパイルには [Tectonic](https://tectonic-typesetting.github.io/) を使います。Tectonic は拡張に同梱されているので(macOS arm64 / x86_64、Linux x64 / arm64、Windows x64)、別途インストールする必要はありません。初回のコンパイル時に TeX のパッケージを Tectonic が必要な分だけダウンロードします(数分かかることがあり、進み具合は書き出し中の通知に表示されます)。対象外の環境や別の版を使いたいときは `beamerEditor.tectonicPath` で実行ファイルを指定してください(同梱の無い環境では PATH の `tectonic` を使います)。

編集中の内容は先に保存され、コンパイルは既定で300秒後に停止します（`beamerEditor.pdfExport.timeoutSeconds` で5〜1800秒に変更可。初回のパッケージ取得中は取得のたびに計測をやり直します）。失敗時は通知の「詳細を表示」からTectonicのエラーを確認できます。TeX のコンパイルエラーで失敗したデッキに lint のエラーがあると(Tectonic の起動の失敗やタイムアウトには添えません)、原因の手がかりとして、通知にその件数と先頭 1 件(例: `L025: ツール管理プリアンブルが…`)が、「詳細を表示」には全件(`行:列 コード メッセージ`)が入ります。lint するのは書き出し時に保存した内容で、コンパイル中の編集は混ざりません。managed file では「問題を表示」で Problems パネルを開けます(コンパイルの間に文書を編集したときは、Problems パネルの診断が通知と合わないため出ません)。既存PDFはコンパイルが成功するまで置換されません。PDF は外部プログラムを起動するため、Restricted Modeでは形式選択後に実行を拒否します。

Export の形式で **HTML（プレビュー相当）** を選ぶと、保存済みの内容から `index.html` を含むフォルダーを作成します。これは `file:` で直接開ける高速プレビューの固定スナップショットであり、正式な TeX 出力ではありません。PDF 画像と raw TeX はプレースホルダーのまま、外部 URL の画像は開いたブラウザーでネットワークを必要とします。HTML は外部プロセスを使わないため Restricted Mode でも利用できます。

このリポジトリで LaTeX Workshop を併用する場合の、混在 workspace と専用 workspace の設定方針は[エディタセットアップ](https://github.com/ebi-oishii/beamer-editor/blob/main/docs/editor-setup.md)を参照してください。

### スライド一覧からの編集

Beamer Slides の項目を右クリックすると、Move Slide Up / Down、Duplicate Slide、Delete Slide、Insert New Slide を使えます。挿入は選択スライドの直後、一覧タイトルの「+」からは末尾です。空のデッキにも挿入できます。各操作は1回のundoで戻り、プレビューとソースへ反映されます。

移動時は直前の連続したコメント行と末尾の行コメントも一緒に移動します。sectionやフレーム間のその他のTeXはその位置に保持するため、section境界を越える移動では所属するsectionが変わります。複製はframe labelを未使用の `slide-N` に変更します。本文に `\label`・`\hypertarget`・`\newcounter` など文書内で一意な定義(それを生成するマクロを含む)や安全に解釈できないframeオプションがある場合は、参照先やコンパイルを壊さないため複製を拒否し、ソース上での編集を案内します。マクロが生成した仮想フレームは一覧操作の対象外です。
