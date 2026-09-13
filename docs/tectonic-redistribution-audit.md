# Tectonic 0.17.0 の再配布監査（未完了）

確認日: 2026-09-13。対象は PR #131 の `tectonic.json` に固定された公式バイナリ。
この文書は調査結果と未解決事項であり、再配布の承認や法的適合性の証明ではない。

## 確認済みの事実

- [タグ `tectonic@0.17.0`](https://github.com/tectonic-typesetting/tectonic/releases/tag/tectonic%400.17.0) はコミット `8c0126a9653239a2e6e0a5274af9b8510f643030` を指す。
- macOS arm64、Linux x64 musl、Windows x64 MSVC の3アーカイブを実際に取得し、PR の SHA-256 と一致することを確認した。いずれも内容は `tectonic` または `tectonic.exe` 一つで、ライセンス文書は含まれていなかった。残り2アーカイブの内容検査は未実施。
- [ルートの LICENSE](https://github.com/tectonic-typesetting/tectonic/blob/8c0126a9653239a2e6e0a5274af9b8510f643030/LICENSE) は MIT だが、由来するコードに別ライセンスがあると明記している。「Tectonic は MIT なので再配布に問題なし」という判断では不十分。
- [(x)dvipdfmx](https://github.com/tectonic-typesetting/tectonic/blob/8c0126a9653239a2e6e0a5274af9b8510f643030/crates/engine_xdvipdfmx/xdvipdfmx/dvipdfmx.c) と PDF I/O の C ソースは GPL-2.0-or-later を明記している。Cargo のパッケージ属性が MIT でも、これらの原文を無視できない。上流の [Discussion #1271](https://github.com/tectonic-typesetting/tectonic/discussions/1271) でもこの区別と解釈上の不確実性が説明されている。
- [TECkit のソース](https://github.com/tectonic-typesetting/tectonic/blob/8c0126a9653239a2e6e0a5274af9b8510f643030/crates/engine_xetex/xetex/teckit-Engine.cpp) は CPL または LGPL を指定している。[build.rs](https://github.com/tectonic-typesetting/tectonic/blob/8c0126a9653239a2e6e0a5274af9b8510f643030/crates/engine_xetex/build.rs) から、単なる未使用ファイルではなくビルド対象であることも確認した。
- `cargo metadata --locked --format-version 1` を上記コミットで実行し、451パッケージ（うち crates.io 由来425件）のメタデータとソースを取得した。これは全ワークスペース・全プラットフォームを含む候補集合であり、各配布バイナリに451件が含まれるという意味ではない。取得した crates.io のソースアーカイブは合計72,672,695バイト。ネイティブ依存やビルド環境はこの値に含まない。
- Cargo に宣言されたライセンスだけでは、同梱 C/C++ コードの監査は完結しない。425件中15件は配布 crate 内に独立した LICENSE/COPYING/NOTICE 等が見当たらず、上流ソースとの追加照合が必要。

## ネイティブ依存の出所

macOS と Windows MSVC の公式配布ビルドは、上流の
[Cargo.toml](https://github.com/tectonic-typesetting/tectonic/blob/8c0126a9653239a2e6e0a5274af9b8510f643030/Cargo.toml) と
[CI](https://github.com/tectonic-typesetting/tectonic/blob/8c0126a9653239a2e6e0a5274af9b8510f643030/.github/workflows/build_and_test.yml) により、
vcpkg のコミット `a62ce77d56ee07513b4b67de1ec2daeaebfae51a` を使用する。
以下はその port メタデータであり、全てが全ターゲットに静的リンクされると確定した一覧ではない。

| port | 固定された版 | port の license 属性 |
|---|---|---|
| fontconfig | 2.15.0 | MIT |
| freetype | 2.13.3 | FTL OR GPL-2.0-or-later |
| harfbuzz | 11.3.3 | MIT-Modern-Variant |
| icu | 74.2 | ICU |
| graphite2 | 1.3.14 | 未記載 |
| libpng | 1.6.50 | libpng-2.0 |
| zlib | 1.3.1 | Zlib |
| brotli | 1.1.0 | MIT |
| bzip2 | 1.0.8 | bzip2-1.0.6 |
| expat | 2.7.3 | MIT |
| dirent | 1.26 | MIT |
| libiconv | 1.18 | 未記載 |

取得元は [固定 vcpkg tree の ports](https://github.com/microsoft/vcpkg/tree/a62ce77d56ee07513b4b67de1ec2daeaebfae51a/ports)。
ビルドに含まれる HarfBuzz サブモジュールのコミットは
`894a1f72ee93a1fd8dc1d9218cb3fd8f048be29a`。
macOS arm64 バイナリを `otool -L` で確認したところ、Apple framework と `/usr/lib` のシステムライブラリだけが動的依存として表示された。

Linux musl ビルドは [Cross.toml](https://github.com/tectonic-typesetting/tectonic/blob/8c0126a9653239a2e6e0a5274af9b8510f643030/Cross.toml) の `tectonictypesetting/crossbuild:<target>` を使うが、image digest は固定されていない。
[上流の構築スクリプト](https://github.com/tectonic-typesetting/tectonic-ci-support/blob/51168d5b19a7e1d70a4b7f68b11100c2f4f8da4f/cross-images/03_alpine_populate.sh) では Alpine の静的ライブラリを取得する。
公開スクリプトだけから、0.17.0 の実バイナリに使われた全ライブラリの正確な版を確定することはできていない。

## 今回収録したものと残作業

`apps/vscode/third-party/tectonic/` に、原文の MIT LICENSE、確認済みエンジンソースの著作権・ライセンス通知、GPL 2.0 と LGPL 2.1 の全文を保存した。
この追加だけでは2件目のレビュー指摘を解決済みにしない。

残作業は、Rust・ネイティブ依存の通知原文の照合、正確な対応ソースとビルド用パッチの確保、ソース提供方法の確定、配布物との対応確認である。
[GNU の FAQ](https://www.gnu.org/licenses/gpl-faq.en.html#SourceAndBinaryOnDifferentSites) は、ソースを上流のサイトへ案内するだけで常に足りるとはしていない。GPL の版と提供方法によって条件が異なるため、URL の追加だけを完了条件にしない。
3年間の書面によるソース提供申し出を、管理者に代わって無断で約束しない。

## 配布方法の比較（提案・未承認）

| 案 | 利用者への影響 | 管理者の作業・制約 |
|---|---|---|
| 同梱を維持し、対応ソースを同じ GitHub Release で配布（推奨） | 追加インストール不要。VSIX自体へ全ソースを入れる必要はない | 版ごとにソース・パッチ・通知を対応付けて保持する。現在は全ソースの特定が未完了で、総容量も未確定 |
| 上流から初回に直接取得 | 初回のネットワーク失敗でコンパイルできない | ダウンロード・検証・キャッシュ・更新・失敗時の処理が新たに必要。配布経路を変えても条件の確認は必要 |
| 同梱せず利用者が手動インストール | 利用者の設定作業が増え、「TeX環境のない利用者にインストールさせない」というPRの目的を満たさない | 新しい配布の仕組みは不要だが、導入時の支援が必要 |

既存の GitHub を使う推奨案には、新しいサービス契約やアカウント登録は不要。
[GitHub Releases](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases) は各assetが2 GiB未満で、release全体の容量・帯域使用量に制限がない。
当リポジトリは公開で、[標準の GitHub-hosted runner](https://docs.github.com/en/actions/reference/runners/github-hosted-runners) は無料。
Git LFS、有料runner、外部ストレージの採用は提案していない。
この案を採用しても、ソースの特定・保持・版更新時の再確認という運用負担は残る。

配布管理の変更について人間の承認を得てから実装する。現時点では Releases の作成や配布方法の変更は行っていない。
