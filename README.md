# scra

DuckDuckGoによるWeb検索と[Readability.js](https://github.com/mozilla/readability)を使ったWebフェッチを行うミニマムなMCPサーバー

## Usage
```bash
git clone https://github.com/rxon/scra.git
bun install
```

LMStudioなどでの設定

```json
{
  "mcpServers": {
    "scra": {
      "command": "bun",
      "args": [
        "run",
        "/path/to/scra/index.ts"
      ]
    }
  }
}
```

## Tools
- `search` キーワードでDuckDuckGoを検索し、タイトル・URL・スニペットを番号付きで返す。 
- `fetch` URLを指定してページ本文をMarkdown形式（# タイトル + 本文）で返す。Readabilityをページ内で実行して抽出し、本文は最大50,000文字で切り詰められる。

どちらも一時的なネットワークエラー・ブラウザクラッシュ時は1回だけ自動リトライする。ブラウザはアイドル5分で自動終了し、次のリクエストで再起動する。

## SSRF対策
ページが発行するサブリソース・リダイレクトを含む全リクエストをインターセプトし、以下を遮断する:
- `http(s)` 以外のスキーム（`file://` など。サブリソースの `data:`/`blob:` は許可）
- プライベート・予約IPv4帯（ループバック・10/8・172.16/12・192.168/16・リンクローカル 169.254/16・CGN 100.64/10・0/8）。10進・短縮表記も正規化のうえ判定
- プライベートIPv6（`::1`・ULA `fc00::/7`・リンクローカル `fe80::/10`・IPv4-mapped・NAT64 `64:ff9b::/96`）
- `localhost` とそのサブドメイン
- プライベートIPに解決されるホスト名（DNS解決によるリベンディング対策）

## 環境変数
- `SCRA_DEBUG=1` — stderrへ動作ログ（起動・リトライ・遮断したリクエスト）を出力
- `SCRA_IDLE_TIMEOUT_MS` — アイドル時にブラウザを閉じるまでの時間（デフォルト300,000 = 5分）

## テスト
```bash
bun test                                  # 全テスト（ユニット + stdio E2E + 統合）
SKIP_INTEGRATION=1 bun test               # 実ネットワークを使う統合テストを除外
SKIP_INTEGRATION=1 SKIP_E2E=1 bun test    # ユニットのみ
```
- `index.test.ts` — ユニット（puppeteer/DNSをモック、抽出関数はJSDOM環境で実行）+ InMemoryTransport経由のMCPテスト
- `index.e2e.test.ts` — 実プロセスを起動してstdioでMCP対話・切断時の終了を検証
- `index.pbt.test.ts` — `validateUrl` のプロパティベーステスト
- `index.integration.test.ts` — 実DuckDuckGo・実Chromiumでの統合テスト

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

### SSRF検証順序
1. `validateUrl` — スキーム（`http`/`https` のみ）→ ホスト文字列判定（WHATWG正規化済みIP・`localhost` とそのサブドメイン）
2. DNS事前解決 — リテラルIP以外のホスト名を解決し、プライベートIPを含めば拒否（解決失敗はフェイルオープンでナビゲーションのエラーに任せる）
3. リクエストインターセプト — サブリソース・リダイレクトを含む全リクエストに 1〜2 と同じ判定を適用して遮断（`data:`/`blob:`/`about:` は許可）
4. 最終URL再検証 — `goto` 完了後のURLにも `validateUrl` を適用

### 信頼性・ライフサイクル
- 一時的エラー（接続リセット系 `net::ERR_*`・`ECONNRESET`・`Target closed`・`Session closed`）は処理全体を1回だけ再実行
- ブラウザはシングルトン。クラッシュ・切断後は次のリクエストで自動再起動し、アイドル5分（`SCRA_IDLE_TIMEOUT_MS`）で自動終了
- SIGINT / SIGTERM / stdin EOF / トランスポート切断のいずれでもブラウザを閉じて終了コード0で終了

### 定数
| 定数 | 値 |
|---|---|
| `TIMEOUT_SEARCH` | 30秒 |
| `TIMEOUT_FETCH` | 20秒 |
| `NETWORK_IDLE_TIMEOUT` | 2秒 |
| `MAX_BODY_CHARS` | 50,000文字 |
| `MAX_TRANSFER_CHARS` | 200,000文字 |
| `BROWSER_IDLE_TIMEOUT` | 5分 |

## License
WTFPL