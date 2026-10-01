import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { ArrowRight, Check, Clock3, Compass, Copy, ImagePlus, LogIn, LogOut, MessageCircle, MessageSquare, Moon, Paperclip, Plus, Send, Sun, Trash2, UserPlus, Users, X } from 'lucide-react'

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8001'

export function FriendsPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const token = sessionStorage.getItem('talkie-token')
  const [friendsData, setFriendsData] = useState({ friends: [], incoming: [], outgoing: [] })
  const [tab, setTab] = useState(searchParams.get('tab') === 'incoming' ? 'incoming' : 'friends')
  const [friendId, setFriendId] = useState('')
  const [isAddOpen, setIsAddOpen] = useState(false)
  const [adding, setAdding] = useState(false)
  const [loading, setLoading] = useState(Boolean(token))
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const loadFriends = useCallback(async () => {
    if (!token) return
    try {
      const response = await fetch(`${API_URL}/api/friends`, { headers: { Authorization: `Bearer ${token}` } })
      const result = await response.json()
      if (!response.ok) throw new Error(result.detail || 'Could not load your friends.')
      setFriendsData(result)
    } catch (requestError) {
      setError(requestError.message.includes('Failed to fetch') ? 'Could not reach Talkie API.' : requestError.message)
    } finally {
      setLoading(false)
    }
  }, [token])

  useEffect(() => {
    const timer = window.setTimeout(loadFriends, 0)
    return () => window.clearTimeout(timer)
  }, [loadFriends])

  async function sendRequest(event) {
    event.preventDefault()
    setAdding(true)
    setError('')
    setNotice('')
    try {
      const response = await fetch(`${API_URL}/api/friends/requests`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ friend_id: friendId.trim() }),
      })
      const result = await response.json()
      if (!response.ok) throw new Error(result.detail || 'Could not send friend request.')
      setFriendId('')
      setIsAddOpen(false)
      setNotice(result.status === 'accepted' ? `You and ${result.friend.name} are now friends.` : `Friend request sent to ${result.friend.name}.`)
      await loadFriends()
    } catch (requestError) {
      setError(requestError.message.includes('Failed to fetch') ? 'Could not reach Talkie API.' : requestError.message)
    } finally {
      setAdding(false)
    }
  }

  async function acceptRequest(requestId) {
    setError('')
    try {
      const response = await fetch(`${API_URL}/api/friends/requests/${requestId}/accept`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}` },
      })
      const result = await response.json()
      if (!response.ok) throw new Error(result.detail || 'Could not accept friend request.')
      setNotice(`You and ${result.friend.name} are now friends.`)
      await loadFriends()
    } catch (requestError) {
      setError(requestError.message.includes('Failed to fetch') ? 'Could not reach Talkie API.' : requestError.message)
    }
  }

  const activeItems = tab === 'friends' ? friendsData.friends : tab === 'incoming' ? friendsData.incoming : friendsData.outgoing

  function changeTab(nextTab) {
    setTab(nextTab)
    setSearchParams(nextTab === 'incoming' ? { tab: 'incoming' } : {})
  }

  return (
    <div className="page-content">
      <header className="page-heading">
        <div><span className="page-eyebrow"><Users size={14} /> YOUR PEOPLE</span><h1>Friends</h1><p>Add people using their unique Talkie ID.</p></div>
        <button className="primary-action" onClick={() => { setIsAddOpen(true); setError(''); setNotice('') }}><UserPlus size={17} /> Add a friend</button>
      </header>
      {isAddOpen && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setIsAddOpen(false) }}>
        <section className="community-modal friend-modal" role="dialog" aria-modal="true" aria-labelledby="friend-modal-title">
          <header><div><span className="page-eyebrow">CONNECT WITH SOMEONE</span><h2 id="friend-modal-title">Add a friend</h2></div><button className="icon-action" title="Close" onClick={() => setIsAddOpen(false)}><X size={17} /></button></header>
          <p className="modal-description">Ask them to share their Talkie ID. You can find your own ID in Settings.</p>
          <form className="friend-add-form" onSubmit={sendRequest}>
            <label htmlFor="friend-id-input"><UserPlus size={16} /> Talkie user ID</label>
            <div><input id="friend-id-input" autoFocus required minLength={36} maxLength={36} value={friendId} onChange={(event) => setFriendId(event.target.value)} placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" /><button className="primary-action" disabled={adding || !token}>{adding ? 'Sending...' : 'Send request'}<ArrowRight size={15} /></button></div>
            {!token && <p><Link to="/login">Sign in</Link> to add friends.</p>}
            {error && <p role="alert" className="auth-error">{error}</p>}
            <footer><button type="button" className="quiet-action" onClick={() => setIsAddOpen(false)}>Cancel</button></footer>
          </form>
        </section>
      </div>}
      {error && <p role="alert" className="profile-error">{error}</p>}
      {notice && <p role="status" className="friend-notice"><Check size={14} /> {notice}</p>}
      <div className="friends-tabs" role="tablist" aria-label="Friend lists">
        <button role="tab" aria-selected={tab === 'friends'} className={tab === 'friends' ? 'selected' : ''} onClick={() => changeTab('friends')}>Friends <span>{friendsData.friends.length}</span></button>
        <button role="tab" aria-selected={tab === 'incoming'} className={tab === 'incoming' ? 'selected' : ''} onClick={() => changeTab('incoming')}>Incoming <span>{friendsData.incoming.length}</span></button>
        <button role="tab" aria-selected={tab === 'outgoing'} className={tab === 'outgoing' ? 'selected' : ''} onClick={() => changeTab('outgoing')}>Sent <span>{friendsData.outgoing.length}</span></button>
      </div>
      <div className="friend-results">
        {loading ? <p className="page-empty">Loading friends...</p> : activeItems.length ? activeItems.map((friend) => <article className="person-row" key={friend.request_id ?? friend.id}>
          <span className="avatar mint">{friend.avatar_url ? <img src={friend.avatar_url} alt="" /> : friend.name.slice(0, 2).toUpperCase()}</span>
          <div className="person-copy"><strong>{friend.name}</strong><span className="friend-id">ID: {friend.id}</span></div>
          {tab === 'incoming' ? <button className="primary-action" onClick={() => acceptRequest(friend.request_id)}><Check size={15} /> Accept</button> : tab === 'outgoing' ? <span className="owner-label"><Clock3 size={14} /> Pending</span> : <Link className="icon-action" to={`/messages/${friend.id}`} title={`Message ${friend.name}`}><MessageCircle size={18} /></Link>}
        </article>) : <div className="friends-empty">
          <div className="empty-community-mark">{tab === 'friends' ? <Users size={24} /> : <Clock3 size={22} />}</div>
          <h2>{tab === 'friends' ? 'No friends yet' : tab === 'incoming' ? 'No incoming requests' : 'No sent requests'}</h2>
          <p>{tab === 'friends' ? 'Use Add a friend to send a request with their unique Talkie ID.' : 'Friend requests will appear here.'}</p>
        </div>}
      </div>
    </div>
  )
}

export function DirectMessagesPage({ selectedFriendId }) {
  const navigate = useNavigate()
  const token = sessionStorage.getItem('talkie-token')
  const currentUserId = JSON.parse(sessionStorage.getItem('talkie-user') ?? '{}').id
  const [friends, setFriends] = useState([])
  const [conversations, setConversations] = useState([])
  const [activeConversation, setActiveConversation] = useState(null)
  const [messages, setMessages] = useState([])
  const [draft, setDraft] = useState('')
  const [attachment, setAttachment] = useState(null)
  const [attachmentError, setAttachmentError] = useState('')
  const [sending, setSending] = useState(false)
  const attachmentInput = useRef(null)
  const [loading, setLoading] = useState(Boolean(token))
  const [error, setError] = useState('')
  const [socketConnected, setSocketConnected] = useState(false)
  const visibleConversation = activeConversation?.friend.id === selectedFriendId ? activeConversation : null

  useEffect(() => {
    if (!token) return undefined
    let cancelled = false
    Promise.allSettled([
      fetch(`${API_URL}/api/friends`, { headers: { Authorization: `Bearer ${token}` } }).then(async (response) => {
        const result = await response.json()
        if (!response.ok) throw new Error(result.detail || 'Could not load friends.')
        return result.friends
      }),
      fetch(`${API_URL}/api/dms`, { headers: { Authorization: `Bearer ${token}` } }).then(async (response) => {
        const result = await response.json()
        if (!response.ok) throw new Error(result.detail || 'Could not load private chats.')
        return result
      }),
    ]).then(([friendResult, conversationResult]) => {
      if (cancelled) return
      if (friendResult.status === 'fulfilled') setFriends(friendResult.value)
      else setError(friendResult.reason.message.includes('Failed to fetch') ? 'Could not reach Talkie API.' : friendResult.reason.message)
      if (conversationResult.status === 'fulfilled') setConversations(conversationResult.value)
      else if (friendResult.status === 'fulfilled') setError('Friend list loaded, but direct chats could not be loaded. Reload Talkie’s API server to update it.')
    }).finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [token])

  useEffect(() => {
    if (!token || !selectedFriendId) return undefined
    let cancelled = false
    fetch(`${API_URL}/api/dms/${selectedFriendId}`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}` },
    }).then(async (response) => {
      const result = await response.json()
      if (!response.ok) throw new Error(result.detail || 'Could not open this conversation.')
      if (cancelled) return
      setActiveConversation(result)
      setConversations((current) => [result, ...current.filter((conversation) => conversation.id !== result.id)])
    }).catch((requestError) => {
      if (!cancelled) setError(requestError.message.includes('Failed to fetch') ? 'Could not reach Talkie API.' : requestError.message)
    })
    return () => { cancelled = true }
  }, [selectedFriendId, token])

  useEffect(() => {
    if (!token || !visibleConversation) return undefined
    let cancelled = false
    fetch(`${API_URL}/api/dms/${visibleConversation.id}/messages`, {
      headers: { Authorization: `Bearer ${token}` },
    }).then(async (response) => {
      const result = await response.json()
      if (!response.ok) throw new Error(result.detail || 'Could not load this conversation.')
      if (!cancelled) setMessages(result)
    }).catch((requestError) => { if (!cancelled) setError(requestError.message) })

    const socket = new WebSocket(`${API_URL.replace('http', 'ws')}/ws/dm/${visibleConversation.id}?token=${encodeURIComponent(token)}`)
    socket.onopen = () => { if (!cancelled) setSocketConnected(true) }
    socket.onclose = () => { if (!cancelled) setSocketConnected(false) }
    socket.onmessage = (event) => {
      const message = JSON.parse(event.data)
      setMessages((current) => current.some((item) => item.id === message.id) ? current : [...current, message])
      setConversations((current) => current.map((conversation) => conversation.id === visibleConversation.id
        ? { ...conversation, last_message: { text: message.text || (message.attachment_data ? 'Photo attachment' : ''), time: message.time, from_me: message.sender_id === currentUserId } }
        : conversation))
    }
    return () => { cancelled = true; socket.close(); setSocketConnected(false) }
  }, [visibleConversation, token, currentUserId])

  async function sendMessage(event) {
    event.preventDefault()
    const text = draft.trim()
    if ((!text && !attachment) || !visibleConversation || sending) return
    setSending(true)
    setError('')
    try {
      const response = await fetch(`${API_URL}/api/dms/${visibleConversation.id}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text,
          attachment_data: attachment?.data ?? null,
          attachment_name: attachment?.name ?? null,
        }),
      })
      const result = await response.json()
      if (!response.ok) throw new Error(result.detail || 'Could not send message.')
      setDraft('')
      setAttachment(null)
      setAttachmentError('')
      setMessages((current) => current.some((message) => message.id === result.id) ? current : [...current, result])
      setConversations((current) => current.map((conversation) => conversation.id === visibleConversation.id
        ? { ...conversation, last_message: { text: result.text || 'Photo attachment', time: result.time, from_me: true } }
        : conversation))
    } catch (requestError) {
      setError(requestError.message.includes('Failed to fetch') ? 'Could not reach Talkie API.' : requestError.message)
    } finally {
      setSending(false)
    }
  }

  function chooseAttachment(event) {
    const file = event.target.files?.[0]
    event.target.value = ''
    setAttachmentError('')
    if (!file) return
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
      setAttachmentError('Choose a PNG, JPEG, or WebP image.')
      return
    }
    if (file.size > 2_000_000) {
      setAttachmentError('Images must be smaller than 2 MB.')
      return
    }
    const reader = new FileReader()
    reader.onload = () => setAttachment({ data: reader.result, name: file.name })
    reader.onerror = () => setAttachmentError('That image could not be read.')
    reader.readAsDataURL(file)
  }

  function openConversation(friendId) {
    navigate(`/messages/${friendId}`)
  }

  return (
    <div className="dm-page">
      <aside className="dm-sidebar">
        <header className="dm-sidebar-header"><span className="page-eyebrow"><MessageSquare size={14} /> PRIVATE CHATS</span><h1>Messages</h1></header>
        <section className="dm-list-section"><h2>CONVERSATIONS</h2>
          {conversations.length ? conversations.map((conversation) => <button key={conversation.id} className={`dm-list-item ${visibleConversation?.id === conversation.id ? 'active' : ''}`} onClick={() => openConversation(conversation.friend.id)}><span className="avatar mint">{conversation.friend.avatar_url ? <img src={conversation.friend.avatar_url} alt="" /> : conversation.friend.name.slice(0, 2).toUpperCase()}</span><span className="dm-list-copy"><strong>{conversation.friend.name}</strong><span>{conversation.last_message?.text ?? 'Start a conversation'}</span></span></button>) : <p className="dm-list-empty">No private conversations yet.</p>}
        </section>
        <section className="dm-list-section dm-friends-section"><h2>YOUR FRIENDS <span>{friends.length}</span></h2>
          {friends.map((friend) => <button key={friend.id} className={`dm-list-item ${selectedFriendId === friend.id ? 'active' : ''}`} onClick={() => openConversation(friend.id)}><span className="avatar mint">{friend.avatar_url ? <img src={friend.avatar_url} alt="" /> : friend.name.slice(0, 2).toUpperCase()}</span><span className="dm-list-copy"><strong>{friend.name}</strong><span>Start a private chat</span></span></button>)}
          {!friends.length && !loading && <Link className="dm-add-friends" to="/friends"><Users size={14} /> Add friends first</Link>}
        </section>
      </aside>
      <section className="dm-conversation">
        {visibleConversation ? <>
          <header className="dm-conversation-header"><span className="avatar mint">{visibleConversation.friend.avatar_url ? <img src={visibleConversation.friend.avatar_url} alt="" /> : visibleConversation.friend.name.slice(0, 2).toUpperCase()}</span><div><strong>{visibleConversation.friend.name}</strong><span>{socketConnected ? 'Live private chat' : 'Connecting...'}</span></div></header>
          {error && <p role="alert" className="dm-error">{error}</p>}
          <div className="dm-message-feed">
            {messages.length ? messages.map((message) => <article key={message.id} className={`dm-message ${message.sender_id === currentUserId ? 'own' : ''}`}><span className="avatar mint">{message.avatar_url ? <img src={message.avatar_url} alt="" /> : message.avatar}</span><div><div className="dm-message-meta"><strong>{message.author}</strong><time>{message.time}</time></div>{message.text && <p>{message.text}</p>}{message.attachment_data && <a className="dm-attachment" href={message.attachment_data} target="_blank" rel="noreferrer"><img src={message.attachment_data} alt={message.attachment_name || 'Image attachment'} loading="lazy" /><span>{message.attachment_name || 'Image attachment'}</span></a>}</div></article>) : <div className="dm-empty-thread"><MessageCircle size={25} /><h2>Say hello to {visibleConversation.friend.name}</h2><p>This is a private conversation between the two of you.</p></div>}
          </div>
          {attachment && <div className="dm-attachment-preview"><img src={attachment.data} alt="Attachment preview" /><span>{attachment.name}</span><button type="button" title="Remove attachment" onClick={() => setAttachment(null)}><X size={15} /></button></div>}
          {attachmentError && <p className="dm-error" role="alert">{attachmentError}</p>}
          <form className="dm-composer" onSubmit={sendMessage}><button type="button" className="dm-attach-button" title="Attach image" aria-label="Attach image" onClick={() => attachmentInput.current?.click()}><Paperclip size={18} /></button><input ref={attachmentInput} className="dm-file-input" type="file" accept="image/png,image/jpeg,image/webp" onChange={chooseAttachment} /><input aria-label={`Message ${visibleConversation.friend.name}`} value={draft} onChange={(event) => setDraft(event.target.value)} placeholder={`Message ${visibleConversation.friend.name}`} /><button className="send-button" type="submit" title="Send message" disabled={sending || (!draft.trim() && !attachment)}><Send size={17} /></button></form>
        </> : <div className="dm-select-empty"><MessageSquare size={28} /><h2>{loading ? 'Loading messages...' : 'Your one-to-one chats'}</h2><p>Choose a friend to open a private conversation. These chats are separate from community channels.</p>{error && <p role="alert" className="dm-error">{error}</p>}{!friends.length && !loading && <Link className="quiet-action" to="/friends">Find friends <ArrowRight size={15} /></Link>}</div>}
      </section>
    </div>
  )
}

export function DiscoverPage({ communities, onCreated }) {
  const [isCreating, setIsCreating] = useState(false)
  const [form, setForm] = useState({ name: '', description: '', image_data: '' })
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [coverPreview, setCoverPreview] = useState('')
  const coverInput = useRef(null)

  function handleCoverChange(event) {
    const file = event.target.files?.[0]
    if (!file) return
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
      setError('Choose a PNG, JPEG, or WebP image for your community.')
      event.target.value = ''
      return
    }
    if (file.size > 2_000_000) {
      setError('Community images must be smaller than 2 MB.')
      event.target.value = ''
      return
    }
    const reader = new FileReader()
    reader.onload = () => {
      const imageData = reader.result
      setCoverPreview(imageData)
      setForm((current) => ({ ...current, image_data: imageData }))
      setError('')
    }
    reader.onerror = () => setError('That image could not be read.')
    reader.readAsDataURL(file)
  }

  async function createCommunity(event) {
    event.preventDefault()
    setError('')
    const token = sessionStorage.getItem('talkie-token')
    if (!token) {
      setError('Sign in or create an account before creating a community.')
      return
    }
    setSaving(true)
    try {
      const response = await fetch(`${API_URL}/api/communities`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: form.name,
          description: form.description,
          image_data: form.image_data || undefined,
        }),
      })
      const result = await response.json()
      if (!response.ok) throw new Error(result.detail || 'Could not create your community.')
      if (coverPreview && result.image_url !== coverPreview) result.image_url = coverPreview
      onCreated(result)
      setForm({ name: '', description: '', image_data: '' })
      setCoverPreview('')
      setIsCreating(false)
    } catch (requestError) {
      setError(requestError.message.includes('Failed to fetch')
        ? 'Could not reach Talkie. Start the FastAPI server and try again.'
        : requestError.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="page-content">
      <header className="page-heading">
        <div><span className="page-eyebrow"><Compass size={14} /> YOUR COMMUNITIES</span><h1>Communities</h1><p>Spaces you created and manage.</p></div>
        <button className="primary-action" onClick={() => { setIsCreating(true); setError('') }}><Plus size={17} /> Create community</button>
      </header>
      {isCreating && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setIsCreating(false) }}>
        <section className="community-modal" role="dialog" aria-modal="true" aria-labelledby="create-community-title">
          <header><div><span className="page-eyebrow">MAKE IT YOURS</span><h2 id="create-community-title">Create a community</h2></div><button className="icon-action" title="Close" onClick={() => setIsCreating(false)}><X size={17} /></button></header>
          <p className="modal-description">Start a space for your friends, team, or shared interests. You can add more channels after.</p>
          <form className="community-form" onSubmit={createCommunity}>
            <label>Community name<input autoFocus required maxLength={50} value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="e.g. Weekend makers" /></label>
            <label>Description <span>Optional</span><textarea maxLength={180} rows={3} value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} placeholder="What brings your people together?" /></label>
            <div className="community-image-picker">
              <div className="community-image-preview">
                {coverPreview ? <img src={coverPreview} alt="Community preview" /> : <span className="community-image-empty"><ImagePlus size={18} /> Add picture</span>}
              </div>
              <button type="button" className="quiet-action" onClick={() => coverInput.current?.click()}><ImagePlus size={15} /> {coverPreview ? 'Change image' : 'Add image'}</button>
              <input ref={coverInput} className="photo-input" type="file" accept="image/png,image/jpeg,image/webp" onChange={handleCoverChange} />
            </div>
            {error && <p role="alert" className="auth-error">{error}{!sessionStorage.getItem('talkie-token') && <> <Link to="/login">Sign in</Link> or <Link to="/register">register</Link>.</>}</p>}
            <footer><button type="button" className="quiet-action" onClick={() => setIsCreating(false)}>Cancel</button><button className="primary-action" disabled={saving}>{saving ? 'Creating...' : 'Create community'}<ArrowRight size={15} /></button></footer>
          </form>
        </section>
      </div>}
      <div className="section-label">CREATED BY YOU <span>{communities.length} {communities.length === 1 ? 'community' : 'communities'}</span></div>
      <div className="community-list">
        {communities.length ? communities.map((community) => <article className="community-row" key={community.id}>
          {community.image_url ? <span className="community-mark image-mark"><img src={community.image_url} alt="" /></span> : <span className={`community-mark ${community.color ?? 'green'}`}>{community.initials ?? community.name.slice(0, 1).toUpperCase()}</span>}
          <div className="community-copy"><span className="community-category">Created by you</span><h2>{community.name}</h2><p>{community.description || 'A space for your people.'}</p><span className="community-members"><Users size={13} /> {community.members?.length ?? 1} {community.members?.length === 1 ? 'member' : 'members'} · {community.channels?.length ?? 0} channels</span></div>
          <span className="owner-label"><Check size={14} /> Owner</span>
        </article>) : <div className="communities-empty"><div className="empty-community-mark"><Users size={25} /></div><h2>No communities yet</h2><p>Create a space for your friends, group, or team. Your community is yours to shape.</p><button className="primary-action" onClick={() => setIsCreating(true)}><Plus size={16} /> Create your first community</button>{!sessionStorage.getItem('talkie-token') && <span>Sign in or register to save communities to your account.</span>}</div>}
      </div>
    </div>
  )
}

export function SettingsPage({ onUserUpdate, theme, onThemeChange }) {
  const navigate = useNavigate()
  const user = JSON.parse(sessionStorage.getItem('talkie-user') ?? '{"name":"you"}')
  const [displayName, setDisplayName] = useState(user.name ?? 'you')
  const [avatarUrl, setAvatarUrl] = useState(user.avatar_url ?? '')
  const [saved, setSaved] = useState(false)
  const [profileError, setProfileError] = useState('')
  const [photoBusy, setPhotoBusy] = useState(false)
  const [idCopied, setIdCopied] = useState(false)
  const [isDarkTheme, setIsDarkTheme] = useState(() => document.body.classList.contains('dark-theme'))
  const photoInput = useRef(null)
  const token = sessionStorage.getItem('talkie-token')

  const activeTheme = theme ?? (document.body.classList.contains('dark-theme') ? 'dark' : 'light')

  function toggleTheme() {
    const nextDark = activeTheme !== 'dark'
    if (onThemeChange) {
      onThemeChange(nextDark ? 'dark' : 'light')
    } else {
      document.body.classList.toggle('dark-theme', nextDark)
      try {
        localStorage.setItem('talkie-theme', nextDark ? 'dark' : 'light')
      } catch {
        // ignore storage issues in restricted browsers
      }
    }
    setIsDarkTheme(nextDark)
  }

  async function saveDisplayName() {
    setProfileError('')
    try {
      const response = await fetch(`${API_URL}/api/me`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: displayName }),
      })
      const result = await response.json()
      if (!response.ok) throw new Error(result.detail || 'Could not update your profile.')
      sessionStorage.setItem('talkie-user', JSON.stringify(result))
      onUserUpdate(result)
      setDisplayName(result.name)
      setSaved(true)
    } catch (error) {
      setProfileError(error.message.includes('Failed to fetch') ? 'Could not reach Talkie API.' : error.message)
    }
  }

  async function updatePicture(imageData) {
    setProfileError('')
    setPhotoBusy(true)
    try {
      const response = await fetch(`${API_URL}/api/me/profile-picture`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ image_data: imageData }),
      })
      const result = await response.json()
      if (!response.ok) throw new Error(result.detail || 'Could not update your profile picture.')
      sessionStorage.setItem('talkie-user', JSON.stringify(result))
      onUserUpdate(result)
      setAvatarUrl(result.avatar_url ?? '')
    } catch (error) {
      setProfileError(error.message.includes('Failed to fetch') ? 'Could not reach Talkie API.' : error.message)
    } finally {
      setPhotoBusy(false)
      if (photoInput.current) photoInput.current.value = ''
    }
  }

  function handlePictureChange(event) {
    const file = event.target.files?.[0]
    if (!file) return
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
      setProfileError('Choose a PNG, JPEG, or WebP image.')
      event.target.value = ''
      return
    }
    if (file.size > 2_000_000) {
      setProfileError('Profile pictures must be smaller than 2 MB.')
      event.target.value = ''
      return
    }
    const reader = new FileReader()
    reader.onload = () => updatePicture(reader.result)
    reader.onerror = () => setProfileError('That image file could not be read.')
    reader.readAsDataURL(file)
  }

  function signOut() {
    sessionStorage.removeItem('talkie-token')
    sessionStorage.removeItem('talkie-user')
    navigate('/login')
  }

  return (
    <div className="page-content settings-page">
      <header className="page-heading"><div><span className="page-eyebrow">YOUR SPACE</span><h1>Settings</h1><p>Make Talkie feel a little more like you.</p></div></header>
      <section className="settings-section">
        <div className="settings-section-heading"><h2>Profile</h2><p>This is how people in your spaces will see you.</p></div>
        <div className="profile-editor">
          <span className={`avatar yellow profile-avatar ${avatarUrl ? 'has-photo' : ''}`}>{avatarUrl ? <img src={avatarUrl} alt="Your profile" /> : displayName.slice(0, 2).toUpperCase()}</span>
          <div className="picture-actions"><button className="quiet-action" onClick={() => photoInput.current?.click()} disabled={!token || photoBusy}><ImagePlus size={15} /> {photoBusy ? 'Uploading...' : 'Change picture'}</button>{avatarUrl && <button className="icon-action" title="Remove profile picture" onClick={() => updatePicture(null)} disabled={!token || photoBusy}><Trash2 size={15} /></button>}<input ref={photoInput} className="photo-input" type="file" accept="image/png,image/jpeg,image/webp" onChange={handlePictureChange} /></div>
          <label>Display name<input maxLength={40} value={displayName} onChange={(event) => { setDisplayName(event.target.value); setSaved(false) }} /></label>
          <button className="primary-action" onClick={saveDisplayName} disabled={!token}>{saved ? <><Check size={16} /> Saved</> : 'Save changes'}</button>
        </div>
        {profileError && <p role="alert" className="profile-error">{profileError}</p>}
      </section>
      <section className="settings-section user-id-section">
        <div className="settings-section-heading"><h2>Your Talkie ID</h2><p>Share this unique ID so friends can send you a request.</p></div>
        <div className="user-id-row"><code>{user.id ?? 'Sign in to view your ID'}</code><button className="quiet-action" disabled={!user.id} onClick={async () => { await navigator.clipboard.writeText(user.id); setIdCopied(true); window.setTimeout(() => setIdCopied(false), 1800) }}>{idCopied ? <Check size={15} /> : <Copy size={15} />}{idCopied ? 'Copied' : 'Copy ID'}</button></div>
      </section>
      <section className="settings-section account-section">
        <div className="settings-section-heading"><h2>Account</h2><p>{token ? 'Your account is connected on this device.' : 'Sign in to sync your messages across devices.'}</p></div>
        {token ? <button className="quiet-action" onClick={signOut}><LogOut size={16} /> Sign out</button> : <div className="account-actions"><Link className="primary-action" to="/login"><LogIn size={16} /> Sign in</Link><Link className="quiet-action" to="/register"><UserPlus size={16} /> Create account</Link></div>}
      </section>
      <section className="settings-section appearance-section">
        <div className="settings-section-heading"><h2>Appearance</h2><p>Switch the workspace between bright and dark modes.</p></div>
        <div className="appearance-row">
          <button className="quiet-action" onClick={toggleTheme}>{isDarkTheme ? <Sun size={15} /> : <Moon size={15} />}{isDarkTheme ? 'Switch to light mode' : 'Switch to dark mode'}</button>
        </div>
      </section>
    </div>
  )
}

function AuthPage({ mode }) {
  const navigate = useNavigate()
  const [form, setForm] = useState({ name: '', email: '', password: '' })
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const isRegister = mode === 'register'

  async function submit(event) {
    event.preventDefault()
    setError('')
    setLoading(true)
    try {
      const response = await fetch(`${API_URL}/api/auth/${mode}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      })
      const result = await response.json()
      if (!response.ok) throw new Error(result.detail || 'We could not complete that request.')
      sessionStorage.setItem('talkie-token', result.access_token)
      sessionStorage.setItem('talkie-user', JSON.stringify(result.user))
      navigate('/chat')
    } catch (requestError) {
      setError(requestError.message.includes('Failed to fetch')
        ? 'Could not reach Talkie. Start the FastAPI server and try again.'
        : requestError.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <main className="auth-page">
      <Link to="/chat" className="auth-brand"><span><MessageCircle size={21} /></span> talkie</Link>
      <section className="auth-panel">
        <div className="auth-mark">{isRegister ? <UserPlus size={23} /> : <LogIn size={23} />}</div>
        <span className="page-eyebrow">A PLACE TO PICK UP WHERE YOU LEFT OFF</span>
        <h1>{isRegister ? 'Make yourself at home.' : 'Good to see you again.'}</h1>
        <p className="auth-intro">{isRegister ? 'Create an account and find your people.' : 'Sign in and get back to your conversations.'}</p>
        <form className="auth-form" onSubmit={submit}>
          {isRegister && <label>Your name<input autoComplete="name" required maxLength={40} value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="What should we call you?" /></label>}
          <label>Email address<input autoComplete="email" type="email" required value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} placeholder="you@example.com" /></label>
          <label>Password<input autoComplete={isRegister ? 'new-password' : 'current-password'} type="password" required minLength={8} value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} placeholder="At least 8 characters" /></label>
          {error && <p role="alert" className="auth-error">{error}</p>}
          <button className="auth-submit" type="submit" disabled={loading}>{loading ? 'One moment...' : isRegister ? 'Create your account' : 'Sign in'}<ArrowRight size={17} /></button>
        </form>
        <p className="auth-switch">{isRegister ? 'Already have an account?' : 'New around here?'} <Link to={isRegister ? '/login' : '/register'}>{isRegister ? 'Sign in' : 'Create an account'}</Link></p>
        <Link className="auth-back" to="/chat">Take a look around first</Link>
      </section>
      <div className="auth-footer">Small conversations. Good company.</div>
    </main>
  )
}

export function LoginPage() { return <AuthPage mode="login" /> }
export function RegisterPage() { return <AuthPage mode="register" /> }