import { logger } from './logger'

export type AIResponse = {
  flagged: boolean
  reason: string
}

export interface Message {
  text: string
  messageId?: string
  threadId?: string
  parent?: string
  flagged?: boolean
  reason?: string
}

export interface UserMessage {
  message: Message
  timestamp: number
  username: string
  address?: string
}

export async function callAI(
  prompt: string,
  userInput: string,
  url: string,
  token: string,
  timeout: number,
): Promise<AIResponse> {
  const requestBody = {
    messages: [
      {
        role: 'system',
        content: prompt,
      },
      {
        role: 'user',
        content: `Comment to check: ${userInput}`,
      },
    ],
  }

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeout)

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(requestBody),
    signal: controller.signal,
  })
    .catch((error: any) => {
      logger.error('Error calling AI', error)

      return new Response(null, { status: 408, statusText: 'Request Timeout' })
    })
    .finally(() => clearTimeout(timeoutId))

  if (response.status === 408) {
    logger.error('AI Request timed out')

    return { flagged: false, reason: 'AI Request timed out' }
  }
  let retV: AIResponse = { flagged: false, reason: '' }
  let cleanedResponse = ''
  try {
    const data = await response.json()
    cleanedResponse = data.result.response.replace(/`/g, '')
    retV = JSON.parse(cleanedResponse)
  } catch (error) {
    logger.error(`Error parsing response ${cleanedResponse}`, error)

    return { flagged: false, reason: 'Error parsing response' }
  }

  return retV
}

export async function doFiltering(
  body: Buffer,
  prompt: string,
  APIUrl: string,
  key: string,
  timeout: number,
): Promise<Buffer> {
  const bodyBuffer = Buffer.from(body)
  const userMessage = JSON.parse(bodyBuffer.toString('utf8')) as UserMessage

  if (typeof userMessage.message === 'string') {
    userMessage.message = JSON.parse(userMessage.message) as Message
  }
  let aiResponse: AIResponse = { flagged: false, reason: '' }

  if (userMessage.message.text.trim().length > 0) {
    aiResponse = await callAI(prompt, userMessage.message.text, APIUrl, key, timeout)
    userMessage.message.flagged = aiResponse.flagged
  } else {
    userMessage.message.flagged = false
  }

  if (aiResponse.flagged) {
    logger.info(`flagged: ${userMessage.message.text} -  ${aiResponse.reason}`)
  }

  return Buffer.from(JSON.stringify(userMessage))
}
