import { describe, expect, it } from 'vitest'
import { pooled } from '../src/concurrency.js'

describe('pooled', () => {
  it('runs all tasks and returns results in input order', async () => {
    const results = await pooled(
      [
        async () => 'a',
        async () => 'b',
        async () => 'c',
      ],
      2,
    )
    expect(results).toHaveLength(3)
    expect(results[0]).toEqual({ status: 'fulfilled', value: 'a' })
    expect(results[1]).toEqual({ status: 'fulfilled', value: 'b' })
    expect(results[2]).toEqual({ status: 'fulfilled', value: 'c' })
  })

  it('captures rejections without aborting other tasks', async () => {
    const results = await pooled(
      [
        async () => 1,
        async () => { throw new Error('boom') },
        async () => 3,
      ],
      3,
    )
    expect(results[0]).toEqual({ status: 'fulfilled', value: 1 })
    expect(results[1]).toMatchObject({ status: 'rejected' })
    expect((results[1] as PromiseRejectedResult).reason).toBeInstanceOf(Error)
    expect(results[2]).toEqual({ status: 'fulfilled', value: 3 })
  })

  it('respects the concurrency limit', async () => {
    let active = 0
    let peak = 0
    const tasks = Array.from({ length: 6 }, () => async () => {
      active++
      peak = Math.max(peak, active)
      await new Promise<void>((resolve) => setImmediate(resolve))
      active--
    })
    await pooled(tasks, 2)
    expect(peak).toBeLessThanOrEqual(2)
  })

  it('handles an empty task list', async () => {
    const results = await pooled([], 3)
    expect(results).toHaveLength(0)
  })

  it('treats limit <= 0 as 1', async () => {
    const order: number[] = []
    const tasks = [
      async () => { order.push(1) },
      async () => { order.push(2) },
    ]
    await pooled(tasks, 0)
    expect(order).toEqual([1, 2])
  })
})
