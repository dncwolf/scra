import { mock, beforeEach, afterEach, test, expect, describe } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { Readability } from '@mozilla/readability'
import { JSDOM } from 'jsdom'

// ── Puppeteer mock ────────────────────────────────────────────────────────────

const mockClose = mock(() => Promise.resolve())
const mockGoto = mock(() => Promise.resolve({ ok: () => true, status: () => 200 } as any))
const mockContent = mock(() => Promise.resolve(''))

// 渡された抽出関数を、mockContentのHTMLから作ったJSDOM環境で実際に実行する
const mockEvaluate = mock(async (fn: any, ...args: any[]) => {
  const dom = new JSDOM(await mockContent(), { url: 'https://example.com/' })
  const g = globalThis as any
  const saved = { document: g.document, location: g.location, Readability: g.Readability }
  Object.assign(g, { document: dom.window.document, location: dom.window.location, Readability })
  try {
    return await fn(...args)
  } finally {
    Object.assign(g, saved)
  }
})

const mockOn = mock((_event: string, _handler: (req: any) => void) => { })

const mockPage = {
  setDefaultTimeout: mock(() => { }),
  setDefaultNavigationTimeout: mock(() => { }),
  setUserAgent: mock(() => Promise.resolve()),
  setBypassCSP: mock(() => Promise.resolve()),
  setRequestInterception: mock(() => Promise.resolve()),
  on: mockOn,
  goto: mockGoto,
  content: mockContent,
  close: mockClose,
  url: mock(() => 'https://example.com'),
  waitForNetworkIdle: mock(() => Promise.resolve()),
  waitForSelector: mock(() => Promise.resolve({} as any)),
  $: mock(() => Promise.resolve(null as any)),
  addScriptTag: mock(() => Promise.resolve()),
  evaluate: mockEvaluate,
}

let _connected = true
let _disconnectedHandler: (() => void) | null = null

const mockBrowserClose = mock(() => Promise.resolve())
const mockBrowserOn = mock((event: string, handler: () => void) => {
  if (event === 'disconnected') _disconnectedHandler = handler
})
const mockNewPage = mock(() => Promise.resolve(mockPage as any))

const mockBrowser = {
  get connected() { return _connected },
  newPage: mockNewPage,
  on: mockBrowserOn,
  close: mockBrowserClose,
}

const mockLaunch = mock(() => {
  _connected = true
  return Promise.resolve(mockBrowser as any)
})

mock.module('puppeteer', () => ({
  default: { launch: mockLaunch },
}))

// ── DNS mock ──────────────────────────────────────────────────────────────────

const PUBLIC_LOOKUP = [{ address: '93.184.216.34', family: 4 }]
const mockLookup = mock(() => Promise.resolve(PUBLIC_LOOKUP as any))

mock.module('node:dns/promises', () => ({ lookup: mockLookup }))

// ── Module under test ─────────────────────────────────────────────────────────

const {
  validateUrl, search, fetchPage, getBrowser, resetBrowser, resetDnsCache,
  requestBlockReason, server, expandIPv6, formatArticle,
} = await import('./index')

// puppeteerのTimeoutErrorはnameで見分けられる
function timeoutError() {
  const e = new Error('Waiting for selector failed: timeout')
  e.name = 'TimeoutError'
  return e
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const EMPTY_HTML = '<html><body></body></html>'
const ARTICLE_HTML = `<!DOCTYPE html>
<html><head><title>Test Article</title></head><body>
<article>
<h1>Test Article</h1>
<p>This is the first paragraph with substantial content for Readability to extract properly.</p>
<p>This is the second paragraph with more content to ensure the Readability parser functions correctly.</p>
<p>Third paragraph with additional content to meet the minimum content threshold requirements.</p>
</article>
</body></html>`

function makeDDGHtml(results: Array<{ title: string; url: string; snippet: string; isAd?: boolean }>) {
  const items = results.map(r => `
    <article data-testid="result">
      <a data-testid="result-title-a" href="${r.isAd ? `https://duckduckgo.com/y.js?ad_domain=${encodeURIComponent(r.url)}` : r.url}">${r.title}</a>
      <div data-result="snippet">${r.snippet}</div>
    </article>`).join('')
  return `<html><body>${items}</body></html>`
}

// ── Mock helpers ──────────────────────────────────────────────────────────────

function setupMocks(defaultContent = EMPTY_HTML) {
  resetBrowser()
  resetDnsCache()
  _connected = true
  mockLaunch.mockClear()
  mockNewPage.mockClear()
  mockClose.mockClear()
  mockGoto.mockClear()
  mockOn.mockClear()
  mockPage.setRequestInterception.mockClear()
  mockGoto.mockImplementation(() => Promise.resolve({ ok: () => true, status: () => 200 } as any))
  mockLookup.mockClear()
  mockLookup.mockImplementation(() => Promise.resolve(PUBLIC_LOOKUP as any))
  mockContent.mockImplementation(() => Promise.resolve(defaultContent))
  mockLaunch.mockImplementation(() => {
    _connected = true
    return Promise.resolve(mockBrowser as any)
  })
}

const teardown = () => { resetBrowser(); _connected = true }

// ── 1. validateUrl ────────────────────────────────────────────────────────────

describe('validateUrl', () => {
  // 許可
  test('https:// を許可', () => expect(() => validateUrl('https://example.com')).not.toThrow())
  test('http:// を許可', () => expect(() => validateUrl('http://example.com')).not.toThrow())
  test('172.15.x.x はプライベート範囲外なので許可', () => expect(() => validateUrl('http://172.15.0.1')).not.toThrow())
  test('172.32.x.x はプライベート範囲外なので許可', () => expect(() => validateUrl('http://172.32.0.1')).not.toThrow())
  test('認証情報付きURLはhostnameのみチェック', () => expect(() => validateUrl('https://user:pass@example.com')).not.toThrow())
  test('Unicodeパスを許可', () => expect(() => validateUrl('https://example.com/path/あいう')).not.toThrow())
  test('非常に長いURLを許可', () => expect(() => validateUrl(`https://example.com/${'a'.repeat(2000)}`)).not.toThrow())

  // スキーム拒否
  test('file:// を拒否', () => expect(() => validateUrl('file:///etc/passwd')).toThrow('許可されていないスキーム'))
  test('ftp:// を拒否', () => expect(() => validateUrl('ftp://example.com')).toThrow('許可されていないスキーム'))
  test('javascript: を拒否', () => expect(() => validateUrl('javascript:alert(1)')).toThrow('許可されていないスキーム'))

  // プライベートIP拒否
  test('localhost を拒否', () => expect(() => validateUrl('http://localhost')).toThrow('プライベートIP'))
  test('LOCALHOST を拒否', () => expect(() => validateUrl('http://LOCALHOST')).toThrow('プライベートIP'))
  test('127.0.0.1 を拒否', () => expect(() => validateUrl('http://127.0.0.1')).toThrow('プライベートIP'))
  test('127.0.0.255 を拒否', () => expect(() => validateUrl('http://127.0.0.255')).toThrow('プライベートIP'))
  test('0.0.0.0 を拒否', () => expect(() => validateUrl('http://0.0.0.0')).toThrow('プライベートIP'))
  test('::1 を拒否', () => expect(() => validateUrl('http://[::1]')).toThrow('プライベートIP'))
  test('10.x.x.x を拒否', () => expect(() => validateUrl('http://10.0.0.1')).toThrow('プライベートIP'))
  test('192.168.x.x を拒否', () => expect(() => validateUrl('http://192.168.0.1')).toThrow('プライベートIP'))
  test('172.16.x.x を拒否（境界下限）', () => expect(() => validateUrl('http://172.16.0.1')).toThrow('プライベートIP'))
  test('172.31.x.x を拒否（境界上限）', () => expect(() => validateUrl('http://172.31.0.1')).toThrow('プライベートIP'))

  // 不正フォーマット
  test('不正フォーマットを拒否', () => expect(() => validateUrl('not-a-url')).toThrow('無効なURL'))

  // SSRF強化分
  test('169.254.169.254 を拒否（クラウドメタデータ）', () => expect(() => validateUrl('http://169.254.169.254')).toThrow('プライベートIP'))
  test('[::ffff:7f00:1] を拒否（IPv4-mapped IPv6）', () => expect(() => validateUrl('http://[::ffff:7f00:1]')).toThrow('プライベートIP'))
  test('100.64.x.x を拒否（CGN下限）', () => expect(() => validateUrl('http://100.64.0.1')).toThrow('プライベートIP'))
  test('100.127.x.x を拒否（CGN上限）', () => expect(() => validateUrl('http://100.127.0.1')).toThrow('プライベートIP'))
  test('100.63.x.x はCGN範囲外なので許可', () => expect(() => validateUrl('http://100.63.0.1')).not.toThrow())
  test('100.128.x.x はCGN範囲外なので許可', () => expect(() => validateUrl('http://100.128.0.1')).not.toThrow())
  test('[fe80::1] を拒否（リンクローカル）', () => expect(() => validateUrl('http://[fe80::1]')).toThrow('プライベートIP'))
  test('[fd00::1] を拒否（ULA）', () => expect(() => validateUrl('http://[fd00::1]')).toThrow('プライベートIP'))
  test('[2606:4700::1111] は公開IPv6なので許可', () => expect(() => validateUrl('http://[2606:4700::1111]')).not.toThrow())
  test('sub.localhost を拒否', () => expect(() => validateUrl('http://sub.localhost')).toThrow('プライベートIP'))
  test('短縮IPv4（127.1）は正規化されて拒否', () => expect(() => validateUrl('http://127.1')).toThrow('プライベートIP'))
  test('10進表記IP（2130706433 = 127.0.0.1）を拒否', () => expect(() => validateUrl('http://2130706433')).toThrow('プライベートIP'))
  test('[64:ff9b::7f00:1] を拒否（NAT64経由のループバック）', () => expect(() => validateUrl('http://[64:ff9b::7f00:1]')).toThrow('プライベートIP'))
  test('[64:ff9b::808:808] は公開IPのNAT64なので許可', () => expect(() => validateUrl('http://[64:ff9b::808:808]')).not.toThrow())
  test('[::ffff:8.8.8.8] は公開IPのmappedなので許可', () => expect(() => validateUrl('http://[::ffff:8.8.8.8]')).not.toThrow())
})

// ── 2. search ─────────────────────────────────────────────────────────────────

describe('search', () => {
  beforeEach(() => setupMocks())
  afterEach(teardown)

  test('3件の結果を正しくパースする', async () => {
    mockContent.mockResolvedValueOnce(makeDDGHtml([
      { title: 'Title 1', url: 'https://example1.com/', snippet: 'Snippet 1' },
      { title: 'Title 2', url: 'https://example2.com/', snippet: 'Snippet 2' },
      { title: 'Title 3', url: 'https://example3.com/', snippet: 'Snippet 3' },
    ]))

    const results = await search('test', 5)
    expect(results).toHaveLength(3)
    expect(results[0]).toEqual({ title: 'Title 1', url: 'https://example1.com/', snippet: 'Snippet 1' })
    expect(results[1]!.url).toBe('https://example2.com/')
    expect(results[2]!.title).toBe('Title 3')
  })

  test('%エンコードを含むURLを二重デコードしない', async () => {
    mockContent.mockResolvedValueOnce(makeDDGHtml([
      { title: 'Percent', url: 'https://example.com/a%20b', snippet: '' },
    ]))
    const results = await search('test', 5)
    expect(results[0]!.url).toBe('https://example.com/a%20b')
  })

  test('スポンサー枠（/y.js リダイレクト）をスキップする', async () => {
    mockContent.mockResolvedValueOnce(makeDDGHtml([
      { title: 'Organic', url: 'https://organic.com/', snippet: 'Real result' },
      { title: 'Ad Result', url: 'https://ad.com/', snippet: 'Ad content', isAd: true },
      { title: 'Organic 2', url: 'https://organic2.com/', snippet: 'Real result 2' },
    ]))
    const results = await search('test', 10)
    expect(results).toHaveLength(2)
    expect(results.every(r => !r.url.includes('/y.js'))).toBe(true)
  })

  test('広告除外後に limit 件でスライスする', async () => {
    mockContent.mockResolvedValueOnce(makeDDGHtml([
      { title: 'T1', url: 'https://e1.com/', snippet: '' },
      { title: 'Ad', url: 'https://ad.com/', snippet: '', isAd: true },
      { title: 'T2', url: 'https://e2.com/', snippet: '' },
      { title: 'T3', url: 'https://e3.com/', snippet: '' },
      { title: 'T4', url: 'https://e4.com/', snippet: '' },
    ]))
    expect(await search('test', 2)).toHaveLength(2)
  })

  test('result要素なし → 空配列', async () => {
    expect(await search('test', 5)).toHaveLength(0)
  })

  test('タイトルリンクなし → その要素をフィルタ', async () => {
    mockContent.mockResolvedValueOnce(`<html><body>
      <article data-testid="result">
        <div data-result="snippet">snippet without title link</div>
      </article>
    </body></html>`)
    expect(await search('test', 5)).toHaveLength(0)
  })

  test('ブロック（SERP自体が描画されない）→ throw', async () => {
    mockPage.waitForSelector.mockRejectedValueOnce(timeoutError())
    await expect(search('test', 5)).rejects.toThrow('ブロックされた可能性')
  })

  test('結果セレクタが出ないがSERPは描画済み → 正当な0件として空配列', async () => {
    mockPage.waitForSelector.mockRejectedValueOnce(timeoutError())
    mockPage.$.mockResolvedValueOnce({} as any)
    expect(await search('test', 5)).toHaveLength(0)
  })

  test('waitForSelector の一時的エラー（Target closed）はリトライして成功する', async () => {
    mockPage.waitForSelector.mockRejectedValueOnce(new Error('Protocol error: Target closed'))
    mockContent.mockResolvedValueOnce(makeDDGHtml([{ title: 'T', url: 'https://e.com/', snippet: '' }]))
    expect(await search('test', 5)).toHaveLength(1)
  })

  test('duckduckgo.comへのリンクは uddg パラメータを復元する', async () => {
    mockContent.mockResolvedValueOnce(`<html><body>
      <article data-testid="result">
        <a data-testid="result-title-a" href="https://duckduckgo.com/l/?uddg=${encodeURIComponent('https://example.com/path?q=hello world')}">Wrapped</a>
      </article>
    </body></html>`)
    const results = await search('test', 5)
    expect(results[0]!.url).toBe('https://example.com/path?q=hello world')
  })

  test('duckduckgo.com内部リンク（uddgなし）はフィルタする', async () => {
    mockContent.mockResolvedValueOnce(`<html><body>
      <article data-testid="result">
        <a data-testid="result-title-a" href="https://duckduckgo.com/settings">Settings</a>
      </article>
    </body></html>`)
    expect(await search('test', 5)).toHaveLength(0)
  })

  test('http(s)以外のスキームのリンクはフィルタする', async () => {
    mockContent.mockResolvedValueOnce(`<html><body>
      <article data-testid="result">
        <a data-testid="result-title-a" href="javascript:alert(1)">XSS</a>
      </article>
    </body></html>`)
    expect(await search('test', 5)).toHaveLength(0)
  })

  test('パスに /y.js を含む非DDGホストは除外しない', async () => {
    mockContent.mockResolvedValueOnce(makeDDGHtml([
      { title: 'Yjs', url: 'https://github.com/user/y.js', snippet: 'CRDT library' },
    ]))
    const results = await search('test', 5)
    expect(results).toHaveLength(1)
    expect(results[0]!.url).toBe('https://github.com/user/y.js')
  })

  test('アイドル後にブラウザを自動クローズする', async () => {
    process.env.SCRA_IDLE_TIMEOUT_MS = '20'
    try {
      await search('test', 5)
      mockBrowserClose.mockClear()
      await new Promise(r => setTimeout(r, 80))
      expect(mockBrowserClose).toHaveBeenCalledTimes(1)
    } finally {
      delete process.env.SCRA_IDLE_TIMEOUT_MS
    }
  })

  test('スニペット要素なし → snippet: "" で返す', async () => {
    mockContent.mockResolvedValueOnce(`<html><body>
      <article data-testid="result">
        <a data-testid="result-title-a" href="https://example.com/">Title</a>
      </article>
    </body></html>`)
    const results = await search('test', 5)
    expect(results).toHaveLength(1)
    expect(results[0]!.snippet).toBe('')
  })

  test('タイトルが空文字でも結果として返す', async () => {
    mockContent.mockResolvedValueOnce(`<html><body>
      <article data-testid="result">
        <a data-testid="result-title-a" href="https://example.com/"></a>
        <div data-result="snippet">snippet</div>
      </article>
    </body></html>`)
    const results = await search('test', 5)
    expect(results).toHaveLength(1)
    expect(results[0]!.title).toBe('')
  })

  test('goto() がthrow → search全体がreject', async () => {
    mockGoto.mockRejectedValueOnce(new Error('Navigation failed'))
    await expect(search('test', 5)).rejects.toThrow('Navigation failed')
  })

  test('goto() タイムアウト → throw', async () => {
    mockGoto.mockRejectedValueOnce(new DOMException('The operation was aborted', 'AbortError'))
    await expect(search('test', 5)).rejects.toThrow()
  })

  test('DuckDuckGoがHTTPエラーを返す → throw', async () => {
    mockGoto.mockResolvedValueOnce({ ok: () => false, status: () => 403 } as any)
    await expect(search('test', 5)).rejects.toThrow('403')
  })

  test('一時的なネットワークエラーは1回リトライして成功する', async () => {
    mockGoto.mockRejectedValueOnce(new Error('net::ERR_CONNECTION_RESET at https://duckduckgo.com'))
    mockContent.mockResolvedValueOnce(makeDDGHtml([{ title: 'T', url: 'https://e.com/', snippet: '' }]))
    const results = await search('test', 5)
    expect(results).toHaveLength(1)
    expect(mockGoto).toHaveBeenCalledTimes(2)
  })

  test('一時的エラーが2回連続 → reject（リトライは1回のみ）', async () => {
    mockGoto
      .mockRejectedValueOnce(new Error('net::ERR_CONNECTION_RESET'))
      .mockRejectedValueOnce(new Error('net::ERR_CONNECTION_RESET'))
    await expect(search('test', 5)).rejects.toThrow('ERR_CONNECTION_RESET')
    expect(mockGoto).toHaveBeenCalledTimes(2)
  })

  // 境界値・ファズ
  test('limit=1 → 1件のみ返す', async () => {
    mockContent.mockResolvedValueOnce(makeDDGHtml([
      { title: 'T1', url: 'https://e1.com', snippet: '' },
      { title: 'T2', url: 'https://e2.com', snippet: '' },
    ]))
    expect(await search('test', 1)).toHaveLength(1)
  })

  test('limit=20 → 最大20件返す', async () => {
    const items = Array.from({ length: 25 }, (_, i) => ({ title: `T${i}`, url: `https://e${i}.com`, snippet: '' }))
    mockContent.mockResolvedValueOnce(makeDDGHtml(items))
    expect(await search('test', 20)).toHaveLength(20)
  })

  test("query に SQL インジェクション風文字", async () => {
    expect(Array.isArray(await search("' OR 1=1", 5))).toBe(true)
  })

  test('query に XSS風文字', async () => {
    expect(Array.isArray(await search('<script>alert(1)</script>', 5))).toBe(true)
  })

  test('query に日本語マルチバイト文字', async () => {
    expect(Array.isArray(await search('あいうえお', 5))).toBe(true)
  })

  test('query が空文字列 → 空配列', async () => {
    expect(await search('', 5)).toHaveLength(0)
  })
})

// ── 3. fetchPage ──────────────────────────────────────────────────────────────

describe('fetchPage', () => {
  beforeEach(() => setupMocks(ARTICLE_HTML))
  afterEach(teardown)

  test('Readability抽出 → "# タイトル\\n\\n本文" 形式', async () => {
    const result = await fetchPage('https://example.com')
    expect(result).toMatch(/^# Test Article\n\n/)
    expect(result).toContain('This is the first paragraph')
  })

  test('連続空行を \\n\\n に圧縮する', async () => {
    mockContent.mockImplementationOnce(() => Promise.resolve(`<!DOCTYPE html>
<html><head><title>Blank Lines Test</title></head><body>
<article>
<p>First paragraph with substantial content to pass Readability threshold.</p>


<p>Second paragraph after multiple blank lines in the source HTML content here.</p>


<p>Third paragraph for additional content required by Readability parser.</p>
</article>
</body></html>`))
    expect(await fetchPage('https://example.com')).not.toMatch(/\n{3,}/)
  })

  test('HTMLエンティティ &amp; → & としてデコードされる', async () => {
    mockContent.mockImplementationOnce(() => Promise.resolve(`<!DOCTYPE html>
<html><head><title>Test &amp; Article</title></head><body><article>
<h1>Test &amp; Article</h1>
<p>Content with &amp; entity and substantial text for Readability to parse properly here.</p>
<p>Second paragraph with more content to ensure the parser functions correctly for testing.</p>
<p>Third paragraph for additional content required by Readability parser threshold here.</p>
</article></body></html>`))
    const result = await fetchPage('https://example.com')
    expect(result).toContain('&')
    expect(result).not.toContain('&amp;')
  })

  test('HTTP 404 → throw', async () => {
    mockGoto.mockImplementationOnce(() =>
      Promise.resolve({ ok: () => false, status: () => 404 } as any))
    await expect(fetchPage('https://example.com')).rejects.toThrow('HTTPエラー 404')
  })

  test('Readability が null を返す → throw', async () => {
    mockContent.mockImplementationOnce(() =>
      Promise.resolve('<html><head><title>Empty</title></head><body></body></html>'))
    await expect(fetchPage('https://example.com')).rejects.toThrow('ページを読み取れませんでした')
  })

  test('goto() が null を返す → ok() チェックをスキップして正常続行', async () => {
    mockGoto.mockResolvedValueOnce(null)
    const result = await fetchPage('https://example.com')
    expect(result).toMatch(/^# Test Article/)
    expect(mockClose).toHaveBeenCalledTimes(1)
  })

  test('goto() がthrow → page.close() が finally で呼ばれる', async () => {
    mockClose.mockClear()
    mockGoto.mockRejectedValueOnce(new Error('Navigation timeout'))
    await expect(fetchPage('https://example.com')).rejects.toThrow('Navigation timeout')
    expect(mockClose).toHaveBeenCalledTimes(1)
  })

  test('newPage() がthrow → page.close() は呼ばれない', async () => {
    mockClose.mockClear()
    mockNewPage.mockRejectedValueOnce(new Error('newPage crash'))
    await expect(fetchPage('https://example.com')).rejects.toThrow('newPage crash')
    expect(mockClose).toHaveBeenCalledTimes(0)
  })

  test('例外発生時も page.close() が finally で呼ばれる', async () => {
    mockClose.mockClear()
    mockGoto.mockImplementationOnce(() =>
      Promise.resolve({ ok: () => false, status: () => 500 } as any))
    await expect(fetchPage('https://example.com')).rejects.toThrow()
    expect(mockClose).toHaveBeenCalledTimes(1)
  })

  test('launch失敗 → fetchPage全体がreject', async () => {
    mockLaunch.mockRejectedValueOnce(new Error('browser launch failed'))
    await expect(fetchPage('https://example.com')).rejects.toThrow('browser launch failed')
  })

  test('ブラウザクラッシュ（Target closed）は1回リトライして成功する', async () => {
    mockGoto.mockRejectedValueOnce(new Error('Protocol error: Target closed'))
    const result = await fetchPage('https://example.com')
    expect(result).toMatch(/^# Test Article/)
    expect(mockGoto).toHaveBeenCalledTimes(2)
  })

  test('本文がMAX_BODY_CHARSを超える → 切り詰める', async () => {
    mockContent.mockImplementationOnce(() => Promise.resolve(
      `<!DOCTYPE html><html><head><title>Long</title></head><body><article><p>${'lorem ipsum dolor sit amet '.repeat(3000)}</p></article></body></html>`,
    ))
    const result = await fetchPage('https://example.com')
    expect(result).toContain('切り詰められました')
    expect(result.length).toBeLessThan(11_000)
  })

  test('バリデーションを内蔵: file:// → throw', async () => {
    await expect(fetchPage('file:///etc/passwd')).rejects.toThrow('許可されていないスキーム')
  })

  test('プライベートIPv4に解決されるホスト → throw（DNSリベンディング対策）', async () => {
    mockLookup.mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 }] as any)
    await expect(fetchPage('https://rebind.example.com')).rejects.toThrow('プライベートIPに解決される')
  })

  test('プライベートIPv6に解決されるホスト → throw', async () => {
    mockLookup.mockResolvedValueOnce([{ address: 'fe80::1', family: 6 }] as any)
    await expect(fetchPage('https://rebind6.example.com')).rejects.toThrow('プライベートIPに解決される')
  })

  test('DNS解決失敗 → ブロックせずナビゲーションに任せる', async () => {
    mockLookup.mockRejectedValueOnce(new Error('ENOTFOUND'))
    expect(await fetchPage('https://example.com')).toMatch(/^# Test Article/)
  })

  test('リダイレクト先がプライベートIP → throw', async () => {
    mockPage.url.mockReturnValueOnce('http://169.254.169.254/latest/meta-data/')
    await expect(fetchPage('https://example.com')).rejects.toThrow('プライベートIP')
  })

  test('最終URLがabout:blank → 到達失敗として分かりやすいエラー', async () => {
    mockPage.url.mockReturnValueOnce('about:blank')
    await expect(fetchPage('https://example.com')).rejects.toThrow('ページへ到達できませんでした')
  })

  test('waitForNetworkIdle がタイムアウトしても本文を返す', async () => {
    mockPage.waitForNetworkIdle.mockRejectedValueOnce(new Error('Timeout exceeded'))
    expect(await fetchPage('https://example.com')).toMatch(/^# Test Article/)
  })

  test('転送上限（40K）超の本文もページ内で切られ注記が付く', async () => {
    mockContent.mockImplementationOnce(() => Promise.resolve(
      `<!DOCTYPE html><html><head><title>Huge</title></head><body><article><p>${'a'.repeat(250_000)}</p></article></body></html>`,
    ))
    const result = await fetchPage('https://example.com')
    expect(result).toContain('切り詰められました')
    expect(result.length).toBeLessThan(11_000)
  })
})

// ── 3b. formatArticle ─────────────────────────────────────────────────────────

describe('formatArticle', () => {
  test('clippedフラグが立っていれば短い本文でも切り詰め注記を付ける', () => {
    const md = formatArticle({ title: 'T', textContent: 'short', clipped: true }, 'https://x.com')
    expect(md).toContain('切り詰められました')
  })

  test('clippedなし・上限以下なら注記を付けない', () => {
    const md = formatArticle({ title: 'T', textContent: 'short', clipped: false }, 'https://x.com')
    expect(md).toBe('# T\n\nshort')
  })

  test('null → throw', () => {
    expect(() => formatArticle(null, 'https://x.com')).toThrow('ページを読み取れませんでした')
  })

  test('行のtrimと3連以上の改行の圧縮', () => {
    const md = formatArticle({ title: 'T', textContent: '  a  \n\n\n\n  b  ', clipped: false }, 'https://x.com')
    expect(md).toBe('# T\n\na\n\nb')
  })
})

// ── 3c. expandIPv6 ────────────────────────────────────────────────────────────

describe('expandIPv6', () => {
  test(':: → 全ゼロ8グループ', () => expect(expandIPv6('::')).toEqual([0, 0, 0, 0, 0, 0, 0, 0]))
  test('::1 → ループバック', () => expect(expandIPv6('::1')).toEqual([0, 0, 0, 0, 0, 0, 0, 1]))
  test('1:: → 先頭グループのみ', () => expect(expandIPv6('1::')).toEqual([1, 0, 0, 0, 0, 0, 0, 0]))
  test('完全形8グループ', () => expect(expandIPv6('1:2:3:4:5:6:7:8')).toEqual([1, 2, 3, 4, 5, 6, 7, 8]))
  test('末尾IPv4ドット表記を16進2グループへ変換', () =>
    expect(expandIPv6('::ffff:127.0.0.1')).toEqual([0, 0, 0, 0, 0, 0xffff, 0x7f00, 1]))
  test('255超オクテット → null', () => expect(expandIPv6('::ffff:999.0.0.1')).toBeNull())
  test(':: が2回 → null', () => expect(expandIPv6('1::2::3')).toBeNull())
  test('グループ過多 → null', () => expect(expandIPv6('1:2:3:4:5:6:7:8:9')).toBeNull())
  test(':: なしでグループ不足 → null', () => expect(expandIPv6('1:2:3')).toBeNull())
  test('16進でないグループ → null', () => expect(expandIPv6('zzzz::1')).toBeNull())
})

// ── 4. requestBlockReason ─────────────────────────────────────────────────────

describe('requestBlockReason', () => {
  beforeEach(() => setupMocks())
  afterEach(teardown)

  test('公開URLは許可', async () => {
    expect(await requestBlockReason('https://example.com/script.js')).toBeNull()
  })

  test('data: はサブリソースとして許可', async () => {
    expect(await requestBlockReason('data:image/png;base64,iVBORw0KGgo=')).toBeNull()
  })

  test('file:// は遮断', async () => {
    expect(await requestBlockReason('file:///etc/passwd')).toContain('スキーム')
  })

  test('プライベートIPは遮断', async () => {
    expect(await requestBlockReason('http://169.254.169.254/latest/')).toContain('プライベートIP')
  })

  test('プライベートIPに解決されるホストは遮断', async () => {
    mockLookup.mockResolvedValueOnce([{ address: '10.0.0.5', family: 4 }] as any)
    expect(await requestBlockReason('https://rebind.example.com/api')).toContain('プライベートIP')
  })

  test('不正なURLは遮断', async () => {
    expect(await requestBlockReason('::::')).toBe('無効なURL')
  })
})

// ── 4b. リクエストインターセプト配線（guardPage） ────────────────────────────

describe('リクエストインターセプト', () => {
  beforeEach(() => setupMocks())
  afterEach(teardown)

  const makeReq = (url: string, resourceType = 'document') => ({
    url: () => url,
    resourceType: () => resourceType,
    continue: mock(() => Promise.resolve()),
    abort: mock(() => Promise.resolve()),
  })

  async function captureHandler() {
    await search('test', 5)
    const call = mockOn.mock.calls.findLast(c => (c as any)[0] === 'request') as any
    expect(call).toBeDefined()
    return call[1] as (req: any) => Promise<void>
  }

  test('ページ作成時に setRequestInterception(true) を有効化する', async () => {
    await search('test', 5)
    expect(mockPage.setRequestInterception).toHaveBeenCalledWith(true)
  })

  test('公開URLのリクエストは continue される', async () => {
    const handler = await captureHandler()
    const req = makeReq('https://cdn.example.com/app.js')
    await handler(req)
    expect(req.continue).toHaveBeenCalledTimes(1)
    expect(req.abort).not.toHaveBeenCalled()
  })

  test('data: サブリソースは continue される', async () => {
    const handler = await captureHandler()
    const req = makeReq('data:image/png;base64,iVBORw0KGgo=')
    await handler(req)
    expect(req.continue).toHaveBeenCalledTimes(1)
  })

  test('プライベートIPへのリクエストは abort(blockedbyclient)', async () => {
    const handler = await captureHandler()
    const req = makeReq('http://192.168.1.1/internal-api')
    await handler(req)
    expect(req.abort).toHaveBeenCalledWith('blockedbyclient')
    expect(req.continue).not.toHaveBeenCalled()
  })

  test('file:// サブリソースは abort(blockedbyclient)', async () => {
    const handler = await captureHandler()
    const req = makeReq('file:///etc/passwd')
    await handler(req)
    expect(req.abort).toHaveBeenCalledWith('blockedbyclient')
  })

  test('プライベートIPに解決されるホストへのリクエストは abort', async () => {
    const handler = await captureHandler()
    mockLookup.mockResolvedValueOnce([{ address: '10.0.0.5', family: 4 }] as any)
    const req = makeReq('https://rebind.example.com/api')
    await handler(req)
    expect(req.abort).toHaveBeenCalledWith('blockedbyclient')
  })

  test('continue() が失敗 → abort(failed) へフォールバック', async () => {
    const handler = await captureHandler()
    const req = makeReq('https://ok.example.com/x')
    req.continue.mockRejectedValueOnce(new Error('Request is already handled!'))
    await handler(req)
    expect(req.abort).toHaveBeenCalledWith('failed')
  })

  test('abort() も失敗しても例外が漏れない', async () => {
    const handler = await captureHandler()
    const req = makeReq('http://127.0.0.1/x')
    req.abort.mockRejectedValue(new Error('already handled'))
    await expect(handler(req)).resolves.toBeUndefined()
  })

  test('画像・フォント・メディアのリクエストは取得せず abort する', async () => {
    const handler = await captureHandler()
    for (const type of ['image', 'font', 'media']) {
      const req = makeReq('https://cdn.example.com/asset', type)
      await handler(req)
      expect(req.abort).toHaveBeenCalledWith('blockedbyclient')
      expect(req.continue).not.toHaveBeenCalled()
    }
  })

  test('同一ホストのDNS判定はキャッシュされ lookup は1回のみ', async () => {
    const handler = await captureHandler()
    mockLookup.mockClear()
    await handler(makeReq('https://dnscache.example.com/a.js'))
    await handler(makeReq('https://dnscache.example.com/b.js'))
    expect(mockLookup).toHaveBeenCalledTimes(1)
  })
})

// ── 4. getBrowser ─────────────────────────────────────────────────────────────

describe('getBrowser', () => {
  beforeEach(() => {
    resetBrowser()
    _connected = true
    _disconnectedHandler = null
    mockLaunch.mockClear()
    mockBrowserOn.mockClear()
    mockLaunch.mockImplementation(() => {
      _connected = true
      return Promise.resolve(mockBrowser as any)
    })
  })
  afterEach(teardown)

  test('初回は puppeteer.launch() を呼ぶ', async () => {
    await getBrowser()
    expect(mockLaunch).toHaveBeenCalledTimes(1)
  })

  test('2回目以降はキャッシュを返す（launch は1回のみ）', async () => {
    const b1 = await getBrowser()
    const b2 = await getBrowser()
    expect(mockLaunch).toHaveBeenCalledTimes(1)
    expect(b1).toBe(b2)
  })

  test('並列呼び出し → launch は1回のみ（競合防止）', async () => {
    const [b1, b2, b3] = await Promise.all([getBrowser(), getBrowser(), getBrowser()])
    expect(mockLaunch).toHaveBeenCalledTimes(1)
    expect(b1).toBe(b2)
    expect(b2).toBe(b3)
  })

  test('browser.connected = false → launch を再実行する', async () => {
    await getBrowser()
    _connected = false
    await getBrowser()
    expect(mockLaunch).toHaveBeenCalledTimes(2)
  })

  test('disconnected イベント後 → 次の getBrowser で再起動する', async () => {
    await getBrowser()
    expect(_disconnectedHandler).not.toBeNull()
    _disconnectedHandler!()
    mockLaunch.mockClear()
    await getBrowser()
    expect(mockLaunch).toHaveBeenCalledTimes(1)
  })

  test('launch失敗後 → 2回目は再試行できる', async () => {
    mockLaunch
      .mockRejectedValueOnce(new Error('launch failed'))
      .mockImplementationOnce(() => {
        _connected = true
        return Promise.resolve(mockBrowser as any)
      })
    await expect(getBrowser()).rejects.toThrow('launch failed')
    const b = await getBrowser()
    expect(mockLaunch).toHaveBeenCalledTimes(2)
    expect(b).toBeDefined()
  })
})

// ── 6. MCPサーバー（e2e: InMemoryTransport経由） ─────────────────────────────

const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
await server.connect(serverTransport)
const client = new Client({ name: 'test-client', version: '0.0.0' })
await client.connect(clientTransport)

describe('MCP e2e', () => {
  beforeEach(() => setupMocks())
  afterEach(teardown)

  test('tools/list に search と fetch が載る', async () => {
    const { tools } = await client.listTools()
    expect(tools.map(t => t.name).sort()).toEqual(['fetch', 'search'])
  })

  test('search: 結果を番号付きテキストで返す', async () => {
    mockContent.mockResolvedValueOnce(makeDDGHtml([
      { title: 'Title 1', url: 'https://example1.com', snippet: 'Snippet 1' },
    ]))
    const res: any = await client.callTool({ name: 'search', arguments: { query: 'test', limit: 5 } })
    expect(res.isError).toBeFalsy()
    expect(res.content[0].text).toContain('1. Title 1')
    expect(res.content[0].text).toContain('https://example1.com')
  })

  test('search: 0件のとき案内メッセージを返す', async () => {
    const res: any = await client.callTool({ name: 'search', arguments: { query: 'test' } })
    expect(res.isError).toBeFalsy()
    expect(res.content[0].text).toBe('検索結果が見つかりませんでした。')
  })

  test('search: 内部エラーは isError 付きで返す', async () => {
    mockGoto.mockRejectedValueOnce(new Error('Navigation failed'))
    const res: any = await client.callTool({ name: 'search', arguments: { query: 'test' } })
    expect(res.isError).toBe(true)
    expect(res.content[0].text).toContain('search エラー')
  })

  test('fetch: 本文をMarkdownで返す', async () => {
    mockContent.mockImplementationOnce(() => Promise.resolve(ARTICLE_HTML))
    const res: any = await client.callTool({ name: 'fetch', arguments: { url: 'https://example.com' } })
    expect(res.isError).toBeFalsy()
    expect(res.content[0].text).toMatch(/^# Test Article/)
  })

  test('fetch: 拒否されるURLは isError 付きで返す', async () => {
    const res: any = await client.callTool({ name: 'fetch', arguments: { url: 'http://127.0.0.1/admin' } })
    expect(res.isError).toBe(true)
    expect(res.content[0].text).toContain('プライベートIP')
  })

  test('search: limit が範囲外（21）はスキーマ違反エラーになる', async () => {
    const res: any = await client.callTool({ name: 'search', arguments: { query: 'x', limit: 21 } })
    expect(res.isError).toBe(true)
    expect(res.content[0].text).toContain('Input validation error')
  })

  test('search: limit が範囲外（0）はスキーマ違反エラーになる', async () => {
    const res: any = await client.callTool({ name: 'search', arguments: { query: 'x', limit: 0 } })
    expect(res.isError).toBe(true)
    expect(res.content[0].text).toContain('Input validation error')
  })

  test('fetch: URL形式でない引数はスキーマ違反エラーになる', async () => {
    const res: any = await client.callTool({ name: 'fetch', arguments: { url: 'not-a-url' } })
    expect(res.isError).toBe(true)
    expect(res.content[0].text).toContain('Input validation error')
  })
})
