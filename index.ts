import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import puppeteer, { type Browser, type Page } from 'puppeteer'
import { z } from 'zod'

// ── Constants ────────────────────────────────────────────────────────────────

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const TIMEOUT_SEARCH = 30_000
const TIMEOUT_FETCH = 20_000
const NETWORK_IDLE_TIMEOUT = 2_000
const SEARCH_RESULT_SELECTOR = '[data-testid="result"]'
// SERP本体（React）が描画済みかの判定に使う。結果0件でもこれは描画される
const SEARCH_PAGE_READY_SELECTOR = '[data-testid="web-vertical"]'
const SEARCH_RESULT_TIMEOUT = 12_000
const MAX_BODY_CHARS = 10_000 // 32Kコンテキストのローカルモデルで2〜3ページ分を読める長さ（日本語は概ね1文字≒1トークン）
const MAX_TRANSFER_CHARS = MAX_BODY_CHARS * 4 // 空白正規化前のマージン込みでページから転送する上限
const BROWSER_IDLE_TIMEOUT = 5 * 60_000

const READABILITY_SRC = await Bun.file(
  Bun.resolveSync('@mozilla/readability/Readability.js', import.meta.dir),
).text()

// ── Logging ──────────────────────────────────────────────────────────────────

// stdioトランスポートがstdoutを使うため、ログはstderrのみ
const log = (...args: unknown[]) => {
  if (process.env.SCRA_DEBUG) console.error('[scra]', ...args)
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e))

// ── SSRF guard ───────────────────────────────────────────────────────────────

const PRIVATE_HOSTS = new Set(['localhost'])

// WHATWG URLパーサーがIPv4を10進・8進・16進・短縮表記からドット表記へ正規化する前提
const PRIVATE_IPV4_PATTERNS = [
  /^0\./, // 0.0.0.0/8（未指定）
  /^10\./, // 10.0.0.0/8
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, // 100.64.0.0/10（CGN）
  /^127\./, // ループバック
  /^169\.254\./, // リンクローカル・クラウドメタデータ
  /^172\.(1[6-9]|2\d|3[01])\./, // 172.16.0.0/12
  /^192\.168\./, // 192.168.0.0/16
]

// 16ビット×8グループへ展開（'::' 圧縮と末尾IPv4ドット表記に対応）。パース不能は null
export function expandIPv6(ip: string): number[] | null {
  let s = ip
  const v4 = /^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s)
  if (v4) {
    const parts = v4[2]!.split('.').map(Number)
    if (parts.some(n => n > 255)) return null
    s = `${v4[1]}${((parts[0]! << 8) | parts[1]!).toString(16)}:${((parts[2]! << 8) | parts[3]!).toString(16)}`
  }
  const sections = s.split('::')
  if (sections.length > 2) return null
  const head = sections[0] ? sections[0].split(':') : []
  const tail = sections.length === 2 && sections[1] ? sections[1].split(':') : []
  if (sections.length === 1 && head.length !== 8) return null
  const fill = 8 - head.length - tail.length
  if (sections.length === 2 && fill < 1) return null
  const groups = [...head, ...Array(sections.length === 2 ? fill : 0).fill('0'), ...tail]
  const nums = groups.map(g => (/^[0-9a-f]{1,4}$/i.test(g) ? parseInt(g, 16) : NaN))
  return nums.length === 8 && !nums.some(Number.isNaN) ? nums : null
}

function isPrivateIPv6(addr: string): boolean {
  const g = expandIPv6(addr)
  if (!g) return true // isIPが6と判定したのにパース不能 → 安全側で拒否
  const head = g[0]!
  if (g.every(x => x === 0)) return true // ::（未指定）
  if (g.slice(0, 7).every(x => x === 0) && g[7] === 1) return true // ::1
  if ((head & 0xfe00) === 0xfc00) return true // fc00::/7（ULA）
  if ((head & 0xffc0) === 0xfe80) return true // fe80::/10（リンクローカル）
  const mapped = g.slice(0, 5).every(x => x === 0) && g[5] === 0xffff // ::ffff:0:0/96（IPv4-mapped）
  const nat64 = head === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every(x => x === 0) // 64:ff9b::/96（NAT64）
  if (mapped || nat64) {
    return isPrivateIp(`${g[6]! >> 8}.${g[6]! & 0xff}.${g[7]! >> 8}.${g[7]! & 0xff}`)
  }
  return false
}

function isPrivateIp(addr: string): boolean {
  switch (isIP(addr)) {
    case 4:
      return PRIVATE_IPV4_PATTERNS.some(re => re.test(addr))
    case 6:
      return isPrivateIPv6(addr)
    default:
      return false
  }
}

function hostIsPrivate(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '')
  return PRIVATE_HOSTS.has(host) || host.endsWith('.localhost') || isPrivateIp(host)
}

export function validateUrl(url: string): void {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(`無効なURL: ${url}`)
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`許可されていないスキーム: ${parsed.protocol}`)
  }
  if (hostIsPrivate(parsed.hostname)) {
    throw new Error(`プライベートIPへのアクセスは拒否されました: ${parsed.hostname}`)
  }
}

// 1ページの読み込みは同一ホストへ大量のサブリソース要求を伴うため、判定を短TTLでキャッシュする。
// Promiseを保持することで同時要求時の重複lookupも防ぐ
const DNS_VERDICT_TTL = 30_000
const DNS_VERDICT_CACHE_MAX = 1_000
const dnsVerdicts = new Map<string, { expires: number; privateAddr: Promise<string | null> }>()

// テストが判定順序に依存しないよう、キャッシュをリセットする（テスト専用）
export function resetDnsCache(): void {
  dnsVerdicts.clear()
}

async function assertPublicDns(hostname: string): Promise<void> {
  const host = hostname.replace(/^\[|\]$/g, '')
  if (isIP(host)) return // リテラルIPは validateUrl で検証済み
  let entry = dnsVerdicts.get(host)
  if (!entry || entry.expires <= Date.now()) {
    if (dnsVerdicts.size >= DNS_VERDICT_CACHE_MAX) dnsVerdicts.clear() // ponytail: 上限超過は全クリア。LRUが要るほど増えない想定
    entry = {
      expires: Date.now() + DNS_VERDICT_TTL,
      privateAddr: lookup(host, { all: true })
        .catch(() => []) // 解決失敗はナビゲーション側のエラーに任せる
        .then(addrs => addrs.find(a => isPrivateIp(a.address))?.address ?? null),
    }
    dnsVerdicts.set(host, entry)
  }
  const hit = await entry.privateAddr
  if (hit) throw new Error(`プライベートIPに解決されるホストは拒否されました: ${host} → ${hit}`)
}

// サブリソースで一般的かつ無害なスキームは素通しする
const SAFE_SUBRESOURCE_PROTOCOLS = new Set(['data:', 'blob:', 'about:'])

export async function requestBlockReason(url: string): Promise<string | null> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return '無効なURL'
  }
  if (SAFE_SUBRESOURCE_PROTOCOLS.has(parsed.protocol)) return null
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return `許可されていないスキーム: ${parsed.protocol}`
  }
  if (hostIsPrivate(parsed.hostname)) return `プライベートIP: ${parsed.hostname}`
  return assertPublicDns(parsed.hostname).then(() => null, e => errMsg(e))
}

// ── Browser singleton ────────────────────────────────────────────────────────

let browser: Browser | null = null
let browserPromise: Promise<Browser> | null = null
let idleTimer: ReturnType<typeof setTimeout> | null = null
let activePages = 0

export async function getBrowser(): Promise<Browser> {
  if (browser?.connected) return browser
  browser = null
  browserPromise ??= puppeteer.launch({ headless: true })
    .then(b => {
      log('Chromiumを起動しました')
      browser = b
      b.on('disconnected', () => { browser = null })
      return b
    })
    .finally(() => { browserPromise = null })
  return browserPromise
}

export function resetBrowser(): void {
  browser = null
  browserPromise = null
  if (idleTimer) {
    clearTimeout(idleTimer)
    idleTimer = null
  }
}

function scheduleIdleClose() {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = setTimeout(() => {
    idleTimer = null
    if (activePages === 0 && browser) {
      log('アイドルのためブラウザを終了します')
      void browser.close().catch(() => {})
      browser = null
    }
  }, Number(process.env.SCRA_IDLE_TIMEOUT_MS) || BROWSER_IDLE_TIMEOUT)
  idleTimer.unref?.()
}

async function shutdown() {
  await browser?.close().catch(() => {})
  process.exit(0)
}
process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)

// ── Page helpers ─────────────────────────────────────────────────────────────

const TRANSIENT_ERROR_RE =
  /net::ERR_(CONNECTION_RESET|CONNECTION_CLOSED|EMPTY_RESPONSE|NETWORK_CHANGED)|ECONNRESET|Target closed|Session closed/

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (e) {
    if (!TRANSIENT_ERROR_RE.test(errMsg(e))) throw e
    log('一時的エラーのためリトライします:', errMsg(e))
    return fn()
  }
}

// 検索もフェッチもテキストとリンクしか使わないため、重量サブリソースは取得しない
const SKIPPED_RESOURCE_TYPES = new Set(['image', 'font', 'media'])

// サブリソースやリダイレクトを含む全リクエストをSSRF検証する
async function guardPage(page: Page) {
  await page.setRequestInterception(true)
  page.on('request', async (req) => {
    try {
      if (SKIPPED_RESOURCE_TYPES.has(req.resourceType())) {
        await req.abort('blockedbyclient')
        return
      }
      const reason = await requestBlockReason(req.url())
      if (reason) {
        log('リクエストを遮断:', req.url(), '-', reason)
        await req.abort('blockedbyclient')
      } else {
        await req.continue()
      }
    } catch {
      await req.abort('failed').catch(() => {})
    }
  })
}

async function withPage<T>(timeout: number, fn: (page: Page) => Promise<T>): Promise<T> {
  if (idleTimer) clearTimeout(idleTimer)
  activePages++
  try {
    const page = await (await getBrowser()).newPage()
    try {
      page.setDefaultTimeout(timeout)
      page.setDefaultNavigationTimeout(timeout)
      await page.setUserAgent({ userAgent: UA })
      await guardPage(page)
      return await fn(page)
    } finally {
      await page.close().catch(() => {})
    }
  } finally {
    if (--activePages === 0) scheduleIdleClose()
  }
}

// ── In-page extractors（puppeteerがシリアライズしてページ内で実行する） ──────

function extractSearchResults(selector: string, limit: number) {
  return [...document.querySelectorAll(selector)]
    .flatMap(el => {
      const a = el.querySelector<HTMLAnchorElement>('[data-testid="result-title-a"]')
      if (!a?.href) return []
      try {
        const parsed = new URL(a.href)
        if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return []
        // DDG自身へのリンクはリダイレクトラッパー（/l/?uddg=）の復元のみ許可。
        // /y.js（スポンサー枠）やDDG内部リンクはここで落ちる
        const isDdg = /(^|\.)duckduckgo\.com$/.test(parsed.hostname)
        const url = isDdg ? parsed.searchParams.get('uddg') : a.href
        if (!url) return []
        return [{
          title: a.textContent?.trim() ?? '',
          url,
          snippet: el.querySelector('[data-result="snippet"]')?.textContent?.trim() ?? '',
        }]
      } catch {
        return []
      }
    })
    .slice(0, limit)
}

function extractArticleInPage(maxChars: number) {
  const doc = document.cloneNode(true) as Document
  const article = new (globalThis as any).Readability(doc).parse()
  if (!article) return null
  const content = String(article.textContent ?? '')
  return {
    title: String(article.title ?? ''),
    textContent: content.slice(0, maxChars),
    clipped: content.length > maxChars,
  }
}

export function formatArticle(
  article: { title: string; textContent: string; clipped: boolean } | null,
  url: string,
): string {
  if (!article) throw new Error(`ページを読み取れませんでした: ${url}`)
  const body = article.textContent
    .split('\n')
    .map(l => l.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  const clipped = article.clipped || body.length > MAX_BODY_CHARS
  const sliced = body.slice(0, MAX_BODY_CHARS)
  return `# ${article.title}\n\n${clipped ? `${sliced}\n\n…（本文が長いため切り詰められました）` : sliced}`
}

// ── Tools ────────────────────────────────────────────────────────────────────

const text = (content: string) => ({ content: [{ type: 'text' as const, text: content }] })
const errorText = (msg: string) => ({ content: [{ type: 'text' as const, text: msg }], isError: true as const })

export const server = new McpServer({ name: 'scra', version: '0.0.1' })

server.registerTool(
  'search',
  {
    description:
      'キーワードでDuckDuckGoを検索し、タイトル・URL・スニペットを番号付きで返す。' +
      '最大20件取得可能（デフォルト5件）。ページ本文が必要な場合は fetch ツールを使うこと。',
    inputSchema: {
      query: z.string().describe('検索クエリ'),
      limit: z.number().int().min(1).max(20).default(5).describe('取得件数（1〜20、デフォルト5）'),
    },
  },
  async ({ query, limit }) => {
    try {
      const results = await search(query, limit)
      if (results.length === 0) return text('検索結果が見つかりませんでした。')
      const lines = results.map((r, i) =>
        `${i + 1}. ${r.title}\n   URL: ${r.url}${r.snippet ? `\n   ${r.snippet}` : ''}`,
      )
      return text(lines.join('\n\n'))
    } catch (e) {
      log('search失敗:', errMsg(e))
      return errorText(`search エラー: ${errMsg(e)}`)
    }
  },
)

server.registerTool(
  'fetch',
  {
    description:
      'URLを指定してページ本文をMarkdown形式（# タイトル + 本文）で返す。' +
      'JavaScriptが必要なSPAも取得可能。ローカルIP・file://へのアクセスは拒否される。' +
      `20秒でタイムアウト。本文は最大${MAX_BODY_CHARS.toLocaleString()}文字で切り詰められる。`,
    inputSchema: {
      url: z.string().url().describe('取得するページのURL（https:// または http://）'),
    },
  },
  async ({ url }) => {
    try {
      return text(await fetchPage(url))
    } catch (e) {
      log('fetch失敗:', errMsg(e))
      return errorText(`fetch エラー: ${errMsg(e)}`)
    }
  },
)

// ── Implementations ──────────────────────────────────────────────────────────

export async function search(query: string, limit: number) {
  const searchUrl = `https://duckduckgo.com/?q=${encodeURIComponent(query)}`
  return withRetry(() => withPage(TIMEOUT_SEARCH, async (page) => {
    const deadline = Date.now() + TIMEOUT_SEARCH
    const response = await page.goto(searchUrl, { waitUntil: 'domcontentloaded' })
    if (response && !response.ok()) {
      throw new Error(`DuckDuckGoがHTTP ${response.status()} を返しました（レート制限の可能性があります）`)
    }
    try {
      // 全体30秒予算を超えないよう、待機は残り予算でクランプする
      const remaining = Math.max(1, Math.min(SEARCH_RESULT_TIMEOUT, deadline - Date.now()))
      await page.waitForSelector(SEARCH_RESULT_SELECTOR, { timeout: remaining })
    } catch (e) {
      if ((e as Error).name !== 'TimeoutError') throw e // 一時的エラーは withRetry に任せる
      // SERP本体が描画済みなら正当な0件。描画すらされていなければbot遮断とみなす
      if (await page.$(SEARCH_PAGE_READY_SELECTOR)) return []
      throw new Error('DuckDuckGoの検索結果を取得できませんでした（bot対策でブロックされた可能性があります）')
    }
    await page.waitForNetworkIdle({ idleTime: 500, timeout: NETWORK_IDLE_TIMEOUT }).catch(() => {}) // 漸進描画の残りをベストエフォートで待つ
    return page.evaluate(extractSearchResults, SEARCH_RESULT_SELECTOR, limit)
  }))
}

function assertReachedPublicUrl(finalUrl: string, requested: string): void {
  if (finalUrl === '' || finalUrl === 'about:blank') {
    throw new Error(`ページへ到達できませんでした（リダイレクトが遮断された可能性があります）: ${requested}`)
  }
  validateUrl(finalUrl) // リダイレクト先も検証
}

export async function fetchPage(url: string) {
  validateUrl(url)
  await assertPublicDns(new URL(url).hostname)
  return withRetry(() => withPage(TIMEOUT_FETCH, async (page) => {
    await page.setBypassCSP(true) // Readability注入をページのCSPに阻まれないようにする
    const response = await page.goto(url, { waitUntil: 'domcontentloaded' })
    if (response && !response.ok()) {
      throw new Error(`HTTPエラー ${response.status()}: ${url}`)
    }
    assertReachedPublicUrl(page.url(), url)
    await page.waitForNetworkIdle({ idleTime: 500, timeout: NETWORK_IDLE_TIMEOUT }).catch(() => {}) // SPAの描画をベストエフォートで待つ
    await page.addScriptTag({ content: READABILITY_SRC })
    const article = await page.evaluate(extractArticleInPage, MAX_TRANSFER_CHARS)
    return formatArticle(article, url)
  }))
}

// ── Start ────────────────────────────────────────────────────────────────────

if (import.meta.main) {
  await server.connect(new StdioServerTransport())
  // クライアント切断時にブラウザを残さない。
  // StdioServerTransportはstdin EOFを監視しないため、自前でも監視する
  server.server.onclose = () => { void shutdown() }
  process.stdin.once('end', () => { void shutdown() })
}
