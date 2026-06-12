import { test, expect, describe, afterAll } from 'bun:test'
import { search, fetchPage, validateUrl, getBrowser } from './index'

const skip = process.env.SKIP_INTEGRATION === '1'

// ── 統合テスト（実DuckDuckGo + 実Puppeteer） ─────────────────────────────────

describe.if(!skip)('integration: search', () => {
  test(
    'TypeScript → limit=3 → 結果は3件以内、各resultはtitle/url/snippetを持つ',
    async () => {
      const results = await search('TypeScript', 3)
      expect(results.length).toBeLessThanOrEqual(3)
      for (const r of results) {
        expect(r.title.length).toBeGreaterThan(0)
        expect(typeof r.url).toBe('string')
        expect(typeof r.snippet).toBe('string')
      }
    },
    { timeout: 30_000 },
  )

  test(
    'Bun runtime → limit=5 → 5件以内',
    async () => {
      const results = await search('Bun runtime', 5)
      expect(results.length).toBeLessThanOrEqual(5)
    },
    { timeout: 30_000 },
  )

  test(
    'プログラミング → limit=3 → 配列が返る（日本語クエリ）',
    async () => {
      const results = await search('プログラミング', 3)
      expect(results.length).toBeLessThanOrEqual(3)
    },
    { timeout: 30_000 },
  )

  test(
    'limit=1 → 1件以内',
    async () => {
      expect((await search('JavaScript', 1)).length).toBeLessThanOrEqual(1)
    },
    { timeout: 30_000 },
  )

  test(
    '各 result.url は validateUrl() を通過する',
    async () => {
      const results = await search('TypeScript tutorial', 5)
      for (const r of results) {
        expect(() => validateUrl(r.url)).not.toThrow()
      }
    },
    { timeout: 30_000 },
  )
})

describe.if(!skip)('integration: fetchPage', () => {
  test(
    'https://example.com → "# " で始まる、3連続以上の改行なし',
    async () => {
      const result = await fetchPage('https://example.com')
      expect(result).toMatch(/^# .+/)
      expect(result).not.toMatch(/\n{3,}/)
    },
    { timeout: 30_000 },
  )

  test(
    '存在しないパス（404） → throw する',
    async () => {
      await expect(fetchPage('https://example.com/nonexistent')).rejects.toThrow('HTTPエラー 404')
    },
    { timeout: 30_000 },
  )
})

afterAll(async () => {
  const b = await getBrowser().catch(() => null)
  await b?.close()
})
