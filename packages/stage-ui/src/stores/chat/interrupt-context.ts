import { nanoid } from 'nanoid'
import { defineStore } from 'pinia'
import { ref } from 'vue'

/**
 * 打断记录结构
 */
export interface InterruptRecord {
  id: string
  userMessage: string // 用户的原始问题："你好你叫什么"
  partialResponse: string // LLM 的部分回答："你好！我是..."
  interruptedAt: number // 被打断时的时间戳
  duration: number // 生成了多少秒
}

/**
 * Session 级别的打断记录集合
 */
interface SessionInterrupts {
  [sessionId: string]: InterruptRecord[]
}

/**
 * 打断上下文存储
 *
 * 用于记录和管理 LLM 生成过程中的用户打断行为：
 * - 支持多次打断合并（20秒内的所有打断）
 * - Session 隔离（不同会话的打断记录互不影响）
 * - 自动过期清理（超过20秒的记录自动清除）
 */
export const useInterruptContextStore = defineStore('interrupt-context', () => {
  const interrupts = ref<SessionInterrupts>({})
  const EXPIRY_MS = 20 * 1000 // 20秒过期时间

  /**
   * 保存打断记录
   * @param sessionId 会话ID
   * @param record 打断记录（不含id）
   */
  function saveInterrupt(sessionId: string, record: Omit<InterruptRecord, 'id'>) {
    if (!interrupts.value[sessionId]) {
      interrupts.value[sessionId] = []
    }

    const interruptRecord: InterruptRecord = {
      id: nanoid(),
      ...record,
    }

    interrupts.value[sessionId].push(interruptRecord)
    console.info('[InterruptContext] Saved interrupt:', {
      sessionId,
      userMessage: record.userMessage.slice(0, 50),
      duration: record.duration,
      totalRecords: interrupts.value[sessionId].length,
    })
  }

  /**
   * 获取20秒内的所有打断记录
   * @param sessionId 会话ID
   * @returns 按时间排序的打断记录数组（从旧到新）
   */
  function getRecentInterrupts(sessionId: string): InterruptRecord[] {
    const now = Date.now()
    const records = interrupts.value[sessionId] || []

    // 过滤出20秒内的记录
    const recent = records.filter(r => (now - r.interruptedAt) < EXPIRY_MS)

    // 按时间排序（从旧到新）
    const sorted = recent.sort((a, b) => a.interruptedAt - b.interruptedAt)

    if (sorted.length > 0) {
      console.info('[InterruptContext] Found recent interrupts:', {
        sessionId,
        count: sorted.length,
        messages: sorted.map(r => r.userMessage.slice(0, 30)),
      })
    }

    return sorted
  }

  /**
   * 清空指定会话的所有打断记录
   * @param sessionId 会话ID
   */
  function clearInterrupts(sessionId: string) {
    const count = interrupts.value[sessionId]?.length || 0
    delete interrupts.value[sessionId]
    console.info('[InterruptContext] Cleared interrupts:', { sessionId, count })
  }

  /**
   * 自动清理所有会话中过期的打断记录
   * 用于节省内存，可在每次检查时调用
   */
  function cleanExpired() {
    const now = Date.now()
    let totalCleaned = 0

    for (const sessionId in interrupts.value) {
      const before = interrupts.value[sessionId].length
      interrupts.value[sessionId] = interrupts.value[sessionId].filter(
        r => (now - r.interruptedAt) < EXPIRY_MS,
      )
      const after = interrupts.value[sessionId].length
      totalCleaned += (before - after)

      // 如果session没有记录了，删除整个session
      if (interrupts.value[sessionId].length === 0) {
        delete interrupts.value[sessionId]
      }
    }

    if (totalCleaned > 0) {
      console.info('[InterruptContext] Cleaned expired records:', totalCleaned)
    }
  }

  /**
   * 获取所有会话的打断记录统计（调试用）
   */
  function getStats() {
    const stats: Record<string, number> = {}
    for (const sessionId in interrupts.value) {
      stats[sessionId] = interrupts.value[sessionId].length
    }
    return stats
  }

  return {
    saveInterrupt,
    getRecentInterrupts,
    clearInterrupts,
    cleanExpired,
    getStats,
  }
})
