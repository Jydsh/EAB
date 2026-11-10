import { afterEach, describe, expect, it, vi } from 'vitest'
import { refreshDingTalkUserAvatar } from '../src/dingtalk-avatar.js'

interface FakeUser {
  avatar: string | null
}

function fakeDb(user: FakeUser) {
  const updates: Array<string> = []
  const db = {
    prepare(sql: string) {
      if (sql.includes('SELECT avatar FROM users')) {
        return { get: () => user }
      }
      if (sql.includes('SELECT external_user_id')) {
        return { get: () => ({ external_user_id: 'ext-1' }) }
      }
      if (sql.includes('SELECT app_id, secret_ref')) {
        return { get: () => ({ app_id: 'app-1', secret_ref: 'EAB_TEST_AVATAR_SECRET' }) }
      }
      if (sql.includes('UPDATE users SET avatar')) {
        return {
          run: (avatar: string) => {
            updates.push(avatar)
            user.avatar = avatar
          },
        }
      }
      throw new Error(`unexpected SQL: ${sql}`)
    },
  }
  return { db, updates }
}

afterEach(() => {
  vi.unstubAllGlobals()
  delete process.env.EAB_TEST_AVATAR_SECRET
})

describe('钉钉头像实时刷新', () => {
  it('库里已有旧头像时，登录刷新仍会拉新地址并落库', async () => {
    process.env.EAB_TEST_AVATAR_SECRET = 'secret'
    const { db, updates } = fakeDb({ avatar: 'https://old.example.com/a.jpg' })
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        const url = String(input)
        if (url.includes('/oauth2/accessToken')) {
          return new Response(JSON.stringify({ accessToken: 'token-1' }), { status: 200 })
        }
        return new Response(
          JSON.stringify({ errcode: 0, result: { avatar: 'https://new.example.com/b.jpg' } }),
          { status: 200 },
        )
      }),
    )

    const next = await refreshDingTalkUserAvatar(db as any, 'D:/tmp/eab.db', 'c1', 'u1')

    expect(next).toBe('https://new.example.com/b.jpg')
    expect(updates).toEqual(['https://new.example.com/b.jpg'])
  })

  it('钉钉接口失败时保留旧头像，不写空值', async () => {
    process.env.EAB_TEST_AVATAR_SECRET = 'secret'
    const { db, updates } = fakeDb({ avatar: 'https://old.example.com/a.jpg' })
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        const url = String(input)
        if (url.includes('/oauth2/accessToken')) {
          return new Response(JSON.stringify({ accessToken: 'token-1' }), { status: 200 })
        }
        throw new Error('network down')
      }),
    )

    const next = await refreshDingTalkUserAvatar(db as any, 'D:/tmp/eab.db', 'c1', 'u1')

    expect(next).toBe('https://old.example.com/a.jpg')
    expect(updates).toEqual([])
  })

  it('钉钉确认没有自定义头像时写空字符串，清掉旧地址', async () => {
    process.env.EAB_TEST_AVATAR_SECRET = 'secret'
    const { db, updates } = fakeDb({ avatar: 'https://old.example.com/a.jpg' })
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        const url = String(input)
        if (url.includes('/oauth2/accessToken')) {
          return new Response(JSON.stringify({ accessToken: 'token-1' }), { status: 200 })
        }
        return new Response(JSON.stringify({ errcode: 0, result: {} }), { status: 200 })
      }),
    )

    const next = await refreshDingTalkUserAvatar(db as any, 'D:/tmp/eab.db', 'c1', 'u1')

    expect(next).toBe('')
    expect(updates).toEqual([''])
  })
})
