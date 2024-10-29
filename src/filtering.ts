export type AIResponse = {
  flagged: boolean
  reason: string
}

export interface Message {
  text: string
  threadId: string
  messageId: string
  parent: string | null
  flagged?: boolean
  reason?: string
}

export interface UserMessage {
  message: Message
  timestamp: number
  username: string
  address: string
}
export async function callAI(prompt: string, userInput: string, url: string, token: string): Promise<AIResponse> {
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
  const timeoutId = setTimeout(() => controller.abort(), 3000)

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
      //console.log(error)

      return new Response(null, { status: 408, statusText: 'Request Timeout' })
    })
    .finally(() => clearTimeout(timeoutId))

  if (response.status === 408) {
    return { flagged: false, reason: 'Request timed out' }
  }
  let retV: AIResponse = { flagged: false, reason: '' }
  try {
    const data = await response.json()
    const cleanedResponse = data.result.response.replace(/```/g, '')
    retV = JSON.parse(cleanedResponse)
  } catch (error) {
    //console.log(error)

    return { flagged: false, reason: 'Error parsing response' }
  }

  return retV
}
