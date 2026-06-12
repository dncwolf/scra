import { test, expect, describe } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const skip = process.env.SKIP_E2E === '1'

// ── stdio E2E（実プロセスを起動してMCPプロトコルで対話する） ──────────────────
// ブラウザ起動前に弾かれるバリデーション系のみを呼ぶため、ネットワーク不要

describe.if(!skip)('stdio E2E', () => {
  test(
    '起動 → handshake → tools/list → tools/call → 切断',
    async () => {
      const transport = new StdioClientTransport({
        command: 'bun',
        args: ['index.ts'],
        cwd: import.meta.dir,
      })
      const client = new Client({ name: 'e2e-client', version: '0.0.0' })
      await client.connect(transport)
      try {
        const { tools } = await client.listTools()
        expect(tools.map(t => t.name).sort()).toEqual(['fetch', 'search'])

        const res: any = await client.callTool({ name: 'fetch', arguments: { url: 'http://127.0.0.1/admin' } })
        expect(res.isError).toBe(true)
        expect(res.content[0].text).toContain('プライベートIP')

        const schemaErr: any = await client.callTool({ name: 'fetch', arguments: { url: 'file:///etc/passwd' } })
        expect(schemaErr.isError).toBe(true)
        expect(schemaErr.content[0].text).toContain('許可されていないスキーム')
      } finally {
        await client.close()
      }
    },
    { timeout: 20_000 },
  )

  test(
    'stdinが閉じられたらプロセスが自律的に終了する（ゾンビ防止）',
    async () => {
      const proc = Bun.spawn(['bun', 'index.ts'], {
        cwd: import.meta.dir,
        stdin: 'pipe',
        stdout: 'ignore',
        stderr: 'ignore',
      })
      proc.stdin.end()
      const exited = await Promise.race([
        proc.exited,
        new Promise<'timeout'>(r => setTimeout(() => r('timeout'), 10_000)),
      ])
      if (exited === 'timeout') proc.kill()
      expect(exited).toBe(0)
    },
    { timeout: 15_000 },
  )

  test(
    'SIGTERMで終了コード0で終了する',
    async () => {
      const proc = Bun.spawn(['bun', 'index.ts'], {
        cwd: import.meta.dir,
        stdin: 'pipe',
        stdout: 'ignore',
        stderr: 'ignore',
      })
      await new Promise(r => setTimeout(r, 1_500)) // シグナルハンドラ登録を待つ
      proc.kill('SIGTERM')
      const exited = await Promise.race([
        proc.exited,
        new Promise<'timeout'>(r => setTimeout(() => r('timeout'), 10_000)),
      ])
      if (exited === 'timeout') proc.kill()
      expect(exited).toBe(0)
    },
    { timeout: 15_000 },
  )
})
