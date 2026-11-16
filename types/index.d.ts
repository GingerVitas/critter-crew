export type Species = 'blob' | 'cat' | 'bunny' | 'frog' | 'owl' | 'octo'

export type Critter = {
  id: string
  name: string
  species: Species
  hue: number
  description: string
  type: string
  status: 'pending' | 'running' | 'waiting' | 'idle' | 'completed' | 'failed' | 'killed'
  tools: number
  lastTool?: string
  startedAt: number
  endedAt?: number
}

export type ToolCallLog = {
  id: string
  tool: string
  detail: string
  status: 'running' | 'ok' | 'error' | 'denied'
  at: number
  ms?: number
}

declare module 'claude-code' {
  interface PluginState {
    'critter-crew': {
      crew: Shaped<Critter[]>
      now: number
      models: Record<string, string>
      calls: Shaped<Record<string, ToolCallLog[]>>
      opened: string[]
    }
  }
}
