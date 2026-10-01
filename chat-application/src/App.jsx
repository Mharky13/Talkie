import { useEffect, useRef, useState } from 'react'
import {
  ArrowDown, ChevronDown, ChevronRight, Compass, Expand, Hash, Headphones,
  ImagePlus, Mic, MicOff, MessageCircle, MessageSquare, MoreHorizontal, Moon, Phone, PhoneOff, Plus, Search, Send,
  Minimize2, Settings, Smile, Sparkles, Sun, Users, Video, VideoOff, Volume2, VolumeX, X,
} from 'lucide-react'
import { BrowserRouter, Link, NavLink, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { DirectMessagesPage, DiscoverPage, FriendsPage, LoginPage, RegisterPage, SettingsPage } from './pages/CommunityPages.jsx'
import './App.css'

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8001'

const authHeaders = () => ({ Authorization: `Bearer ${sessionStorage.getItem('talkie-token') ?? ''}` })

function readSessionUser() {
  try {
    return JSON.parse(sessionStorage.getItem('talkie-user') ?? '{}')
  } catch {
    return {}
  }
}

function Avatar({ image, initials, className, showPresence = false }) {
  return <span className={`avatar ${className}`}>{image ? <img src={image} alt="" /> : initials}{showPresence && <span className="presence" />}</span>
}

function AppLoader() {
  return (
    <div className="app-loader" aria-live="polite" aria-label="Loading Talkie">
      <div className="loader-logo"><MessageCircle size={28} strokeWidth={2.6} /></div>
      <div className="loader-badge">TALKIE</div>
      <div className="loader-ring" aria-hidden="true" />
      <p>Loading your workspace...</p>
    </div>
  )
}

function ChatWorkspace({ theme, setTheme }) {
  const location = useLocation()
  const navigate = useNavigate()
  const requestedPage = location.pathname.split('/')[1] || 'chat'
  const page = ['chat', 'messages', 'friends', 'discover', 'settings'].includes(requestedPage) ? requestedPage : 'chat'
  const selectedFriendId = page === 'messages' ? location.pathname.split('/')[2] : undefined
  const [workspaces, setWorkspaces] = useState([])
  const [activeWorkspaceId, setActiveWorkspaceId] = useState('')
  const [activeChannelId, setActiveChannelId] = useState('')
  const [messagesByChannel, setMessagesByChannel] = useState({})
  const [draft, setDraft] = useState('')
  const [search, setSearch] = useState('')
  const [showMembers, setShowMembers] = useState(true)
  const [apiConnected, setApiConnected] = useState(false)
  const [mobileChannelsOpen, setMobileChannelsOpen] = useState(false)
  const [currentUser, setCurrentUser] = useState(readSessionUser)
  const [incomingFriendCount, setIncomingFriendCount] = useState(0)
  const channelSocketRef = useRef(null)
  const peerConnectionRef = useRef(null)
  const callStateRef = useRef(null)
  const localStreamRef = useRef(null)
  const pendingCandidatesRef = useRef([])
  const [callState, setCallState] = useState(null)
  const [callMinimized, setCallMinimized] = useState(false)
  const [callFullscreen, setCallFullscreen] = useState(false)
  const [localStream, setLocalStream] = useState(null)
  const [remoteStream, setRemoteStream] = useState(null)
  const [muted, setMuted] = useState(false)
  const [deafened, setDeafened] = useState(false)
  const [cameraEnabled, setCameraEnabled] = useState(true)
  const [callError, setCallError] = useState('')
  const activeWorkspace = workspaces.find((workspace) => workspace.id === activeWorkspaceId) ?? workspaces[0]
  const activeChannel = activeWorkspace?.channels.find((channel) => channel.id === activeChannelId) ?? activeWorkspace?.channels[0]
  const channelMessages = messagesByChannel[activeChannelId] ?? []
  const visibleMessages = channelMessages.filter((message) =>
    `${message.author} ${message.text}`.toLowerCase().includes(search.toLowerCase()),
  )

  useEffect(() => {
    if (!sessionStorage.getItem('talkie-token')) return undefined
    let active = true
    const refreshRequests = async () => {
      try {
        const response = await fetch(`${API_URL}/api/friends`, { headers: authHeaders() })
        if (!response.ok) return
        const result = await response.json()
        if (active) setIncomingFriendCount(result.incoming.length)
      } catch {
        if (active) setIncomingFriendCount(0)
      }
    }
    refreshRequests()
    const intervalId = window.setInterval(refreshRequests, 15_000)
    window.addEventListener('focus', refreshRequests)
    return () => {
      active = false
      window.clearInterval(intervalId)
      window.removeEventListener('focus', refreshRequests)
    }
  }, [])

  function updateCallState(nextState) {
    callStateRef.current = nextState
    setCallState(nextState)
  }

  function sendCallSignal(signal) {
    const socket = channelSocketRef.current
    if (socket?.readyState !== WebSocket.OPEN) return false
    socket.send(JSON.stringify(signal))
    return true
  }

  function failCall(message) {
    finishCall(false)
    setCallError(message)
  }

  function finishCall(notifyPeer = true) {
    const currentCall = callStateRef.current
    if (notifyPeer && currentCall?.callId) {
      sendCallSignal({
        type: 'call-end', call_id: currentCall.callId,
        target_user_id: currentCall.peerId || currentCall.fromUserId,
      })
    }
    peerConnectionRef.current?.close()
    peerConnectionRef.current = null
    localStreamRef.current?.getTracks().forEach((track) => track.stop())
    localStreamRef.current = null
    pendingCandidatesRef.current = []
    setLocalStream(null)
    setRemoteStream(null)
    setMuted(false)
    setDeafened(false)
    setCameraEnabled(true)
    setCallMinimized(false)
    setCallFullscreen(false)
    setCallError('')
    updateCallState(null)
  }

  function createPeerConnection(peerId, callId) {
    const connection = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
    })
    localStreamRef.current?.getTracks().forEach((track) => connection.addTrack(track, localStreamRef.current))
    connection.ontrack = (event) => {
      const stream = event.streams[0] ?? new MediaStream()
      if (stream !== event.streams[0]) stream.addTrack(event.track)
      setRemoteStream(stream)
    }
    connection.onicecandidate = (event) => {
      if (event.candidate) sendCallSignal({
        type: 'call-ice', call_id: callId, target_user_id: peerId, candidate: event.candidate,
      })
    }
    connection.onconnectionstatechange = () => {
      if (connection.connectionState === 'connected') {
        const currentCall = callStateRef.current
        if (currentCall) updateCallState({ ...currentCall, phase: 'connected' })
      } else if (connection.connectionState === 'failed') {
        failCall('Could not connect. Check your network and try again.')
      }
    }
    peerConnectionRef.current = connection
    return connection
  }

  async function acceptOffer(signal) {
    const currentCall = callStateRef.current
    if (!currentCall || currentCall.callId !== signal.call_id) return
    const connection = peerConnectionRef.current ?? createPeerConnection(signal.from_user_id, signal.call_id)
    await connection.setRemoteDescription(new RTCSessionDescription(signal.description))
    for (const candidate of pendingCandidatesRef.current) await connection.addIceCandidate(candidate)
    pendingCandidatesRef.current = []
    const answer = await connection.createAnswer()
    await connection.setLocalDescription(answer)
    sendCallSignal({
      type: 'call-answer', call_id: signal.call_id, target_user_id: signal.from_user_id,
      description: connection.localDescription,
    })
  }

  async function handleCallSignal(signal) {
    const currentCall = callStateRef.current
    if (signal.type === 'call-start') {
      if (currentCall) {
        sendCallSignal({ type: 'call-decline', call_id: signal.call_id, target_user_id: signal.from_user_id })
        return
      }
      updateCallState({ callId: signal.call_id, mode: signal.mode, phase: 'incoming', initiator: false, fromUserId: signal.from_user_id, peerName: signal.from_name, peerAvatarUrl: signal.from_avatar_url })
      return
    }
    if (signal.type === 'call-started' && currentCall?.initiator) {
      updateCallState({ ...currentCall, callId: signal.call_id })
      return
    }
    if (signal.type === 'call-accept' && currentCall?.initiator && currentCall.callId === signal.call_id) {
      const nextCall = { ...currentCall, peerId: signal.from_user_id, peerName: signal.from_name, peerAvatarUrl: signal.from_avatar_url, phase: 'connecting' }
      updateCallState(nextCall)
      const connection = createPeerConnection(nextCall.peerId, nextCall.callId)
      const offer = await connection.createOffer()
      await connection.setLocalDescription(offer)
      sendCallSignal({ type: 'call-offer', call_id: nextCall.callId, target_user_id: nextCall.peerId, description: connection.localDescription })
      return
    }
    if (signal.type === 'call-offer') {
      await acceptOffer(signal)
      return
    }
    if (signal.type === 'call-answer' && currentCall?.callId === signal.call_id && peerConnectionRef.current) {
      await peerConnectionRef.current.setRemoteDescription(new RTCSessionDescription(signal.description))
      for (const candidate of 
        pendingCandidatesRef.current) await peerConnectionRef.current.addIceCandidate(candidate)
      pendingCandidatesRef.current = []
      return
    }
    if (signal.type === 'call-ice' && currentCall?.callId === signal.call_id) {
      const candidate = new RTCIceCandidate(signal.candidate)
      if (!peerConnectionRef.current?.remoteDescription) pendingCandidatesRef.current.push(candidate)
      else await peerConnectionRef.current.addIceCandidate(candidate)
      return
    }
    if (signal.type === 'call-taken' && currentCall?.initiator) return
    if (['call-decline', 'call-end', 'call-taken'].includes(signal.type) && currentCall?.callId === signal.call_id) {
      if (signal.type === 'call-decline') setCallError(`${signal.from_name || 'The other person'} declined the call.`)
      finishCall(false)
    }
  }

  async function startCall(mode) {
    setCallError('')
    if (channelSocketRef.current?.readyState !== WebSocket.OPEN) {
      setCallError('Connecting to this channel. Try again in a moment.')
      return
    }
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error('SecureMediaUnavailable')
      }
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: mode === 'video' })
      stream.getAudioTracks().forEach((track) => { track.enabled = !muted && !deafened })
      if (mode === 'video') stream.getVideoTracks().forEach((track) => { track.enabled = cameraEnabled })
      localStreamRef.current = stream
      setLocalStream(stream)
      updateCallState({ callId: '', mode, phase: 'calling', initiator: true, peerId: '', peerName: 'Waiting for someone to answer' })
      if (!sendCallSignal({ type: 'call-start', mode })) {
        failCall('The channel connection closed before the call could start. Try again.')
      }
    } catch (error) {
      const message = error.message === 'SecureMediaUnavailable'
        ? 'Calls need microphone access in a secure browser context, such as localhost or HTTPS.'
        : error.name === 'NotAllowedError'
          ? 'Allow microphone and camera access in your browser to start a call.'
          : 'Could not start the call. Check that your microphone or camera is available.'
      failCall(message)
    }
  }

  async function acceptCall() {
    const currentCall = callStateRef.current
    if (!currentCall || currentCall.phase !== 'incoming') return
    setCallError('')
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error('SecureMediaUnavailable')
      }
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: currentCall.mode === 'video' })
      stream.getAudioTracks().forEach((track) => { track.enabled = !muted && !deafened })
      if (currentCall.mode === 'video') stream.getVideoTracks().forEach((track) => { track.enabled = cameraEnabled })
      localStreamRef.current = stream
      setLocalStream(stream)
      updateCallState({ ...currentCall, phase: 'connecting', peerId: currentCall.fromUserId })
      if (!sendCallSignal({ type: 'call-accept', call_id: currentCall.callId, target_user_id: currentCall.fromUserId })) {
        failCall('The channel connection closed before you could answer. Try again.')
      }
    } catch (error) {
      const message = error.message === 'SecureMediaUnavailable'
        ? 'Calls need microphone access in a secure browser context, such as localhost or HTTPS.'
        : error.name === 'NotAllowedError'
          ? 'Allow microphone and camera access to answer this call.'
          : 'Could not access your microphone or camera.'
      setCallError(message)
    }
  }

  function declineCall() {
    const currentCall = callStateRef.current
    if (currentCall?.callId) sendCallSignal({ type: 'call-decline', call_id: currentCall.callId, target_user_id: currentCall.fromUserId })
    finishCall(false)
  }

  function toggleMute() {
    const nextMuted = !muted
    localStreamRef.current?.getAudioTracks().forEach((track) => { track.enabled = !nextMuted && !deafened })
    setMuted(nextMuted)
  }

  function toggleDeafen() {
    const nextDeafened = !deafened
    localStreamRef.current?.getAudioTracks().forEach((track) => { track.enabled = !nextDeafened && !muted })
    setDeafened(nextDeafened)
  }

  function toggleCamera() {
    const nextEnabled = !cameraEnabled
    localStreamRef.current?.getVideoTracks().forEach((track) => { track.enabled = nextEnabled })
    setCameraEnabled(nextEnabled)
  }

  useEffect(() => {
    const token = sessionStorage.getItem('talkie-token')
    if (!token) return undefined
    let cancelled = false
    fetch(`${API_URL}/api/communities`, { headers: authHeaders() })
      .then((response) => response.ok ? response.json() : Promise.reject(new Error('Could not load communities')))
      .then((communities) => {
        if (cancelled) return
        setWorkspaces(communities)
        setActiveWorkspaceId((currentId) => communities.some((community) => community.id === currentId) ? currentId : communities[0]?.id ?? '')
        setActiveChannelId((currentId) => communities.some((community) => community.channels.some((channel) => channel.id === currentId)) ? currentId : communities[0]?.channels[0]?.id ?? '')
        setApiConnected(true)
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [location.pathname])

  useEffect(() => {
    if (!apiConnected || !activeChannelId) return undefined
    let socket
    let cancelled = false
    fetch(`${API_URL}/api/channels/${activeChannelId}/messages`, { headers: authHeaders() })
      .then((response) => response.ok ? response.json() : Promise.reject(new Error('Channel unavailable')))
      .then((messages) => {
        if (!cancelled) setMessagesByChannel((current) => ({ ...current, [activeChannelId]: messages }))
      })
      .catch(() => {})
    socket = new WebSocket(`${API_URL.replace('http', 'ws')}/ws/${activeChannelId}?token=${encodeURIComponent(sessionStorage.getItem('talkie-token') ?? '')}`)
    channelSocketRef.current = socket
    socket.onmessage = (event) => {
      const payload = JSON.parse(event.data)
      if (payload.type) {
        handleCallSignal(payload).catch(() => failCall('Call setup failed. Please try again.'))
        return
      }
      setMessagesByChannel((current) => {
        const existing = current[activeChannelId] ?? []
        return { ...current, [activeChannelId]: existing.some((item) => item.id === payload.id) ? existing : [...existing, payload] }
      })
    }
    socket.onclose = () => {
      if (channelSocketRef.current === socket) {
        channelSocketRef.current = null
        if (callStateRef.current) failCall('Channel connection lost. Reconnect before starting another call.')
      }
    }
    return () => {
      cancelled = true
      if (channelSocketRef.current === socket) {
        if (callStateRef.current) finishCall(true)
        channelSocketRef.current = null
      }
      socket?.close()
    }
  }, [activeChannelId, apiConnected])

  const ringCallId = callState?.callId
  const ringCallPhase = callState?.phase
  const ringIsOutgoing = callState?.initiator

  useEffect(() => {
    if (!['calling', 'incoming'].includes(ringCallPhase)) return undefined
    const callId = ringCallId
    const timeout = window.setTimeout(() => {
      if (callStateRef.current?.callId !== callId) return
      finishCall()
      setCallError(ringIsOutgoing
        ? 'No one answered. Try calling again later.'
        : 'The incoming call expired.')
    }, 30_000)
    return () => window.clearTimeout(timeout)
  }, [ringCallId, ringCallPhase, ringIsOutgoing])

  function changeWorkspace(workspace) {
    setActiveWorkspaceId(workspace.id)
    setActiveChannelId(workspace.channels?.[0]?.id ?? '')
    setMobileChannelsOpen(false)
  }

  function addWorkspace() {
    navigate('/discover')
  }

  async function addChannel() {
    if (!activeWorkspace) return
    const rawName = window.prompt('Name your new channel')?.trim()
    const name = rawName?.toLowerCase().replace(/\s+/g, '-')
    if (!name) return
    const response = await fetch(`${API_URL}/api/communities/${activeWorkspace.id}/channels`, {
      method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    })
    if (!response.ok) return
    const channel = await response.json()
    setWorkspaces((current) => current.map((community) => community.id === activeWorkspace.id
      ? { ...community, channels: [...community.channels, channel] }
      : community))
    setActiveChannelId(channel.id)
  }

  const [inviteOpen, setInviteOpen] = useState(false)
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteLink, setInviteLink] = useState('')
  const [inviteBusy, setInviteBusy] = useState(false)
  const [inviteNotice, setInviteNotice] = useState('')

  function openInviteModal() {
    if (!activeWorkspace) return
    const shareLink = `${window.location.origin}/?community=${encodeURIComponent(activeWorkspace.id)}`
    setInviteLink(shareLink)
    setInviteEmail('')
    setInviteNotice('')
    setInviteOpen(true)
  }

  async function sendInvite(event) {
    event.preventDefault()
    if (!activeWorkspace) return
    const email = inviteEmail.trim()
    if (!email) {
      setInviteNotice('Add a Talkie email to send an invite.')
      return
    }
    setInviteBusy(true)
    setInviteNotice('')
    try {
      const response = await fetch(`${API_URL}/api/communities/${activeWorkspace.id}/members`, {
        method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      })
      const result = await response.json()
      if (!response.ok) throw new Error(result.detail || 'Could not invite that person.')
      setWorkspaces((current) => current.map((community) => community.id === result.id ? result : community))
      setInviteNotice(`${email} was added to ${activeWorkspace.name}.`)
      setInviteEmail('')
      if (!inviteLink) {
        setInviteLink(`${window.location.origin}/?community=${encodeURIComponent(activeWorkspace.id)}`)
      }
    } catch (error) {
      setInviteNotice(error.message.includes('Failed to fetch') ? 'Could not reach Talkie API.' : error.message)
    } finally {
      setInviteBusy(false)
    }
  }

  async function copyInviteLink() {
    if (!inviteLink) return
    try {
      await navigator.clipboard.writeText(inviteLink)
      setInviteNotice('Invite link copied to your clipboard.')
    } catch {
      setInviteNotice('Copy failed. You can still select the link and copy it manually.')
    }
  }

  async function sendMessage(event) {
    event.preventDefault()
    const text = draft.trim()
    if (!text) return
    if (!activeChannelId || !apiConnected) return
    try {
      const response = await fetch(`${API_URL}/api/channels/${activeChannelId}/messages`, {
        method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      })
      if (!response.ok) throw new Error('Message could not be sent')
      const message = await response.json()
      setDraft('')
      setMessagesByChannel((current) => {
        const existing = current[activeChannelId] ?? []
        return { ...current, [activeChannelId]: existing.some((item) => item.id === message.id) ? existing : [...existing, message] }
      })
    } catch { setApiConnected(false) }
  }

  function toggleReaction(messageId, emoji) {
    setMessagesByChannel((current) => ({
      ...current,
      [activeChannelId]: (current[activeChannelId] ?? []).map((message) => {
        if (message.id !== messageId) return message
        const reactions = message.reactions ?? []
        const matching = reactions.find((reaction) => reaction.startsWith(emoji))
        return { ...message, reactions: matching ? reactions.filter((reaction) => reaction !== matching) : [...reactions, `${emoji} 1`] }
      }),
    }))
  }

  return (
    <main className={`chat-app ${page !== 'chat' ? 'page-mode' : ''}`}>
      <aside className="server-rail" aria-label="Spaces">
        <NavLink className="brand-mark" title="Talkie home" to="/chat"><MessageCircle size={22} strokeWidth={2.4} /></NavLink>
        <div className="rail-divider" />
        <NavLink to="/chat" end className={({ isActive }) => `page-nav-button ${isActive ? 'selected' : ''}`} title="Chat"><MessageCircle size={19} /></NavLink>
        <NavLink to="/messages" className={({ isActive }) => `page-nav-button ${isActive ? 'selected' : ''}`} title="Direct messages"><MessageSquare size={19} /></NavLink>
        <NavLink to="/friends" className={({ isActive }) => `page-nav-button ${isActive ? 'selected' : ''}`} title="Friends"><Users size={19} /></NavLink>
        <NavLink to="/discover" className={({ isActive }) => `page-nav-button ${isActive ? 'selected' : ''}`} title="Discover"><Compass size={19} /></NavLink>
        <NavLink to="/settings" className={({ isActive }) => `page-nav-button ${isActive ? 'selected' : ''}`} title="Settings"><Settings size={18} /></NavLink>
        <div className="rail-divider page-rail-divider" />
        {page === 'chat' && <>
          {workspaces.map((workspace) => <button key={workspace.id} title={workspace.name} onClick={() => changeWorkspace(workspace)} className={`server-icon ${workspace.color} ${activeWorkspaceId === workspace.id ? 'selected' : ''}`}>{workspace.initials}</button>)}
          <button className="server-add" title="Add a space" onClick={addWorkspace}><Plus size={21} /></button>
        </>}
        <div className="rail-spacer" />
      </aside>

      {page === 'chat' && !activeWorkspace ? <section className="chat-empty-page">
        <div className="empty-community-mark"><Users size={28} /></div>
        <span className="page-eyebrow">YOUR COMMUNITY, YOUR RULES</span>
        <h1>Start your own space.</h1>
        <p>Create a community for your friends, team, or favorite shared interest. Add channels and chat in real time.</p>
        <button className="primary-action" onClick={() => navigate('/discover')}><Plus size={17} /> Create a community</button>
        {!sessionStorage.getItem('talkie-token') && <span className="empty-auth-note">You’ll need an account to create and save your community. <Link to="/login">Sign in</Link> or <Link to="/register">register</Link>.</span>}
      </section> : page === 'chat' ? <>
      <aside className={`channel-sidebar ${mobileChannelsOpen ? 'mobile-open' : ''}`}>
        <button className="space-heading" onClick={() => setMobileChannelsOpen(false)}>
          <span>{activeWorkspace.name}</span><ChevronDown size={17} />
        </button>
        <div className="sidebar-scroll">
          {Object.entries(activeWorkspace.channels.reduce((groups, channel) => ({ ...groups, [channel.category]: [...(groups[channel.category] ?? []), channel] }), {})).map(([category, channels]) => (
            <section className="channel-group" key={category}>
              <div className="group-heading"><span><ChevronDown size={12} />{category}</span><button title="Create channel" onClick={addChannel}><Plus size={15} /></button></div>
              {channels.map((channel) => <button key={channel.id} className={`channel-link ${activeChannelId === channel.id ? 'active' : ''}`} onClick={() => { setActiveChannelId(channel.id); setMobileChannelsOpen(false) }}><Hash size={16} /><span>{channel.name}</span>{channel.id === 'general' && <span className="unread-dot" />}</button>)}
            </section>
          ))}
          <button className="invite-button" onClick={openInviteModal}><Plus size={16} /> Invite people</button>
        </div>
        <div className="user-panel">
          <Avatar image={currentUser.avatar_url} initials={currentUser.name?.slice(0, 2).toUpperCase() ?? 'YO'} className="yellow" showPresence />
          <div className="user-copy"><strong>{currentUser.name ?? 'you'}</strong><span>online & thriving</span></div>
          <button type="button" className={muted ? 'user-audio-active' : ''} aria-pressed={muted} title={muted ? 'Unmute microphone' : 'Mute microphone'} onClick={toggleMute}>{muted ? <MicOff size={17} /> : <Mic size={17} />}</button>
          <button type="button" className={deafened ? 'user-audio-active' : ''} aria-pressed={deafened} title={deafened ? 'Restore audio' : 'Deafen audio'} onClick={toggleDeafen}>{deafened ? <VolumeX size={18} /> : <Volume2 size={18} />}</button>
          <button type="button" title="User settings" onClick={() => navigate('/settings')}><Settings size={17} /></button>
        </div>
      </aside>

      <section className="conversation">
        <header className="channel-topbar">
          <button className="mobile-menu" title="Open channels" onClick={() => setMobileChannelsOpen(true)}><ChevronRight size={19} /></button>
          <Hash className="topbar-hash" size={20} />
          <strong>{activeChannel.name}</strong>
          <span className="topbar-rule" />
          <span className="channel-topic">a little corner of the internet</span>
          <div className="topbar-actions">
            <button title="Start a voice call" disabled={!apiConnected || !activeChannelId || !!callState} onClick={() => startCall('audio')}><Headphones size={19} /></button>
            <button title="Start a video call" disabled={!apiConnected || !activeChannelId || !!callState} onClick={() => startCall('video')}><Video size={19} /></button>
            <button title="Toggle member list" className={showMembers ? 'toggled' : ''} onClick={() => setShowMembers(!showMembers)}><Users size={19} /></button>
            <label className="search-box"><Search size={16} /><input aria-label="Search messages" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search" /><kbd>⌘ K</kbd>{search && <button title="Clear search" onClick={() => setSearch('')}><X size={14} /></button>}</label>
            <button title="More options"><MoreHorizontal size={20} /></button>
          </div>
        </header>
        {callError && !callState && <div role="alert" className="call-notice">{callError}<button onClick={() => setCallError('')} aria-label="Dismiss call notice"><X size={15} /></button></div>}

        <div className="message-feed">
          <div className="channel-welcome"><span className="welcome-hash"><Hash size={30} /></span><div className="welcome-copy"><h1>{activeChannel.name}</h1><p>This is the beginning of <strong>#{activeChannel.name}</strong>. Say something nice.</p></div></div>
          <div className="date-divider"><span>Today</span></div>
          {visibleMessages.length ? visibleMessages.map((message) => <article className="message-row" key={message.id}>
            <Avatar image={message.avatar_url} initials={message.avatar} className={message.color} />
            <div className="message-content"><div className="message-meta"><strong>{message.author}</strong><time>{message.time}</time></div><p>{message.text}</p>
              {!!message.reactions?.length && <div className="reactions">{message.reactions.map((reaction) => <button key={reaction} onClick={() => toggleReaction(message.id, reaction.split(' ')[0])}>{reaction}</button>)}<button title="Add reaction" onClick={() => toggleReaction(message.id, '✨')}><Plus size={13} /></button></div>}
              {!message.reactions?.length && <button className="quick-react" title="Add a sparkle reaction" onClick={() => toggleReaction(message.id, '✨')}>✨</button>}
            </div>
          </article>) : <div className="empty-state">{search ? 'No messages match that search.' : 'It’s quiet in here. Start the conversation.'}</div>}
        </div>

        <form className="composer" onSubmit={sendMessage}>
          <button type="button" title="Attach an image" onClick={() => window.alert('Attachments are coming soon.')}><ImagePlus size={21} /></button>
          <input value={draft} onChange={(event) => setDraft(event.target.value)} placeholder={`Message #${activeChannel.name}`} aria-label={`Message ${activeChannel.name}`} />
          <div className="composer-tools"><button type="button" title="Add a fun prompt" onClick={() => setDraft((current) => `${current}${current ? ' ' : ''}What’s everyone up to?`)}><Sparkles size={19} /></button><button type="button" title="Add a smile" onClick={() => setDraft((current) => `${current} 😊`)}><Smile size={20} /></button><button className="send-button" type="submit" title="Send message" disabled={!draft.trim()}><Send size={17} /></button></div>
        </form>
        <div className="connection-note"><span className={apiConnected ? 'connection-live' : ''} />{apiConnected ? 'Live community chat' : 'Connecting to Talkie API'}<span className="connection-separator">·</span>Messages sync in real time</div>
      </section>

      {showMembers && <aside className="member-sidebar"><div className="member-heading">PEOPLE <span>{activeWorkspace.members?.length ?? 0}</span></div><div className="member-list">{(activeWorkspace.members ?? []).map((member) => <div key={member.id ?? member.name} className="member-row"><Avatar image={member.avatar_url} initials={member.avatar ?? member.name.slice(0, 2).toUpperCase()} className={member.color ?? 'mint'} showPresence /><div><strong>{member.name}</strong><span>{member.status ?? 'Online'}</span></div></div>)}</div><div className="member-footer"><ArrowDown size={14} /> {apiConnected ? 'Live community' : 'Connecting...'}</div></aside>}
      {callState && <CallOverlay
        callState={callState} currentUser={currentUser} localStream={localStream} remoteStream={remoteStream}
        muted={muted} deafened={deafened} cameraEnabled={cameraEnabled} error={callError}
        minimized={callMinimized} fullscreen={callFullscreen}
        onAccept={acceptCall} onDecline={declineCall} onHangup={() => finishCall()}
        onToggleMute={toggleMute} onToggleCamera={toggleCamera}
        onMinimize={() => setCallMinimized(true)} onRestore={() => setCallMinimized(false)}
        onToggleFullscreen={() => setCallFullscreen((current) => !current)}
      />}
      {inviteOpen && activeWorkspace && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setInviteOpen(false) }}>
        <section className="invite-modal" role="dialog" aria-modal="true" aria-labelledby="invite-title">
          <header>
            <div><span className="page-eyebrow">SHARE THE SPACE</span><h2 id="invite-title">Invite people</h2></div>
            <button className="icon-action" title="Close" onClick={() => setInviteOpen(false)}><X size={17} /></button>
          </header>
          <p className="modal-description">Send a direct link or add someone by email. They’ll land in {activeWorkspace.name} once they join.</p>
          <form className="invite-form" onSubmit={sendInvite}>
            <label>Direct invite link
              <div className="invite-link-row">
                <input value={inviteLink} readOnly onFocus={(event) => event.target.select()} />
                <button type="button" className="quiet-action" onClick={copyInviteLink}>Copy</button>
              </div>
            </label>
            <label>Email address
              <input value={inviteEmail} onChange={(event) => setInviteEmail(event.target.value)} placeholder="friend@example.com" />
            </label>
            {inviteNotice && <p role="status" className={inviteNotice.includes('added') || inviteNotice.includes('copied') ? 'invite-success' : 'invite-notice'}>{inviteNotice}</p>}
            <footer>
              <button type="button" className="quiet-action" onClick={() => setInviteOpen(false)}>Close</button>
              <button className="primary-action" disabled={inviteBusy} type="submit">{inviteBusy ? 'Sending...' : 'Send invite'}</button>
            </footer>
          </form>
        </section>
      </div>}
      </> : page === 'messages' ? <section className="page-shell dm-page-shell"><DirectMessagesPage selectedFriendId={selectedFriendId} /></section> : <section className="page-shell">
        {page === 'friends' && <FriendsPage />}
        {page === 'discover' && <DiscoverPage communities={workspaces} onCreated={(community) => { setWorkspaces((current) => [community, ...current]); changeWorkspace(community); navigate('/chat') }} />}
        {page === 'settings' && <SettingsPage onUserUpdate={setCurrentUser} theme={theme} onThemeChange={setTheme} />}
      </section>}
    </main>
  )
}

function CallOverlay({ callState, currentUser, localStream, remoteStream, muted, deafened, cameraEnabled, error, minimized, fullscreen, onAccept, onDecline, onHangup, onToggleMute, onToggleCamera, onMinimize, onRestore, onToggleFullscreen }) {
  const localVideoRef = useRef(null)
  const remoteVideoRef = useRef(null)
  const remoteAudioRef = useRef(null)
  const incoming = callState.phase === 'incoming'
  const isVideo = callState.mode === 'video'

  useEffect(() => {
    if (localVideoRef.current) localVideoRef.current.srcObject = localStream
    if (remoteVideoRef.current) remoteVideoRef.current.srcObject = remoteStream
    if (remoteAudioRef.current) remoteAudioRef.current.srcObject = remoteStream
  }, [localStream, remoteStream, minimized])

  if (minimized) {
    return <aside className="call-dock" aria-label="Minimized call">
      <audio ref={remoteAudioRef} autoPlay muted={deafened} />
      <span className="call-live-dot" />
      <span className="call-dock-copy"><strong>{callState.peerName || (incoming ? 'Incoming call' : 'Call')}</strong><span>{incoming ? 'Incoming' : callState.phase === 'connected' ? 'Connected' : 'Calling'} · {isVideo ? 'Video' : 'Voice'}</span></span>
      <button title="Restore call" onClick={onRestore}><Expand size={17} /></button>
      <button className="dock-hangup" title="End call" onClick={onHangup}><PhoneOff size={16} /></button>
    </aside>
  }

  return (
    <div className={`call-backdrop ${fullscreen ? 'call-backdrop-fullscreen' : ''}`}>
      <section className={`call-dialog ${isVideo ? 'video-call' : 'audio-call'} ${fullscreen ? 'call-dialog-fullscreen' : ''}`} role="dialog" aria-modal="true" aria-label={incoming ? 'Incoming call' : 'Call'}>
        <header className="call-header"><span><span className="call-live-dot" />{incoming ? 'INCOMING CALL' : isVideo ? 'VIDEO CALL' : 'VOICE CALL'}</span><div className="call-window-actions"><button title={fullscreen ? 'Exit full screen' : 'Full screen'} aria-pressed={fullscreen} onClick={onToggleFullscreen}>{fullscreen ? <Minimize2 size={17} /> : <Expand size={17} />}</button><button title="Minimize call" onClick={onMinimize}><Minimize2 size={17} /></button><button title="End call" onClick={onHangup}><PhoneOff size={17} /></button></div></header>
        {incoming ? <div className="incoming-call-content">
          <Avatar image={callState.fromAvatarUrl} initials={callState.peerName?.slice(0, 2).toUpperCase() ?? '??'} className="call-avatar" />
          <h2>{callState.peerName}</h2><p>is inviting you to a {isVideo ? 'video' : 'voice'} call</p>
          {error && <p role="alert" className="call-error">{error}</p>}
          <div className="incoming-actions"><button className="decline-call" onClick={onDecline}><PhoneOff size={18} /> Decline</button><button className="accept-call" onClick={onAccept}>{isVideo ? <Video size={18} /> : <Phone size={18} />} Answer</button></div>
        </div> : <>
          <div className="call-stage">
            {isVideo && remoteStream ? <video ref={remoteVideoRef} className="remote-video" autoPlay playsInline muted /> : <div className="audio-call-person"><Avatar image={callState.peerAvatarUrl} initials={callState.peerName?.slice(0, 2).toUpperCase() ?? '??'} className="call-avatar" /><h2>{callState.peerName || 'Waiting for someone to answer'}</h2><p>{callState.phase === 'connected' ? 'Connected' : callState.phase === 'calling' ? 'Ringing in this channel...' : 'Connecting...'}</p></div>}
            {isVideo && localStream && (cameraEnabled
              ? <video ref={localVideoRef} className="local-video" autoPlay playsInline muted />
              : <div className="local-video local-video-avatar" aria-label="Your camera is off"><Avatar image={currentUser.avatar_url} initials={currentUser.name?.slice(0, 2).toUpperCase() ?? 'YO'} className="camera-off-avatar" /><span>Camera off</span></div>)}
            <audio ref={remoteAudioRef} autoPlay muted={deafened} />
          </div>
          {error && <p role="alert" className="call-error">{error}</p>}
          <div className="call-controls">
            <button title={muted ? 'Unmute microphone' : 'Mute microphone'} className={muted ? 'control-active' : ''} onClick={onToggleMute}>{muted ? <MicOff size={19} /> : <Mic size={19} />}</button>
            {isVideo && <button title={cameraEnabled ? 'Turn camera off' : 'Turn camera on'} className={!cameraEnabled ? 'control-active' : ''} onClick={onToggleCamera}>{cameraEnabled ? <Video size={19} /> : <VideoOff size={19} />}</button>}
            <button title="End call" className="hangup-call" onClick={onHangup}><PhoneOff size={19} /></button>
          </div>
        </>}
      </section>
    </div>
  )
}

function App() {
  const [isBooting, setIsBooting] = useState(true)
  const [theme, setTheme] = useState(() => {
    try {
      return localStorage.getItem('talkie-theme') ?? 'dark'
    } catch {
      return 'dark'
    }
  })

  useEffect(() => {
    document.body.classList.toggle('dark-theme', theme === 'dark')
    try {
      localStorage.setItem('talkie-theme', theme)
    } catch {
      // ignore storage issues in restricted browsers
    }
  }, [theme])

  useEffect(() => {
    const timer = window.setTimeout(() => setIsBooting(false), 700)
    return () => window.clearTimeout(timer)
  }, [])

  if (isBooting) return <AppLoader />

  return <BrowserRouter><Routes>
    <Route path="/login" element={<LoginPage />} />
    <Route path="/register" element={<RegisterPage />} />
    <Route path="*" element={<ChatWorkspace theme={theme} setTheme={setTheme} />} />
  </Routes></BrowserRouter>
}

export default App
