import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'
import { createDatabase, type DatabaseHandle } from '@zhizhi/db'
import { LocalFsStorageProvider } from '@zhizhi/storage'
import { createDefaultDependencies, createServerApp } from '../src/app.ts'

describe('server foundation: multi-tenant auth, canvas memory, SSE turn & jobs', () => {
  let dbHandle: DatabaseHandle
  let tempStorageDir: string
  let app: ReturnType<typeof createServerApp>

  beforeAll(async () => {
    dbHandle = await createDatabase({ databaseUrl: 'memory://' })
    await dbHandle.bootstrap()
    tempStorageDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zhizhi-test-storage-'))
    const storage = new LocalFsStorageProvider(tempStorageDir)
    const deps = createDefaultDependencies(dbHandle, storage, 'test-secret-key-32-bytes-minimum!!')
    app = createServerApp(deps)
  })

  afterAll(async () => {
    await dbHandle.close()
    await fs.rm(tempStorageDir, { recursive: true, force: true })
  })

  it('returns healthy status with pglite driver and pi-agent runtime', async () => {
    const res = await app.request('/api/v1/health')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { status: string; dbDriver: string; agentRuntime: { piAgentAvailable: boolean } }
    expect(body.status).toBe('ok')
    expect(body.dbDriver).toBe('pglite')
    expect(body.agentRuntime.piAgentAvailable).toBe(true)
  })

  it('enforces strict tenant isolation between two registered users', async () => {
    const regA = await app.request('/api/v1/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'alice@zhizhi.dev', displayName: 'Alice', password: 'password123' }),
    })
    expect(regA.status).toBe(201)
    const tokenA = ((await regA.json()) as { accessToken: string }).accessToken

    const regB = await app.request('/api/v1/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'bob@zhizhi.dev', displayName: 'Bob', password: 'password123' }),
    })
    expect(regB.status).toBe(201)
    const tokenB = ((await regB.json()) as { accessToken: string }).accessToken

    // Alice saves her pinned slot on chat_qa scene
    const saveRes = await app.request('/api/v1/canvas-state', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${tokenA}` },
      body: JSON.stringify({
        pageScene: 'chat_qa',
        sessionId: 'default',
        slots: [
          {
            slotId: 'slot_a',
            cardType: 'wiki_card_viewer',
            title: 'Alice Private Card',
            isPinned: true,
            payload: {},
            updatedAt: '2026-11-27T00:00:00.000Z',
          },
        ],
      }),
    })
    expect(saveRes.status).toBe(200)

    // Alice reads back her state
    const getA = await app.request('/api/v1/canvas-state?pageScene=chat_qa', {
      headers: { authorization: `Bearer ${tokenA}` },
    })
    const bodyA = (await getA.json()) as { slots: Array<{ title: string }> }
    expect(bodyA.slots).toHaveLength(1)
    expect(bodyA.slots[0]?.title).toBe('Alice Private Card')

    // Bob sees an empty canvas (strict tenant isolation)
    const getB = await app.request('/api/v1/canvas-state?pageScene=chat_qa', {
      headers: { authorization: `Bearer ${tokenB}` },
    })
    const bodyB = (await getB.json()) as { slots: unknown[] }
    expect(bodyB.slots).toEqual([])
  })

  it('streams a full Pi Agent Core turn over SSE on /api/v1/chat/turn', async () => {
    const reg = await app.request('/api/v1/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'charlie@zhizhi.dev', displayName: 'Charlie', password: 'password123' }),
    })
    const token = ((await reg.json()) as { accessToken: string }).accessToken

    const turnRes = await app.request('/api/v1/chat/turn', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({
        pageScene: 'chat_qa',
        message: '给我出一道选择题',
        switches: {
          skillGenCard: false,
          quizTools: { mcq: true, tf: false, blank: false, qa: false },
        },
        pinnedSlotIds: ['slot_a'],
      }),
    })
    expect(turnRes.status).toBe(200)
    const sseBody = await turnRes.text()
    expect(sseBody).toContain('"type":"tool_start"')
    expect(sseBody).toContain('"toolName":"quiz_generate_mcq"')
    expect(sseBody).toContain('"type":"canvas_op"')
    expect(sseBody).toContain('"type":"done"')
  })
})
