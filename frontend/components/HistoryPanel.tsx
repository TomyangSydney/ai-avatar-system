'use client'

import { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Clock, MessageCircle, Trash2, Play, RefreshCw, Search, Loader2,
  Download, Pencil, Check, X, Sparkles,
} from 'lucide-react'
import { toast } from 'react-hot-toast'
import { api } from '@/lib/api'
import type { ChatMessage, SessionSummary, Avatar } from '@/lib/types'

interface HistoryPanelProps {
  /** Called when the user clicks "Open" — receives the avatar to resume against. */
  onResume: (avatarId: string, sessionId: string) => void
}

interface ConversationSummary {
  id: string
  session_id: string
  title: string | null
  summary?: string | null
  message_count: number
  created_at: string
}

function timeAgo(iso: string): string {
  const then = new Date(iso).getTime()
  const diffSec = Math.max(0, Math.floor((Date.now() - then) / 1000))
  if (diffSec < 60) return `${diffSec} 秒前`
  const m = Math.floor(diffSec / 60)
  if (m < 60) return `${m} 分钟前`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} 小时前`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d} 天前`
  return new Date(iso).toLocaleDateString()
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

export function HistoryPanel({ onResume }: HistoryPanelProps) {
  const queryClient = useQueryClient()
  const [query, setQuery] = useState('')
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [messagesById, setMessagesById] = useState<Record<string, ChatMessage[]>>({})
  const [loadingMessagesId, setLoadingMessagesId] = useState<string | null>(null)
  const [renameTarget, setRenameTarget] = useState<{ convId: string; sessionId: string } | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [summarizingId, setSummarizingId] = useState<string | null>(null)

  const { data: sessions, isLoading, refetch } = useQuery<SessionSummary[]>({
    queryKey: ['sessions'],
    queryFn: api.getSessions,
    refetchOnWindowFocus: false,
  })

  const { data: avatars } = useQuery<Avatar[]>({
    queryKey: ['avatars'],
    queryFn: api.getAvatars,
    refetchOnWindowFocus: false,
  })

  const { data: conversations } = useQuery<ConversationSummary[]>({
    queryKey: ['conversations'],
    queryFn: api.listConversations,
    refetchOnWindowFocus: false,
  })

  const avatarMap = useMemo(() => {
    const m: Record<string, Avatar> = {}
    for (const a of avatars || []) m[a.id] = a
    return m
  }, [avatars])

  const convoBySession = useMemo(() => {
    const m: Record<string, ConversationSummary> = {}
    for (const c of conversations || []) {
      // If a session has multiple conversations, keep the most recent (first because backend sorts desc)
      if (!m[c.session_id]) m[c.session_id] = c
    }
    return m
  }, [conversations])

  const filtered = useMemo(() => {
    const list = sessions || []
    if (!query.trim()) return list
    const q = query.toLowerCase()
    return list.filter(s => {
      const av = avatarMap[s.avatar_id]
      const convo = convoBySession[s.id]
      const hay = `${av?.name || ''} ${convo?.title || ''} ${s.id}`.toLowerCase()
      return hay.includes(q)
    })
  }, [sessions, avatarMap, convoBySession, query])

  const toggleExpand = async (sessionId: string) => {
    if (expandedId === sessionId) {
      setExpandedId(null)
      return
    }
    setExpandedId(sessionId)
    if (!messagesById[sessionId]) {
      setLoadingMessagesId(sessionId)
      try {
        const msgs = await api.getMessages(sessionId)
        setMessagesById(prev => ({ ...prev, [sessionId]: msgs }))
      } catch {
        toast.error('无法加载消息')
      } finally {
        setLoadingMessagesId(null)
      }
    }
  }

  const handleDelete = async (sessionId: string) => {
    if (!window.confirm('确定删除此对话？此操作无法撤销。')) return
    setBusy(sessionId)
    try {
      await api.deleteSession(sessionId)
      toast.success('对话已删除')
      setMessagesById(prev => {
        const next = { ...prev }
        delete next[sessionId]
        return next
      })
      if (expandedId === sessionId) setExpandedId(null)
      queryClient.invalidateQueries({ queryKey: ['sessions'] })
      queryClient.invalidateQueries({ queryKey: ['conversations'] })
    } catch {
      toast.error('无法删除对话')
    } finally {
      setBusy(null)
    }
  }

  const handleExport = async (sessionId: string) => {
    setBusy(sessionId)
    try {
      const blob = await api.exportSession(sessionId)
      downloadBlob(blob, `session-${sessionId.slice(0, 8)}.json`)
      toast.success('已导出')
    } catch {
      toast.error('无法导出对话')
    } finally {
      setBusy(null)
    }
  }

  const handleSummarize = async (convId: string) => {
    setSummarizingId(convId)
    try {
      await api.summarizeConversation(convId)
      toast.success('摘要已生成', { icon: '✨' })
      queryClient.invalidateQueries({ queryKey: ['conversations'] })
    } catch {
      toast.error('无法生成摘要 — 后端或 LLM 不可用')
    } finally {
      setSummarizingId(null)
    }
  }

  const handleStartRename = (convId: string, sessionId: string, currentTitle: string | null) => {
    setRenameTarget({ convId, sessionId })
    setRenameValue(currentTitle || '')
  }

  const handleSaveRename = async () => {
    if (!renameTarget) return
    const title = renameValue.trim()
    if (!title) {
      toast.error('标题不能为空')
      return
    }
    setBusy(renameTarget.sessionId)
    try {
      await api.renameConversation(renameTarget.convId, title)
      toast.success('已重命名')
      setRenameTarget(null)
      setRenameValue('')
      queryClient.invalidateQueries({ queryKey: ['conversations'] })
    } catch {
      toast.error('无法重命名')
    } finally {
      setBusy(null)
    }
  }

  // Periodically refresh
  useEffect(() => {
    const t = setInterval(() => refetch(), 30000)
    return () => clearInterval(t)
  }, [refetch])

  return (
    <div className="max-w-4xl mx-auto px-6 py-10 animate-fade-in">
      <div className="mb-8 flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-3xl font-black gradient-text mb-2">对话历史</h1>
          <p className="text-gray-400">重新打开、查看、导出并清理您过去的会话。</p>
        </div>
        <button onClick={() => refetch()} className="btn-icon" title="刷新" aria-label="刷新">
          <RefreshCw size={15} />
        </button>
      </div>

      <div className="relative mb-6">
        <Search size={15} className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-500" />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="按数字人名称、对话标题或会话 ID 搜索…"
          className="input-field pl-11"
          aria-label="搜索对话"
        />
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 size={28} className="animate-spin text-primary-400" />
        </div>
      ) : filtered.length === 0 ? (
        <div className="card flex flex-col items-center justify-center py-16 gap-4 text-center">
          <div className="w-16 h-16 rounded-2xl bg-surface-700/80 flex items-center justify-center border border-white/8">
            <MessageCircle size={28} className="text-gray-500" />
          </div>
          <div>
            <p className="text-white font-medium">暂无对话记录</p>
            <p className="text-gray-500 text-sm mt-1">
              {query ? '没有匹配的搜索结果。' : '与数字人开始聊天后，对话会显示在这里。'}
            </p>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map((s) => {
            const av = avatarMap[s.avatar_id]
            const convo = convoBySession[s.id]
            const isExpanded = expandedId === s.id
            const msgs = messagesById[s.id]
            const isRenaming = renameTarget?.sessionId === s.id
            const isBusy = busy === s.id
            const title = convo?.title || av?.name || '未命名对话'
            return (
              <div key={s.id} className="glass-card rounded-2xl overflow-hidden border border-white/8">
                <div className="flex items-center gap-4 px-5 py-4">
                  <div className="w-12 h-12 rounded-xl overflow-hidden bg-surface-700 flex-shrink-0 flex items-center justify-center">
                    {av?.thumbnail_url || av?.image_url ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={av.thumbnail_url || av.image_url}
                        alt={av.name}
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      <MessageCircle size={20} className="text-gray-500" />
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    {isRenaming ? (
                      <div className="flex items-center gap-2">
                        <input
                          autoFocus
                          type="text"
                          value={renameValue}
                          onChange={(e) => setRenameValue(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') handleSaveRename()
                            if (e.key === 'Escape') { setRenameTarget(null); setRenameValue('') }
                          }}
                          maxLength={200}
                          className="input-field py-1.5 text-sm"
                          aria-label="对话标题"
                        />
                        <button
                          onClick={handleSaveRename}
                          className="btn-icon text-green-400"
                          aria-label="保存标题"
                          disabled={isBusy}
                        >
                          {isBusy ? <Loader2 size={13} className="animate-spin" /> : <Check size={14} />}
                        </button>
                        <button
                          onClick={() => { setRenameTarget(null); setRenameValue('') }}
                          className="btn-icon"
                          aria-label="取消重命名"
                        >
                          <X size={14} />
                        </button>
                      </div>
                    ) : (
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-semibold text-white truncate">{title}</span>
                        <span className={`badge text-xs ${
                          s.status === 'active' ? 'badge-green' :
                          s.status === 'paused' ? 'badge-amber' :
                          'badge-gray'
                        }`}>
                          {s.status === 'active' ? '活跃' : s.status === 'paused' ? '已暂停' : s.status}
                        </span>
                      </div>
                    )}
                    <div className="flex items-center gap-2 mt-1 text-xs text-gray-500">
                      <Clock size={11} />
                      <span>{timeAgo(s.started_at)}</span>
                      {av && <><span>·</span><span>{av.name}</span></>}
                      {convo && <><span>·</span><span>{convo.message_count} 条消息</span></>}
                      <span>·</span>
                      <span className="font-mono">{s.id.slice(0, 8)}</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 flex-shrink-0">
                    {convo && !isRenaming && (
                      <button
                        onClick={() => handleStartRename(convo.id, s.id, convo.title)}
                        className="btn-icon"
                        title="重命名对话"
                        aria-label="重命名对话"
                      >
                        <Pencil size={13} />
                      </button>
                    )}
                    {convo && !isRenaming && (
                      <button
                        onClick={() => handleSummarize(convo.id)}
                        className="btn-icon"
                        title={convo.summary ? '重新生成 AI 摘要' : '生成 AI 摘要'}
                        aria-label="使用 AI 生成对话摘要"
                        disabled={summarizingId === convo.id}
                      >
                        {summarizingId === convo.id ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
                      </button>
                    )}
                    <button
                      onClick={() => handleExport(s.id)}
                      className="btn-icon"
                      title="导出为 JSON"
                      aria-label="导出对话"
                      disabled={isBusy}
                    >
                      {isBusy ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
                    </button>
                    <button
                      onClick={() => toggleExpand(s.id)}
                      className="btn-icon"
                      title="预览消息"
                      aria-label="切换消息预览"
                      aria-expanded={isExpanded}
                    >
                      {loadingMessagesId === s.id ? <Loader2 size={13} className="animate-spin" /> : <MessageCircle size={13} />}
                    </button>
                    {av && (
                      <button
                        onClick={() => onResume(s.avatar_id, s.id)}
                        className="btn-primary text-xs px-3 py-1.5 rounded-lg"
                        title="在聊天中打开"
                      >
                        <Play size={12} />
                        打开
                      </button>
                    )}
                    <button
                      onClick={() => handleDelete(s.id)}
                      className="btn-icon text-gray-500 hover:text-red-400"
                      title="删除对话"
                      aria-label="删除对话"
                      disabled={isBusy}
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>

                {convo?.summary && !isExpanded && (
                  <div className="border-t border-white/8 px-5 py-3 bg-primary-500/5 flex items-start gap-2">
                    <Sparkles size={12} className="text-primary-400 mt-0.5 flex-shrink-0" />
                    <p className="text-xs text-gray-300 leading-relaxed">{convo.summary}</p>
                  </div>
                )}
                {isExpanded && (
                  <div className="border-t border-white/8 px-5 py-4 bg-surface-800/40">
                    {convo?.summary && (
                      <div className="mb-3 flex items-start gap-2 px-3 py-2 rounded-lg bg-primary-500/10 border border-primary-500/20">
                        <Sparkles size={12} className="text-primary-400 mt-0.5 flex-shrink-0" />
                        <p className="text-xs text-gray-300 leading-relaxed">{convo.summary}</p>
                      </div>
                    )}
                    {!msgs ? (
                      <p className="text-sm text-gray-500">加载中…</p>
                    ) : msgs.length === 0 ? (
                      <p className="text-sm text-gray-500">此会话暂无消息。</p>
                    ) : (
                      <div className="space-y-2 max-h-72 overflow-y-auto messages-scroll">
                        {msgs.map((m) => (
                          <div key={m.id} className="flex gap-2 text-sm">
                            <span className={`font-mono text-xs px-1.5 py-0.5 rounded ${
                              m.role === 'user' ? 'bg-accent-700/40 text-accent-200' : 'bg-primary-700/40 text-primary-200'
                            }`}>
                              {m.role === 'user' ? '我' : 'AI'}
                            </span>
                            <span className="text-gray-200 flex-1 leading-relaxed whitespace-pre-wrap">{m.content}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
