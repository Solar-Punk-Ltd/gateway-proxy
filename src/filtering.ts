import { EnvironmentVariables } from './config'
import { logger } from './logger'

export type AIResponse = {
  flagged: boolean
  reason: string
}

export declare enum MessageType {
  TEXT = 'text',
  THREAD = 'thread',
  REACTION = 'reaction',
}

export interface MessageData {
  id: string
  type: MessageType
  message: string
  username: string
  address: string
  timestamp: number
  index: string
  topic: string
  targetMessageId?: string
  signature?: string
  flagged?: boolean
  reason?: string
  isLegacy?: boolean
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
    cleanedResponse = data.result.response.replace(/\n/g, ' ').replace(/`/g, '')
    retV = JSON.parse(cleanedResponse)
  } catch (error) {
    logger.error(`Error parsing response ${cleanedResponse}`, error)

    if (cleanedResponse.match(/"flagged"\s*:\s*true/)) {
      return { flagged: true, reason: 'Error parsing response - flagged: true' }
    }

    return { flagged: false, reason: 'Error parsing response' }
  }

  return retV
}

export function addPoint(userMessage: MessageData) {
  const { DEVCON_BACKEND_URL, DEVCON_BACKEND_API_KEY } = process.env as EnvironmentVariables

  if (DEVCON_BACKEND_URL && DEVCON_BACKEND_API_KEY) {
    fetch(DEVCON_BACKEND_URL + '/addpoints/' + userMessage.username, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${DEVCON_BACKEND_API_KEY}`,
      },
    }).catch((error: any) => {
      logger.error('Error calling backend', error)
    })
  }
}

export async function doFiltering(
  body: Buffer,
  prompt: string,
  APIUrl: string,
  key: string,
  timeout: number,
  threshold: number,
): Promise<Buffer> {
  const bodyBuffer = Buffer.from(body)
  const userMessage = JSON.parse(bodyBuffer.toString('utf8')) as MessageData

  if (typeof userMessage.message === 'string') {
    userMessage.message = JSON.parse(userMessage.message) as string
  }
  let aiResponse: AIResponse = { flagged: false, reason: '' }

  if (userMessage.message.trim().length >= threshold) {
    aiResponse = await callAI(prompt, userMessage.message, APIUrl, key, timeout)
    userMessage.flagged = aiResponse.flagged

    if (!aiResponse.flagged) {
      addPoint(userMessage)
    }
  } else {
    userMessage.flagged = false
    logger.info(`skipped: ${userMessage.message} - too short`)
  }

  if (aiResponse.flagged) {
    logger.info(`flagged: ${userMessage.message} -  ${aiResponse.reason}`)
  }

  return Buffer.from(JSON.stringify(userMessage))
}
