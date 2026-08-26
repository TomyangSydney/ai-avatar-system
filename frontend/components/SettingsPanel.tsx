'use client'

import { useState } from 'react'
import { Save, Loader2, User, KeyRound, Trash2 } from 'lucide-react'
import { toast } from 'react-hot-toast'
import { api } from '@/lib/api'
import { useStore } from '@/store/useStore'
import type { ApiError } from '@/lib/types'

export function SettingsPanel() {
  const { user, setAuth, token, clearAuth } = useStore()
  const [fullName, setFullName] = useState(user?.full_name || '')
  const [username, setUsername] = useState(user?.username || '')
  const [email, setEmail] = useState(user?.email || '')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [savingProfile, setSavingProfile] = useState(false)
  const [savingPassword, setSavingPassword] = useState(false)

  const isGuest = token === 'guest' || user?.id === 'demo-user'

  const saveProfile = async () => {
    if (isGuest) {
      toast.error('请登录真实账号后再编辑个人资料')
      return
    }
    setSavingProfile(true)
    try {
      const update: Record<string, string> = {}
      if (fullName !== (user?.full_name || '')) update.full_name = fullName
      if (username && username !== user?.username) update.username = username
      if (email && email !== user?.email) update.email = email
      if (Object.keys(update).length === 0) {
        toast('没有需要更新的内容', { icon: 'ℹ️' })
        return
      }
      const updated = await api.updateProfile(update)
      if (token) setAuth(token, updated)
      toast.success('个人资料已更新')
    } catch (err: unknown) {
      toast.error((err as ApiError)?.response?.data?.detail || '保存个人资料失败')
    } finally {
      setSavingProfile(false)
    }
  }

  const changePassword = async () => {
    if (isGuest) {
      toast.error('请登录真实账号后再修改密码')
      return
    }
    if (newPassword.length < 8) {
      toast.error('密码至少需要 8 个字符')
      return
    }
    if (newPassword !== confirmPassword) {
      toast.error('两次输入的密码不一致')
      return
    }
    setSavingPassword(true)
    try {
      await api.updateProfile({ password: newPassword })
      setNewPassword('')
      setConfirmPassword('')
      toast.success('密码已更新')
    } catch (err: unknown) {
      toast.error((err as ApiError)?.response?.data?.detail || '修改密码失败')
    } finally {
      setSavingPassword(false)
    }
  }

  return (
    <div className="max-w-3xl mx-auto px-6 py-10 animate-fade-in">
      <div className="mb-8">
        <h1 className="text-3xl font-black gradient-text mb-2">设置</h1>
        <p className="text-gray-400">管理你的账号和偏好设置。</p>
      </div>

      {isGuest && (
        <div className="card-glow mb-6 flex items-start gap-3">
          <User size={16} className="text-amber-400 mt-0.5 flex-shrink-0" />
          <div>
            <p className="text-sm text-white font-semibold">你当前以游客身份登录。</p>
            <p className="text-xs text-gray-400 mt-1">退出登录并注册一个账号，即可保存个人资料并使用多设备同步。</p>
          </div>
        </div>
      )}

      {/* Profile card */}
      <div className="card flex flex-col gap-5">
        <div className="flex items-center gap-2">
          <User size={16} className="text-primary-400" />
          <h2 className="text-xl font-bold text-white">个人资料</h2>
        </div>
        <div className="divider" />
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-gray-300">姓名</label>
            <input
              type="text"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              className="input-field"
              placeholder="你的姓名"
              disabled={isGuest}
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-gray-300">用户名</label>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="input-field"
              placeholder="用户名"
              disabled={isGuest}
            />
          </div>
          <div className="space-y-1.5 md:col-span-2">
            <label className="text-sm font-medium text-gray-300">邮箱</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="input-field"
              placeholder="you@example.com"
              disabled={isGuest}
            />
          </div>
        </div>
        <button
          onClick={saveProfile}
          disabled={savingProfile || isGuest}
          className="btn-primary w-full md:w-auto md:self-end"
        >
          {savingProfile ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />}
          保存修改
        </button>
      </div>

      {/* Password card */}
      <div className="card flex flex-col gap-5 mt-6">
        <div className="flex items-center gap-2">
          <KeyRound size={16} className="text-primary-400" />
          <h2 className="text-xl font-bold text-white">密码</h2>
        </div>
        <div className="divider" />
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-gray-300">新密码</label>
            <input
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              className="input-field"
              placeholder="至少 8 个字符"
              disabled={isGuest}
              autoComplete="new-password"
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-gray-300">确认新密码</label>
            <input
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              className="input-field"
              placeholder="再次输入密码"
              disabled={isGuest}
              autoComplete="new-password"
            />
          </div>
        </div>
        <button
          onClick={changePassword}
          disabled={savingPassword || isGuest || !newPassword || !confirmPassword}
          className="btn-primary w-full md:w-auto md:self-end"
        >
          {savingPassword ? <Loader2 size={15} className="animate-spin" /> : <KeyRound size={15} />}
          更新密码
        </button>
      </div>

      {/* Danger zone */}
      <div className="card flex flex-col gap-5 mt-6 border border-red-500/20">
        <div className="flex items-center gap-2">
          <Trash2 size={16} className="text-red-400" />
          <h2 className="text-xl font-bold text-white">危险操作区</h2>
        </div>
        <div className="divider" />
        <p className="text-sm text-gray-400">
          退出当前设备上的登录。你的数字人、声音和对话记录仍会保留在服务器上。
        </p>
        <button
          onClick={() => {
            api.logout()
            clearAuth()
            toast('已退出登录', { icon: '👋' })
          }}
          className="btn-secondary w-full md:w-auto md:self-end"
        >
          退出登录
        </button>
      </div>
    </div>
  )
}
