import { describe, expect, it, vi } from 'vitest'
import { parseStreamableMcpBody, StreamableHttpMcpClient } from '@zhizhi/cap-mcp-client'

const endpointUrl = 'https://mcp.example.test/mcp/'

describe('parseStreamableMcpBody', () => {
  it('parses a JSON-RPC envelope from a JSON response', () => {
    const envelope = { jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'lookup' }] } }

    expect(parseStreamableMcpBody(JSON.stringify(envelope), 'application/json; charset=utf-8'))
      .toEqual(envelope)
  })

  it('selects the final JSON-RPC result among progress and completion SSE frames', () => {
    const body = [
      'event: progress',
      'data: {"method":"notifications/progress","params":{"progress":1,"total":2}}',
      '',
      'event: message',
      'data: {"jsonrpc":"2.0","id":1,',
      'data: "result":{"tools":[{"name":"lookup"}]}}',
      '',
      'data: [DONE]',
    ].join('\r\n')

    expect(parseStreamableMcpBody(body, 'text/event-stream; charset=utf-8')).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: { tools: [{ name: 'lookup' }] },
    })
  })

  it.each(['application/json', 'text/event-stream'])('rejects malformed %s bodies', (contentType) => {
    const body = contentType === 'application/json' ? '{invalid' : 'event: progress\ndata: not JSON'

    expect(() => parseStreamableMcpBody(body, contentType)).toThrow(expect.objectContaining({
      code: 'SCHEMA_INVALID',
    }))
  })
})

describe('StreamableHttpMcpClient', () => {
  it('posts a tool call with Bearer auth and prefers structured content over text JSON', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      jsonrpc: '2.0',
      id: 1,
      result: {
        content: [
          { type: 'text', text: '{"source":"text"}' },
          { type: 'image', text: 'not a text block' },
        ],
        structuredContent: { source: 'structured' },
      },
    }))
    const client = new StreamableHttpMcpClient({ endpointUrl, apiKey: 'test-token', fetchImpl })

    await expect(client.callTool('lookup', { query: '字幕' })).resolves.toEqual({
      isError: false,
      text: '{"source":"text"}',
      json: { source: 'structured' },
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0] ?? []
    expect(url).toBe(endpointUrl)
    expect(init?.method).toBe('POST')
    const headers = new Headers(init?.headers)
    expect(headers.get('authorization')).toBe('Bearer test-token')
    expect(headers.has('x-api-key')).toBe(false)
    expect(headers.get('content-type')).toBe('application/json')
    expect(headers.get('accept')).toBe('application/json, text/event-stream')
    expect(JSON.parse(typeof init?.body === 'string' ? init.body : '')).toEqual({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'lookup', arguments: { query: '字幕' } },
    })
  })

  it('lists tool names and pings via tools/list using X-API-Key without a Bearer prefix', async () => {
    const tools = [{ name: 'lookup', description: 'Find subtitles' }, { name: 'download' }]
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(
        `data: ${JSON.stringify({ jsonrpc: '2.0', id: 1, result: { tools } })}\n\n`,
        { headers: { 'content-type': 'text/event-stream' } },
      ))
      .mockResolvedValueOnce(Response.json({ jsonrpc: '2.0', id: 2, result: { tools } }))
    const client = new StreamableHttpMcpClient({
      endpointUrl,
      apiKey: 'test-key',
      authHeaderName: 'X-API-Key',
      fetchImpl,
    })

    await expect(client.listTools()).resolves.toEqual(['lookup', 'download'])
    const ping = await client.ping()
    expect(ping.ok).toBe(true)
    expect(ping.detail).toBe('Connected (2 tools available)')
    expect(ping.latencyMs).toBeGreaterThanOrEqual(0)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    for (const [index, [url, init]] of fetchImpl.mock.calls.entries()) {
      expect(url).toBe(endpointUrl)
      expect(init?.method).toBe('POST')
      const headers = new Headers(init?.headers)
      expect(headers.get('x-api-key')).toBe('test-key')
      expect(headers.has('authorization')).toBe(false)
      expect(headers.get('accept')).toBe('application/json, text/event-stream')
      expect(JSON.parse(typeof init?.body === 'string' ? init.body : '')).toEqual({
        jsonrpc: '2.0',
        id: index + 1,
        method: 'tools/list',
        params: {},
      })
    }
  })

  it.each([
    { status: 401, code: 'UNAUTHORIZED', retryable: false },
    { status: 503, code: 'PLUGIN_UNAVAILABLE', retryable: true },
  ])('maps HTTP $status to $code (retryable: $retryable)', async ({ status, code, retryable }) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('upstream error', { status }))
    const client = new StreamableHttpMcpClient({ endpointUrl, fetchImpl })

    await expect(client.listTools()).rejects.toMatchObject({
      name: 'ZhizhiError',
      code,
      retryable,
      details: { status },
    })
  })

  it('reports a failed ping instead of rejecting when the server is unavailable', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 503 }))
    const client = new StreamableHttpMcpClient({ endpointUrl, fetchImpl })

    await expect(client.ping()).resolves.toMatchObject({
      ok: false,
      detail: 'MCP server responded with HTTP 503',
    })
  })

  it.each([
    { rpcCode: -32602, retryable: true },
    { rpcCode: -32000, retryable: false },
  ])('maps JSON-RPC error $rpcCode from a successful HTTP response', async ({ rpcCode, retryable }) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      jsonrpc: '2.0',
      id: 1,
      error: { code: rpcCode, message: 'Cannot complete tool call' },
    }))
    const client = new StreamableHttpMcpClient({ endpointUrl, fetchImpl })

    await expect(client.callTool('lookup', {})).rejects.toMatchObject({
      code: 'PLUGIN_UNAVAILABLE',
      message: `MCP JSON-RPC error (${rpcCode}): Cannot complete tool call`,
      retryable,
    })
  })

  it('returns a tool-level error as a result and decodes JSON text without structured content', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      jsonrpc: '2.0',
      id: 1,
      result: { isError: true, content: [{ type: 'text', text: ' {"reason":"missing subtitles"} ' }] },
    }))
    const client = new StreamableHttpMcpClient({ endpointUrl, fetchImpl })

    await expect(client.callTool('lookup', {})).resolves.toEqual({
      isError: true,
      text: '{"reason":"missing subtitles"}',
      json: { reason: 'missing subtitles' },
    })
  })
})
