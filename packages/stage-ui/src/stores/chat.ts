import type { WebSocketEventInputs } from '@proj-airi/server-sdk'
import type { ChatProvider } from '@xsai-ext/providers/utils'
import type { CommonContentPart, Message, ToolMessage } from '@xsai/shared-chat'

import type { ChatAssistantMessage, ChatSlices, ChatStreamEventContext, StreamingAssistantMessage } from '../types/chat'
import type { StreamEvent, StreamOptions } from './llm'

import { createQueue } from '@proj-airi/stream-kit'
import { defineStore, storeToRefs } from 'pinia'
import { ref, toRaw } from 'vue'

import { useAnalytics } from '../composables'
import { useLlmmarkerParser } from '../composables/llm-marker-parser'
import { categorizeResponse, createStreamingCategorizer } from '../composables/response-categoriser'
import { useChatContextStore } from './chat/context-store'
import { createChatHooks } from './chat/hooks'
import { useInterruptContextStore } from './chat/interrupt-context'
import { useChatSessionStore } from './chat/session-store'
import { useChatStreamStore } from './chat/stream-store'
import { useLLM } from './llm'
import { useConsciousnessStore } from './modules/consciousness'

interface SendOptions {
  model: string
  chatProvider: ChatProvider
  providerConfig?: Record<string, unknown>
  attachments?: { type: 'image', data: string, mimeType: string }[]
  tools?: StreamOptions['tools']
  input?: WebSocketEventInputs
}

interface QueuedSend {
  sendingMessage: string
  options: SendOptions
  generation: number
  sessionId: string
  cancelled?: boolean
  deferred: {
    resolve: () => void
    reject: (error: unknown) => void
  }
}

export const useChatOrchestratorStore = defineStore('chat-orchestrator', () => {
  const llmStore = useLLM()
  const consciousnessStore = useConsciousnessStore()
  const { activeProvider } = storeToRefs(consciousnessStore)
  const { trackFirstMessage } = useAnalytics()

  const chatSession = useChatSessionStore()
  const chatStream = useChatStreamStore()
  const chatContext = useChatContextStore()
  const interruptStore = useInterruptContextStore()
  const { activeSessionId } = storeToRefs(chatSession)
  const { streamingMessage } = storeToRefs(chatStream)

  const sending = ref(false)
  const pendingQueuedSends = ref<QueuedSend[]>([])
  const hooks = createChatHooks()

  // 打断控制相关状态
  const currentAbortController = ref<AbortController | null>(null)
  const lastSendingMessage = ref('')
  const sendStartTime = ref(0)
  const currentBuildingMessage = ref<StreamingAssistantMessage>({ role: 'assistant', content: '', slices: [], tool_results: [], createdAt: Date.now() })

  const sendQueue = createQueue<QueuedSend>({
    handlers: [
      async ({ data }) => {
        const { sendingMessage, options, generation, deferred, sessionId, cancelled } = data

        if (cancelled)
          return

        if (chatSession.getSessionGeneration(sessionId) !== generation) {
          deferred.reject(new Error('Chat session was reset before send could start'))
          return
        }

        try {
          await performSend(sendingMessage, options, generation, sessionId)
          deferred.resolve()
        }
        catch (error) {
          deferred.reject(error)
        }
      },
    ],
  })

  sendQueue.on('enqueue', (queuedSend) => {
    pendingQueuedSends.value = [...pendingQueuedSends.value, queuedSend]
  })

  sendQueue.on('dequeue', (queuedSend) => {
    pendingQueuedSends.value = pendingQueuedSends.value.filter(item => item !== queuedSend)
  })

  /**
   * 辅助函数：截断长文本
   */
  function truncate(text: string, maxLength: number): string {
    if (text.length <= maxLength)
      return text
    return `${text.slice(0, maxLength)}...`
  }

  /**
   * 注入打断上下文到 messages
   * @param messages 原始消息列表
   * @param interrupts 打断记录数组
   * @param newUserMessage 新的用户消息
   * @returns 注入了打断上下文的消息列表
   */
  function injectInterruptContext(
    messages: any[],
    interrupts: ReturnType<typeof interruptStore.getRecentInterrupts>,
    newUserMessage: string,
  ): any[] {
    if (interrupts.length === 0)
      return messages

    // 构建打断历史描述
    const interruptHistory = interrupts.map((record, index) => {
      return `${index + 1}. 用户问："${truncate(record.userMessage, 100)}"，我回答了${record.duration}秒后被打断（部分回答："${truncate(record.partialResponse, 80)}"）`
    }).join('\n')

    // 构建上下文消息
    const contextMessage = {
      role: 'user' as const,
      content: `[Context: 以下是被打断的对话历史，现在用户说"${truncate(newUserMessage, 100)}"，请自然地处理所有相关请求]

${interruptHistory}

[Request interrupted by user]`,
    }

    // 插入到 system 消息之后
    return [
      messages[0], // system prompt
      contextMessage, // 打断上下文
      ...messages.slice(1), // 其余历史消息
    ]
  }

  async function performSend(
    sendingMessage: string,
    options: SendOptions,
    generation: number,
    sessionId: string,
  ) {
    if (!sendingMessage && !options.attachments?.length)
      return

    // ========== 步骤1: 检查并中断之前的生成 ==========
    if (currentAbortController.value) {
      const interruptedDuration = Math.floor((Date.now() - sendStartTime.value) / 1000)

      // 保存打断记录
      interruptStore.saveInterrupt(sessionId, {
        userMessage: lastSendingMessage.value,
        partialResponse: String(currentBuildingMessage.value.content || ''), // 🔴 转换为字符串
        interruptedAt: Date.now(),
        duration: interruptedDuration,
      })

      // 中止之前的请求
      currentAbortController.value.abort()
      currentAbortController.value = null

      console.info(`[Chat] Interrupted previous generation after ${interruptedDuration}s`)
    }

    // 保存当前请求信息（用于下次可能的打断）
    lastSendingMessage.value = sendingMessage
    sendStartTime.value = Date.now()

    // 清理过期的打断记录
    interruptStore.cleanExpired()

    chatSession.ensureSession(sessionId)

    const sendingCreatedAt = Date.now()
    const streamingMessageContext: ChatStreamEventContext = {
      message: { role: 'user', content: sendingMessage, createdAt: sendingCreatedAt },
      contexts: chatContext.getContextsSnapshot(),
      composedMessage: [],
      input: options.input,
    }

    const isStaleGeneration = () => chatSession.getSessionGeneration(sessionId) !== generation
    const shouldAbort = () => isStaleGeneration()

    // 🔴 设置 sending = true 必须在所有可能的 return 之前
    sending.value = true

    try {
      // 检查是否已经过期
      if (shouldAbort())
        return

      const isForegroundSession = () => sessionId === activeSessionId.value

      const buildingMessage: StreamingAssistantMessage = { role: 'assistant', content: '', slices: [], tool_results: [], createdAt: Date.now() }

      const updateUI = () => {
        if (isForegroundSession()) {
          streamingMessage.value = JSON.parse(JSON.stringify(buildingMessage))
        }
        // 同步到全局状态（用于打断记录）
        currentBuildingMessage.value = buildingMessage
      }

      updateUI()
      trackFirstMessage()

      await hooks.emitBeforeMessageComposedHooks(sendingMessage, streamingMessageContext)

      const contentParts: CommonContentPart[] = [{ type: 'text', text: sendingMessage }]

      if (options.attachments) {
        for (const attachment of options.attachments) {
          if (attachment.type === 'image') {
            contentParts.push({
              type: 'image_url',
              image_url: {
                url: `data:${attachment.mimeType};base64,${attachment.data}`,
              },
            })
          }
        }
      }

      const finalContent = contentParts.length > 1 ? contentParts : sendingMessage
      if (!streamingMessageContext.input) {
        streamingMessageContext.input = {
          type: 'input:text',
          data: {
            text: sendingMessage,
          },
        }
      }

      if (shouldAbort())
        return

      const sessionMessagesForSend = chatSession.getSessionMessages(sessionId)
      sessionMessagesForSend.push({ role: 'user', content: finalContent })

      const categorizer = createStreamingCategorizer(activeProvider.value)
      let streamPosition = 0

      const parser = useLlmmarkerParser({
        onLiteral: async (literal) => {
          if (shouldAbort())
            return

          categorizer.consume(literal)

          const speechOnly = categorizer.filterToSpeech(literal, streamPosition)
          streamPosition += literal.length

          if (speechOnly.trim()) {
            buildingMessage.content += speechOnly

            await hooks.emitTokenLiteralHooks(speechOnly, streamingMessageContext)

            const lastSlice = buildingMessage.slices.at(-1)
            if (lastSlice?.type === 'text') {
              lastSlice.text += speechOnly
            }
            else {
              buildingMessage.slices.push({
                type: 'text',
                text: speechOnly,
              })
            }
            updateUI()
          }
        },
        onSpecial: async (special) => {
          if (shouldAbort())
            return

          await hooks.emitTokenSpecialHooks(special, streamingMessageContext)
        },
        onEnd: async (fullText) => {
          if (isStaleGeneration())
            return

          const finalCategorization = categorizeResponse(fullText, activeProvider.value)

          buildingMessage.categorization = {
            speech: finalCategorization.speech,
            reasoning: finalCategorization.reasoning,
          }
          updateUI()
        },
        minLiteralEmitLength: 24,
      })

      const toolCallQueue = createQueue<ChatSlices>({
        handlers: [
          async (ctx) => {
            if (shouldAbort())
              return
            if (ctx.data.type === 'tool-call') {
              buildingMessage.slices.push(ctx.data)
              updateUI()
              return
            }

            if (ctx.data.type === 'tool-call-result') {
              buildingMessage.tool_results.push(ctx.data)
              updateUI()
            }
          },
        ],
      })

      let newMessages = sessionMessagesForSend.map((msg) => {
        const { context: _context, ...withoutContext } = msg
        const rawMessage = toRaw(withoutContext)

        if (rawMessage.role === 'assistant') {
          const { slices: _slices, tool_results, categorization: _categorization, ...rest } = rawMessage as ChatAssistantMessage
          return {
            ...toRaw(rest),
            tool_results: toRaw(tool_results),
          }
        }

        return rawMessage
      })

      const contextsSnapshot = chatContext.getContextsSnapshot()
      if (Object.keys(contextsSnapshot).length > 0) {
        const system = newMessages.slice(0, 1)
        const afterSystem = newMessages.slice(1, newMessages.length)

        newMessages = [
          ...system,
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: ''
                  + 'These are the contextual information retrieved or on-demand updated from other modules, you may use them as context for chat, or reference of the next action, tool call, etc.:\n'
                  + `${Object.entries(contextsSnapshot).map(([key, value]) => `Module ${key}: ${JSON.stringify(value)}`).join('\n')}\n`,
              },
            ],
          },
          ...afterSystem,
        ]
      }

      streamingMessageContext.composedMessage = newMessages as Message[]

      // ========== 步骤2: 检查并注入打断上下文 ==========
      const recentInterrupts = interruptStore.getRecentInterrupts(sessionId)
      if (recentInterrupts.length > 0) {
        newMessages = injectInterruptContext(newMessages, recentInterrupts, sendingMessage)
        // 用完立即清除，避免重复拼接
        interruptStore.clearInterrupts(sessionId)
      }

      await hooks.emitAfterMessageComposedHooks(sendingMessage, streamingMessageContext)
      await hooks.emitBeforeSendHooks(sendingMessage, streamingMessageContext)

      let fullText = ''
      const headers = (options.providerConfig?.headers || {}) as Record<string, string>

      if (shouldAbort())
        return

      // ========== 步骤3: 创建新的 AbortController ==========
      const abortController = new AbortController()
      currentAbortController.value = abortController

      await llmStore.stream(options.model, options.chatProvider, newMessages as Message[], {
        headers,
        tools: options.tools,
        abortSignal: abortController.signal, // 🔴 传递 abort 信号
        onStreamEvent: async (event: StreamEvent) => {
          // 检查是否已中止
          if (abortController.signal.aborted) {
            return
          }

          switch (event.type) {
            case 'tool-call':
              toolCallQueue.enqueue({
                type: 'tool-call',
                toolCall: event,
              })

              break
            case 'tool-result':
              toolCallQueue.enqueue({
                type: 'tool-call-result',
                id: event.toolCallId,
                result: event.result,
              })

              break
            case 'text-delta':
              fullText += event.text
              await parser.consume(event.text)
              break
            case 'finish':
              break
            case 'error':
              throw event.error ?? new Error('Stream error')
          }
        },
      })

      // 成功完成，清除 abort controller
      currentAbortController.value = null

      await parser.end()

      if (!isStaleGeneration() && buildingMessage.slices.length > 0) {
        sessionMessagesForSend.push(toRaw(buildingMessage))
      }

      await hooks.emitStreamEndHooks(streamingMessageContext)
      await hooks.emitAssistantResponseEndHooks(fullText, streamingMessageContext)

      await hooks.emitAfterSendHooks(sendingMessage, streamingMessageContext)
      await hooks.emitAssistantMessageHooks({ ...buildingMessage }, fullText, streamingMessageContext)
      await hooks.emitChatTurnCompleteHooks({
        output: { ...buildingMessage },
        outputText: fullText,
        toolCalls: sessionMessagesForSend.filter(msg => msg.role === 'tool') as ToolMessage[],
      }, streamingMessageContext)

      if (isForegroundSession()) {
        streamingMessage.value = { role: 'assistant', content: '', slices: [], tool_results: [] }
      }
    }
    catch (error) {
      // 如果是用户主动打断，不当作错误处理
      if (error instanceof Error && error.name === 'AbortError') {
        console.info('[Chat] Generation aborted by user')
        return // 静默返回，不抛出错误
      }
      console.error('Error sending message:', error)
      throw error
    }
    finally {
      sending.value = false
      currentAbortController.value = null
    }
  }

  async function ingest(
    sendingMessage: string,
    options: SendOptions,
    targetSessionId?: string,
  ) {
    const sessionId = targetSessionId || activeSessionId.value
    const generation = chatSession.getSessionGeneration(sessionId)

    // 🔴 如果当前正在生成，绕过队列直接执行（触发打断）
    if (currentAbortController.value && sending.value) {
      console.info('[Chat] New message while generating, interrupting immediately')
      try {
        await performSend(sendingMessage, options, generation, sessionId)
      }
      catch (error) {
        // AbortError 是预期的，忽略
        if (error instanceof Error && error.name === 'AbortError') {
          console.info('[Chat] Previous generation was aborted (expected)')
        }
        else {
          console.error('[Chat] Error during interrupt:', error)
          throw error
        }
      }
      return
    }

    // 否则放入队列正常处理
    return new Promise<void>((resolve, reject) => {
      sendQueue.enqueue({
        sendingMessage,
        options,
        generation,
        sessionId,
        deferred: { resolve, reject },
      })
    })
  }

  function cancelPendingSends(sessionId?: string) {
    for (const queued of pendingQueuedSends.value) {
      if (sessionId && queued.sessionId !== sessionId)
        continue

      queued.cancelled = true
      queued.deferred.reject(new Error('Chat session was reset before send could start'))
    }

    pendingQueuedSends.value = sessionId
      ? pendingQueuedSends.value.filter(item => item.sessionId !== sessionId)
      : []
  }

  return {
    sending,

    discoverToolsCompatibility: llmStore.discoverToolsCompatibility,

    ingest,
    cancelPendingSends,

    clearHooks: hooks.clearHooks,

    emitBeforeMessageComposedHooks: hooks.emitBeforeMessageComposedHooks,
    emitAfterMessageComposedHooks: hooks.emitAfterMessageComposedHooks,
    emitBeforeSendHooks: hooks.emitBeforeSendHooks,
    emitAfterSendHooks: hooks.emitAfterSendHooks,
    emitTokenLiteralHooks: hooks.emitTokenLiteralHooks,
    emitTokenSpecialHooks: hooks.emitTokenSpecialHooks,
    emitStreamEndHooks: hooks.emitStreamEndHooks,
    emitAssistantResponseEndHooks: hooks.emitAssistantResponseEndHooks,
    emitAssistantMessageHooks: hooks.emitAssistantMessageHooks,
    emitChatTurnCompleteHooks: hooks.emitChatTurnCompleteHooks,

    onBeforeMessageComposed: hooks.onBeforeMessageComposed,
    onAfterMessageComposed: hooks.onAfterMessageComposed,
    onBeforeSend: hooks.onBeforeSend,
    onAfterSend: hooks.onAfterSend,
    onTokenLiteral: hooks.onTokenLiteral,
    onTokenSpecial: hooks.onTokenSpecial,
    onStreamEnd: hooks.onStreamEnd,
    onAssistantResponseEnd: hooks.onAssistantResponseEnd,
    onAssistantMessage: hooks.onAssistantMessage,
    onChatTurnComplete: hooks.onChatTurnComplete,
  }
})
