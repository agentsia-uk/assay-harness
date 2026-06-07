/**
 * Run an array of async tasks with a bounded concurrency limit.
 * Returns results in input order (same semantics as Promise.allSettled).
 */
export async function pooled<T>(
  tasks: (() => Promise<T>)[],
  limit: number,
): Promise<PromiseSettledResult<T>[]> {
  const results: PromiseSettledResult<T>[] = new Array(tasks.length)
  let next = 0

  async function worker(): Promise<void> {
    while (next < tasks.length) {
      const index = next++
      const task = tasks[index]
      if (!task) continue
      try {
        results[index] = { status: 'fulfilled', value: await task() }
      } catch (err) {
        results[index] = { status: 'rejected', reason: err }
      }
    }
  }

  const workers = Array.from({ length: Math.max(1, limit) }, () => worker())
  await Promise.all(workers)
  return results
}
