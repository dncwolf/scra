# scra

DuckDuckGoによるWeb検索と[Readability.js](https://github.com/mozilla/readability)によるWebフェッチを行うミニマムなMCPサーバー

## Usage

```bash
git clone https://github.com/dncwolf/scra.git
cd scra && bun install
```

LMStudioなどでの設定:

```json
{
  "mcpServers": {
    "scra": {
      "command": "bun",
      "args": ["run", "/path/to/scra/index.ts"]
    }
  }
}
```

## Tools

| ツール | 説明 |
|---|---|
| `search` | キーワードでDuckDuckGoを検索し、タイトル・URL・スニペットを番号付きで返す |
| `fetch` | URLを指定してページ本文をMarkdown形式（`# タイトル` + 本文）で返す。SPA対応 |

挙動の詳細は後述の [Spec](#spec) を参照。

## Spec

### `search`

| 項目 | 仕様 |
|---|---|
| 入力 | `query: string`, `limit: int`（1〜20、デフォルト5。範囲外はスキーマ違反エラー） |
| 出力 | 1件ごとに `N. {title}\n   URL: {url}\n   {snippet}`（スニペットなしは省略）を空行区切り。0件時は「検索結果が見つかりませんでした。」 |
| 取得先 | `https://html.duckduckgo.com/html/?q={query}` |
| 解析 | ページ内で `.result:not(.result--ad)` を走査。URLは `uddg` パラメータの復元、なければ直リンクhrefをそのまま採用。URLを持たない要素・パース不能な要素は黙って除外 |
| エラー | HTTP非2xx（レート制限など）・ナビゲーション失敗は `isError: true` + `search エラー: {理由}` |

### `fetch`

| 項目 | 仕様 |
|---|---|
| 入力 | `url: string`（URL形式。違反はスキーマ違反エラー） |
| 出力 | `# {title}\n\n{本文}`。本文は各行trim → 3連以上の改行を2連へ圧縮 → 50,000文字超過分を切り捨て注記を付加（ページからの転送自体も200,000文字で上限） |
| 描画 | `domcontentloaded` 後、network idle（500ms静止）を最大2秒ベストエフォート待機。Readabilityをページ内へ注入して抽出（CSPはバイパス） |
| エラー | スキーマ違反 / SSRF拒否 / HTTPエラー / Readability抽出失敗 / リダイレクト遮断による到達失敗 / 20秒タイムアウト |

## License

WTFPL
