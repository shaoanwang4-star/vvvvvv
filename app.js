/**
 * Manga Reader Platform — Application Logic (Local Implementation)
 *
 * Features:
 *   1. User auth (register/login with localStorage)
 *   2. Manga upload with multi-chapter support (publisher-only edit)
 *   3. Page-by-page reader with keyboard/touch navigation
 *   4. Danmaku (bullet comments) overlay on reader
 *   5. Friends system (search / add / accept / list)
 *
 * Storage: localStorage + IndexedDB (for image blobs)
 * File count: 2 (index.html + app.js)
 */

/* ==================== Local Storage Layer ==================== */
const Store = {
  USERS_KEY: 'mr_users',
  SESSION_KEY: 'mr_session',
  MANGAS_KEY: 'mr_mangas',
  DANMAKU_KEY: 'mr_danmaku',
  FRIENDS_KEY: 'mr_friends',
  IMAGE_DB: 'mr_images',

  _idb: null,

  async initIDB() {
    if (this._idb) return this._idb
    return new Promise((resolve) => {
      const req = indexedDB.open(this.IMAGE_DB, 1)
      req.onupgradeneeded = (e) => {
        const db = e.target.result
        if (!db.objectStoreNames.contains('images')) {
          db.createObjectStore('images', { keyPath: 'key' })
        }
      }
      req.onsuccess = (e) => { this._idb = e.target.result; resolve(this._idb) }
      req.onerror = () => resolve(null)
    })
  },

  async saveImage(key, blob) {
    const db = await this.initIDB()
    if (!db) return false
    return new Promise((resolve) => {
      const tx = db.transaction('images', 'readwrite')
      tx.objectStore('images').put({ key, blob })
      tx.oncomplete = () => resolve(true)
      tx.onerror = () => resolve(false)
    })
  },

  async getImage(key) {
    const db = await this.initIDB()
    if (!db) return null
    return new Promise((resolve) => {
      const tx = db.transaction('images', 'readonly')
      const req = tx.objectStore('images').get(key)
      req.onsuccess = () => resolve(req.result ? req.result.blob : null)
      req.onerror = () => resolve(null)
    })
  },

  async deleteImage(key) {
    const db = await this.initIDB()
    if (!db) return
    return new Promise((resolve) => {
      const tx = db.transaction('images', 'readwrite')
      tx.objectStore('images').delete(key)
      tx.oncomplete = () => resolve(true)
      tx.onerror = () => resolve(false)
    })
  },

  get(key, def) {
    try {
      const v = localStorage.getItem(key)
      return v ? JSON.parse(v) : (def !== undefined ? def : null)
    } catch { return def !== undefined ? def : null }
  },

  set(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)) } catch (e) {
      console.error('Storage full:', e)
    }
  },

  genId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2, 8)
  },

  hashPass(pass) {
    // Simple hash for local-only (not for production security)
    let h = 0
    for (let i = 0; i < pass.length; i++) {
      h = ((h << 5) - h + pass.charCodeAt(i)) | 0
    }
    return 'h' + Math.abs(h).toString(36)
  },
}

/* ==================== App ==================== */
const App = {
  session: null,
  currentView: 'home',
  mangas: [],
  filteredMangas: [],
  myWorks: [],
  currentManga: null,
  currentChapter: null,
  currentPageIndex: 0,
  currentPageUrls: [],
  readerDanmaku: [],
  danmakuVisible: true,
  danmakuTimers: [],
  pendingCoverFile: null,
  pendingCoverUrl: null,
  chapters: [],
  editingMangaId: null,
  friends: [],
  pendingRequests: [],
  authTab: 'login',

  // ===================== INIT =====================
  async init() {
    // Restore session
    const saved = Store.get(Store.SESSION_KEY)
    if (saved && saved.userId) {
      const users = Store.get(Store.USERS_KEY, [])
      const user = users.find(u => u.id === saved.userId)
      if (user) {
        this.session = { id: user.id, nickname: user.nickname, email: user.email }
        this.showAppView()
        await this.loadMangas()
        return
      }
    }
    this.showAuthView()
  },

  // ===================== AUTH =====================
  switchAuthTab(tab) {
    this.authTab = tab
    document.querySelectorAll('.auth-tab').forEach(el => el.classList.toggle('active', el.dataset.authtab === tab))
    document.getElementById('authLoginForm').style.display = tab === 'login' ? 'block' : 'none'
    document.getElementById('authRegisterForm').style.display = tab === 'register' ? 'block' : 'none'
  },

  doLogin() {
    const nameOrEmail = document.getElementById('loginName').value.trim()
    const pass = document.getElementById('loginPass').value
    const errEl = document.getElementById('loginError')
    errEl.textContent = ''

    if (!nameOrEmail || !pass) { errEl.textContent = '请填写所有字段'; return }

    const users = Store.get(Store.USERS_KEY, [])
    const user = users.find(u =>
      (u.nickname === nameOrEmail || u.email === nameOrEmail) &&
      u.password === Store.hashPass(pass)
    )

    if (!user) { errEl.textContent = '用户名或密码错误'; return }

    this.session = { id: user.id, nickname: user.nickname, email: user.email }
    Store.set(Store.SESSION_KEY, { userId: user.id })
    this.showToast('登录成功', 'success')
    this.showAppView()
    this.navigate('home')
  },

  doRegister() {
    const nickname = document.getElementById('regNickname').value.trim()
    const email = document.getElementById('regEmail').value.trim()
    const pass = document.getElementById('regPass').value
    const errEl = document.getElementById('regError')
    errEl.textContent = ''

    if (!nickname || !email || !pass) { errEl.textContent = '请填写所有字段'; return }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { errEl.textContent = '邮箱格式不正确'; return }
    if (pass.length < 4) { errEl.textContent = '密码至少4位'; return }

    const users = Store.get(Store.USERS_KEY, [])
    if (users.find(u => u.email === email)) { errEl.textContent = '该邮箱已注册'; return }
    if (users.find(u => u.nickname === nickname)) { errEl.textContent = '该昵称已被使用'; return }

    const user = {
      id: Store.genId(),
      nickname, email,
      password: Store.hashPass(pass),
      createdAt: new Date().toISOString(),
    }
    users.push(user)
    Store.set(Store.USERS_KEY, users)

    this.session = { id: user.id, nickname: user.nickname, email: user.email }
    Store.set(Store.SESSION_KEY, { userId: user.id })
    this.showToast('注册成功', 'success')
    this.showAppView()
    this.navigate('home')
  },

  logout() {
    localStorage.removeItem(Store.SESSION_KEY)
    this.session = null
    this.showToast('已退出登录', 'info')
    this.showAuthView()
  },

  // ===================== NAVIGATION =====================
  navigate(view) {
    this.currentView = view
    document.querySelectorAll('.view').forEach(el => el.classList.remove('active'))
    const viewEl = document.getElementById('view-' + view)
    if (viewEl) viewEl.classList.add('active')
    document.querySelectorAll('.nav-link').forEach(el => el.classList.toggle('active', el.dataset.view === view))

    if (view === 'home') this.loadMangas()
    if (view === 'upload') this.resetUploadForm()
    if (view === 'myworks') this.loadMyWorks()
    if (view === 'friends') this.loadFriends()
  },

  showAuthView() {
    document.getElementById('authView').style.display = 'flex'
    document.getElementById('navbar').style.display = 'none'
    document.getElementById('mainContent').style.display = 'none'
  },

  showAppView() {
    document.getElementById('authView').style.display = 'none'
    document.getElementById('navbar').style.display = 'flex'
    document.getElementById('mainContent').style.display = 'block'
    if (this.session) {
      document.getElementById('navUserName').textContent = this.session.nickname
      document.getElementById('navAvatar').textContent = this.session.nickname.charAt(0).toUpperCase()
    }
  },

  // ===================== MANGA LIST =====================
  async loadMangas() {
    const grid = document.getElementById('mangaGrid')
    grid.innerHTML = '<div class="loading-overlay"><div class="loading-spinner"></div></div>'

    const all = Store.get(Store.MANGAS_KEY, [])
    this.mangas = all.filter(m => m.status === 'published')
    this.filteredMangas = this.mangas

    // Resolve cover URLs from IndexedDB
    for (const m of this.mangas) {
      if (m.coverKey) {
        const blob = await Store.getImage(m.coverKey)
        m._coverUrl = blob ? URL.createObjectURL(blob) : null
      }
    }

    this.renderMangaGrid()
  },

  renderMangaGrid() {
    const grid = document.getElementById('mangaGrid')
    if (this.filteredMangas.length === 0) {
      grid.innerHTML = '<div class="empty-state"><div class="empty-state-icon">📚</div><div class="empty-state-text">暂无漫画</div></div>'
      return
    }
    grid.innerHTML = this.filteredMangas.map(m => `
      <div class="manga-card" onclick="App.openMangaDetail('${m.id}')">
        <div class="manga-cover">
          ${m._coverUrl ? `<img src="${m._coverUrl}" alt="${this.esc(m.title)}">` : '<div class="manga-cover-placeholder">📖</div>'}
        </div>
        <div class="manga-info">
          <div class="manga-title">${this.esc(m.title)}</div>
          <div class="manga-meta"><span>${this.esc(m.author || '未知')}</span></div>
        </div>
      </div>
    `).join('')
  },

  searchMangas(query) {
    if (!query) {
      this.filteredMangas = this.mangas
    } else {
      const q = query.toLowerCase()
      this.filteredMangas = this.mangas.filter(m =>
        (m.title || '').toLowerCase().includes(q) ||
        (m.author || '').toLowerCase().includes(q) ||
        (m.tags || []).some(t => t.toLowerCase().includes(q))
      )
    }
    this.renderMangaGrid()
  },

  // ===================== MANGA DETAIL =====================
  async openMangaDetail(mangaId) {
    this.navigate('detail')
    const container = document.getElementById('detailContent')
    container.innerHTML = '<div class="loading-overlay"><div class="loading-spinner"></div></div>'

    const all = Store.get(Store.MANGAS_KEY, [])
    const manga = all.find(m => m.id === mangaId)
    if (!manga) {
      container.innerHTML = '<div class="empty-state"><div class="empty-state-text">漫画不存在</div></div>'
      return
    }

    this.currentManga = manga

    // Resolve cover URL
    if (manga.coverKey) {
      const blob = await Store.getImage(manga.coverKey)
      manga._coverUrl = blob ? URL.createObjectURL(blob) : null
    }

    const isOwner = this.session && manga.ownerId === this.session.id
    const chapters = manga.chapters || []
    const tagsHtml = (manga.tags || []).map(t => `<span class="tag">${this.esc(t)}</span>`).join('')

    container.innerHTML = `
      <div class="manga-detail">
        <div class="manga-detail-cover">
          ${manga._coverUrl ? `<img src="${manga._coverUrl}" alt="${this.esc(manga.title)}">` : '<div style="display:flex;align-items:center;justify-content:center;height:100%;font-size:40px;color:var(--text-dim);">📖</div>'}
        </div>
        <div class="manga-detail-info">
          <h1>${this.esc(manga.title)}</h1>
          <div class="manga-detail-author">作者: ${this.esc(manga.author || '未知')} · 发布者: ${this.esc(manga.ownerName || '匿名')}</div>
          <div style="margin-bottom:12px;">${tagsHtml}</div>
          <div class="manga-detail-desc">${this.esc(manga.description || '暂无简介')}</div>
          <div class="manga-detail-actions">
            ${chapters.length > 0
              ? `<button class="btn btn-primary" onclick="App.startReading('${manga.id}', 0)">开始阅读</button>`
              : '<span style="color:var(--text-muted);">暂无章节</span>'}
            ${isOwner ? `<button class="btn btn-secondary" onclick="App.openEditModal()">编辑</button>` : ''}
            ${isOwner ? `<button class="btn btn-secondary" onclick="App.openWatermarkModal()">版权保护</button>` : ''}
            ${isOwner ? `<button class="btn btn-danger" onclick="App.openDeleteModal('manga')">删除</button>` : ''}
          </div>
          <div style="margin-top:24px;">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;">
              <h3>章节列表 (${chapters.length})</h3>
              ${isOwner ? `<button class="btn btn-secondary btn-sm" onclick="App.openChapterEditModal(0)">管理页面</button>` : ''}
            </div>
            <div class="chapter-list">
              ${chapters.map((ch, i) => `
                <div class="chapter-item" onclick="App.startReading('${manga.id}', ${i})">
                  <span class="chapter-name">第${i+1}话 ${this.esc(ch.title)}</span>
                  <span class="chapter-date">${ch.pageCount} 页 · ${this.fmtDate(ch.createdAt)}${isOwner ? ` · <a onclick="event.stopPropagation();App.openChapterEditModal(${i})" style="color:var(--primary);cursor:pointer;">编辑页面</a>` : ''}</span>
                </div>
              `).join('') || '<div class="empty-state-text">暂无章节</div>'}
            </div>
          </div>
        </div>
      </div>
    `
  },

  // ===================== READER =====================
  async startReading(mangaId, chapterIdx) {
    const all = Store.get(Store.MANGAS_KEY, [])
    const manga = all.find(m => m.id === mangaId)
    if (!manga || !manga.chapters || manga.chapters.length === 0) {
      this.showToast('章节不存在', 'error'); return
    }

    const chapter = manga.chapters[chapterIdx]
    if (!chapter) { this.showToast('章节不存在', 'error'); return }

    this.currentManga = manga
    this.currentChapter = { ...chapter, mangaId, chapterIdx }
    this.currentPageIndex = 0

    // Load page images from IndexedDB
    this.currentPageUrls = []
    for (const pageKey of chapter.pageKeys || []) {
      const blob = await Store.getImage(pageKey)
      if (blob) {
        this.currentPageUrls.push(URL.createObjectURL(blob))
      } else {
        this.currentPageUrls.push('')
      }
    }

    // Load danmaku for this chapter
    const allDm = Store.get(Store.DANMAKU_KEY, [])
    this.readerDanmaku = allDm.filter(d => d.mangaId === mangaId && d.chapterIdx === chapterIdx)

    document.getElementById('readerTitle').textContent = `${manga.title} - ${chapter.title}`
    document.getElementById('readerContainer').classList.add('active')
    this.setupVolumeKeyNav()

    // Setup anti-theft protection
    this.setupAntiTheft(manga)

    this.renderReaderPage()
  },

  renderReaderPage() {
    const img = document.getElementById('readerPageImg')
    const info = document.getElementById('readerPageInfo')

    if (this.currentPageUrls.length === 0) {
      img.src = ''; img.alt = '暂无页面'
      info.textContent = '暂无图片'
      document.getElementById('readerPrev').disabled = true
      document.getElementById('readerNext').disabled = true
      return
    }

    img.src = this.currentPageUrls[this.currentPageIndex]
    info.textContent = `第 ${this.currentPageIndex + 1} / ${this.currentPageUrls.length} 页`
    document.getElementById('readerPrev').disabled = this.currentPageIndex === 0
    document.getElementById('readerNext').disabled = this.currentPageIndex === this.currentPageUrls.length - 1

    // Update page jump input
    const jumpInput = document.getElementById('readerPageJump')
    if (jumpInput) { jumpInput.max = this.currentPageUrls.length; jumpInput.value = this.currentPageIndex + 1 }

    // Render watermark
    this.renderWatermark()

    this.displayPageDanmaku()
  },

  prevPage() {
    if (this.currentPageIndex > 0) { this.currentPageIndex--; this.renderReaderPage() }
  },

  nextPage() {
    if (this.currentPageIndex < this.currentPageUrls.length - 1) { this.currentPageIndex++; this.renderReaderPage() }
  },

  closeReader() {
    document.getElementById('readerContainer').classList.remove('active')
    this.clearDanmakuTimers()
    document.getElementById('danmakuLayer').innerHTML = ''
    const wmLayer = document.getElementById('watermarkLayer')
    if (wmLayer) wmLayer.innerHTML = ''
    // Stop silent audio for volume key nav
    if (this._silentAudio) { this._silentAudio.pause() }
    this.currentChapter = null
  },

  // Keyboard navigation for reader
  onKeydown(e) {
    if (!document.getElementById('readerContainer').classList.contains('active')) return

    // PC: WASD keys
    if (e.key === 'a' || e.key === 'A') { e.preventDefault(); this.prevPage() }
    else if (e.key === 'd' || e.key === 'D') { e.preventDefault(); this.nextPage() }
    // Arrow keys (existing)
    else if (e.key === 'ArrowLeft') { e.preventDefault(); this.prevPage() }
    else if (e.key === 'ArrowRight') { e.preventDefault(); this.nextPage() }
    else if (e.key === 'Escape') { e.preventDefault(); this.closeReader() }
  },

  // Phone volume key navigation (via MediaSession API or key events)
  _volumeHandlerBound: false,
  setupVolumeKeyNav() {
    if (this._volumeHandlerBound) return
    this._volumeHandlerBound = true

    // Use MediaSession API to capture volume button presses on mobile
    if ('mediaSession' in navigator) {
      try {
        // Create a silent audio element to enable media session
        if (!this._silentAudio) {
          this._silentAudio = new Audio()
          this._silentAudio.loop = true
          // Minimal silent WAV data URI
          this._silentAudio.src = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA='
        }
        this._silentAudio.play().catch(() => {})

        navigator.mediaSession.metadata = new MediaMetadata({ title: 'Manga Reader', artist: 'Reading' })
        navigator.mediaSession.setActionHandler('previoustrack', () => { this.prevPage() })
        navigator.mediaSession.setActionHandler('nexttrack', () => { this.nextPage() })
      } catch (e) { /* not supported */ }
    }

    // Some mobile browsers fire keydown for volume buttons
    document.addEventListener('keydown', (e) => {
      if (!document.getElementById('readerContainer').classList.contains('active')) return
      if (e.key === 'AudioVolumeUp') { e.preventDefault(); this.prevPage() }
      else if (e.key === 'AudioVolumeDown') { e.preventDefault(); this.nextPage() }
    })
  },

  // Jump to specific page
  jumpToPage(idx) {
    if (idx >= 0 && idx < this.currentPageUrls.length) {
      this.currentPageIndex = idx
      this.renderReaderPage()
    }
  },

  // ===================== DANMAKU =====================
  displayPageDanmaku() {
    this.clearDanmakuTimers()
    const layer = document.getElementById('danmakuLayer')
    layer.innerHTML = ''
    if (!this.danmakuVisible) return

    const pageDm = this.readerDanmaku.filter(d => d.pageIndex === this.currentPageIndex)
    if (pageDm.length === 0) return

    const containerH = document.getElementById('readerPageContainer').clientHeight
    const tracks = Math.max(3, Math.floor(containerH / 40))

    pageDm.forEach((dm, i) => {
      const track = i % tracks
      const delay = i * 0.4

      const t = setTimeout(() => {
        if (this.currentPageIndex !== dm.pageIndex || !this.danmakuVisible) return
        const el = document.createElement('div')
        el.className = 'danmaku-item'
        el.textContent = dm.content
        el.style.color = dm.color || '#fff'
        el.style.top = `${track * 40 + 10}px`
        el.style.animationDuration = `${8 + Math.random() * 4}s`
        layer.appendChild(el)
        const rt = setTimeout(() => { if (el.parentNode) el.parentNode.removeChild(el) }, 13000)
        this.danmakuTimers.push(rt)
      }, delay * 1000)
      this.danmakuTimers.push(t)
    })
  },

  async sendDanmaku() {
    const input = document.getElementById('danmakuInput')
    const content = input.value.trim()
    if (!content || !this.currentChapter) return
    input.value = ''

    const dm = {
      id: Store.genId(),
      mangaId: this.currentChapter.mangaId,
      chapterIdx: this.currentChapter.chapterIdx,
      pageIndex: this.currentPageIndex,
      content,
      color: '#ffffff',
      userId: this.session.id,
      userName: this.session.nickname,
      createdAt: new Date().toISOString(),
    }

    // Save to store
    const allDm = Store.get(Store.DANMAKU_KEY, [])
    allDm.push(dm)
    Store.set(Store.DANMAKU_KEY, allDm)

    this.readerDanmaku.push(dm)

    // Display immediately
    if (this.danmakuVisible) {
      const layer = document.getElementById('danmakuLayer')
      const el = document.createElement('div')
      el.className = 'danmaku-item'
      el.textContent = content
      el.style.color = '#fff'
      el.style.top = `${Math.random() * 200 + 10}px`
      el.style.animationDuration = `${8 + Math.random() * 4}s`
      layer.appendChild(el)
      const rt = setTimeout(() => { if (el.parentNode) el.parentNode.removeChild(el) }, 13000)
      this.danmakuTimers.push(rt)
    }
  },

  toggleDanmaku() {
    this.danmakuVisible = !this.danmakuVisible
    const btn = document.getElementById('danmakuToggleBtn')
    if (this.danmakuVisible) {
      btn.textContent = '弹幕 开'; btn.classList.remove('off'); btn.classList.add('on')
      this.displayPageDanmaku()
    } else {
      btn.textContent = '弹幕 关'; btn.classList.add('off'); btn.classList.remove('on')
      document.getElementById('danmakuLayer').innerHTML = ''
      this.clearDanmakuTimers()
    }
  },

  clearDanmakuTimers() {
    this.danmakuTimers.forEach(t => clearTimeout(t))
    this.danmakuTimers = []
  },

  // ===================== UPLOAD =====================
  resetUploadForm() {
    document.getElementById('uploadTitle').value = ''
    document.getElementById('uploadAuthor').value = ''
    document.getElementById('uploadDesc').value = ''
    document.getElementById('uploadTags').value = ''
    document.getElementById('coverPreview').style.display = 'none'
    document.getElementById('coverPreviewImg').src = ''
    document.getElementById('coverFileInput').value = ''
    this.pendingCoverFile = null
    this.pendingCoverUrl = null
    this.chapters = []
    this.renderChapters()
  },

  onCoverSelected(input) {
    const file = input.files[0]
    if (!file) return
    if (!file.type.startsWith('image/')) { this.showToast('请选择图片文件', 'error'); return }
    if (file.size > 10 * 1024 * 1024) { this.showToast('封面不能超过10MB', 'error'); return }
    this.pendingCoverFile = file
    this.pendingCoverUrl = URL.createObjectURL(file)
    document.getElementById('coverPreviewImg').src = this.pendingCoverUrl
    document.getElementById('coverPreview').style.display = 'block'
  },

  removeCover() {
    this.pendingCoverFile = null
    this.pendingCoverUrl = null
    document.getElementById('coverPreview').style.display = 'none'
    document.getElementById('coverFileInput').value = ''
  },

  addChapter() {
    this.chapters.push({ title: `第${this.chapters.length + 1}话`, files: [], previews: [] })
    this.renderChapters()
  },

  removeChapter(idx) {
    this.chapters.splice(idx, 1)
    this.renderChapters()
  },

  updateChapterTitle(idx, value) {
    this.chapters[idx].title = value
  },

  onChapterPagesSelected(idx, input) {
    const files = Array.from(input.files)
    if (files.length === 0) return
    for (const f of files) {
      if (!f.type.startsWith('image/')) { this.showToast(`${f.name} 不是图片`, 'error'); return }
      if (f.size > 15 * 1024 * 1024) { this.showToast(`${f.name} 超过15MB`, 'error'); return }
    }
    files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
    this.chapters[idx].files = files
    this.chapters[idx].previews = files.map(f => URL.createObjectURL(f))
    this.renderChapters()
  },

  renderChapters() {
    const container = document.getElementById('chaptersContainer')
    if (this.chapters.length === 0) {
      container.innerHTML = '<div style="color:var(--text-muted);font-size:13px;">点击下方按钮添加章节</div>'
      return
    }
    container.innerHTML = this.chapters.map((ch, idx) => `
      <div class="card" style="margin-bottom:12px;background:var(--bg-input);">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
          <input class="form-input" style="flex:1;" value="${this.esc(ch.title)}" onchange="App.updateChapterTitle(${idx}, this.value)" placeholder="章节标题">
          <button class="btn btn-danger btn-sm" onclick="App.removeChapter(${idx})">删除</button>
        </div>
        <div class="upload-area" style="padding:20px;" onclick="document.getElementById('chapterFiles${idx}').click()">
          <div class="upload-icon" style="font-size:24px;">📄</div>
          <div class="upload-text">${ch.files.length > 0 ? `${ch.files.length} 张图片已选择` : '选择本章节图片'}</div>
        </div>
        <input type="file" id="chapterFiles${idx}" accept="image/*" multiple style="display:none;" onchange="App.onChapterPagesSelected(${idx}, this)">
        ${ch.previews.length > 0 ? `
          <div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:8px;">
            ${ch.previews.map((url, pi) => `<div style="position:relative;"><img src="${url}" style="width:48px;height:48px;object-fit:cover;border-radius:4px;"><button onclick="App.editUploadPageInEditor(${idx},${pi})" style="position:absolute;top:-4px;right:-4px;width:16px;height:16px;border-radius:50%;background:var(--primary);border:none;color:#fff;font-size:10px;cursor:pointer;" title="编辑">✎</button></div>`).join('')}
            ${ch.previews.length > 8 ? `<div style="display:flex;align-items:center;color:var(--text-muted);font-size:12px;padding:0 8px;">+${ch.previews.length - 8} 张</div>` : ''}
          </div>
        ` : ''}
      </div>
    `).join('')
  },

  async publishManga() {
    const title = document.getElementById('uploadTitle').value.trim()
    const author = document.getElementById('uploadAuthor').value.trim()
    const desc = document.getElementById('uploadDesc').value.trim()
    const tagsStr = document.getElementById('uploadTags').value.trim()
    const tags = tagsStr ? tagsStr.split(',').map(t => t.trim()).filter(Boolean) : []

    if (!title) { this.showToast('请输入标题', 'error'); return }
    if (!this.pendingCoverFile) { this.showToast('请选择封面', 'error'); return }
    if (this.chapters.length === 0) { this.showToast('请至少添加一个章节', 'error'); return }
    for (let i = 0; i < this.chapters.length; i++) {
      if (this.chapters[i].files.length === 0) { this.showToast(`第${i+1}章没有图片`, 'error'); return }
    }

    const btn = document.getElementById('publishBtn')
    btn.disabled = true; btn.textContent = '发布中...'

    try {
      const mangaId = Store.genId()

      // Save cover to IndexedDB
      const coverKey = `${mangaId}_cover`
      await Store.saveImage(coverKey, this.pendingCoverFile)

      // Save chapter pages to IndexedDB
      const chaptersData = []
      for (let i = 0; i < this.chapters.length; i++) {
        const ch = this.chapters[i]
        const pageKeys = []
        for (let j = 0; j < ch.files.length; j++) {
          const pageKey = `${mangaId}_ch${i}_page${j}`
          await Store.saveImage(pageKey, ch.files[j])
          pageKeys.push(pageKey)
        }
        chaptersData.push({
          id: Store.genId(),
          title: ch.title,
          sortIdx: i,
          pageCount: ch.files.length,
          pageKeys,
          createdAt: new Date().toISOString(),
        })
      }

      // Create manga record
      const manga = {
        id: mangaId,
        title, author: author || null, description: desc || null,
        tags, status: 'published',
        ownerId: this.session.id,
        ownerName: this.session.nickname,
        coverKey,
        chapters: chaptersData,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }

      const all = Store.get(Store.MANGAS_KEY, [])
      all.push(manga)
      Store.set(Store.MANGAS_KEY, all)

      this.showToast('漫画发布成功！', 'success')
      this.resetUploadForm()
      this.navigate('home')
    } catch (e) {
      this.showToast('发布失败: ' + (e.message || ''), 'error')
    } finally {
      btn.disabled = false; btn.textContent = '发布漫画'
    }
  },

  // ===================== MY WORKS =====================
  async loadMyWorks() {
    const grid = document.getElementById('myWorksGrid')
    grid.innerHTML = '<div class="loading-overlay"><div class="loading-spinner"></div></div>'

    const all = Store.get(Store.MANGAS_KEY, [])
    this.myWorks = all.filter(m => m.ownerId === this.session.id)

    for (const m of this.myWorks) {
      if (m.coverKey) {
        const blob = await Store.getImage(m.coverKey)
        m._coverUrl = blob ? URL.createObjectURL(blob) : null
      }
    }

    if (this.myWorks.length === 0) {
      grid.innerHTML = '<div class="empty-state"><div class="empty-state-icon">✍️</div><div class="empty-state-text">你还没有发布作品<br><button class="btn btn-primary btn-sm" style="margin-top:12px;" onclick="App.navigate(\'upload\')">去上传</button></div></div>'
      return
    }

    grid.innerHTML = this.myWorks.map(m => `
      <div class="manga-card" onclick="App.openMangaDetail('${m.id}')">
        <div class="manga-cover">
          ${m._coverUrl ? `<img src="${m._coverUrl}" alt="${this.esc(m.title)}">` : '<div class="manga-cover-placeholder">📖</div>'}
        </div>
        <div class="manga-info">
          <div class="manga-title">${this.esc(m.title)}</div>
          <div class="manga-meta"><span class="badge badge-success">已发布</span></div>
        </div>
      </div>
    `).join('')
  },

  // ===================== EDIT (Publisher Only) =====================
  openEditModal() {
    if (!this.currentManga) return
    // CRITICAL: only the publisher (owner) can edit
    if (this.currentManga.ownerId !== this.session.id) {
      this.showToast('只有发布者才能编辑', 'error'); return
    }
    this.editingMangaId = this.currentManga.id
    document.getElementById('editTitle').value = this.currentManga.title || ''
    document.getElementById('editAuthor').value = this.currentManga.author || ''
    document.getElementById('editDesc').value = this.currentManga.description || ''
    document.getElementById('editTags').value = (this.currentManga.tags || []).join(', ')
    document.getElementById('editModal').classList.add('active')
  },

  closeEditModal() {
    document.getElementById('editModal').classList.remove('active')
    this.editingMangaId = null
  },

  saveEditManga() {
    if (!this.editingMangaId || !this.currentManga) return
    if (this.currentManga.ownerId !== this.session.id) {
      this.showToast('只有发布者才能编辑', 'error'); return
    }

    const title = document.getElementById('editTitle').value.trim()
    const author = document.getElementById('editAuthor').value.trim()
    const desc = document.getElementById('editDesc').value.trim()
    const tagsStr = document.getElementById('editTags').value.trim()
    const tags = tagsStr ? tagsStr.split(',').map(t => t.trim()).filter(Boolean) : []

    if (!title) { this.showToast('标题不能为空', 'error'); return }

    const all = Store.get(Store.MANGAS_KEY, [])
    const manga = all.find(m => m.id === this.editingMangaId)
    if (!manga) { this.showToast('漫画不存在', 'error'); return }
    if (manga.ownerId !== this.session.id) { this.showToast('只有发布者才能编辑', 'error'); return }

    manga.title = title
    manga.author = author || null
    manga.description = desc || null
    manga.tags = tags
    manga.updatedAt = new Date().toISOString()

    Store.set(Store.MANGAS_KEY, all)
    this.showToast('修改成功', 'success')
    const id = this.editingMangaId
    this.closeEditModal()
    this.openMangaDetail(id)
  },

  // ===================== FRIENDS =====================
  async loadFriends() {
    this.loadPendingRequests()
    this.loadFriendList()
  },

  loadPendingRequests() {
    const list = document.getElementById('pendingList')
    const all = Store.get(Store.FRIENDS_KEY, [])
    const pending = all.filter(f =>
      f.targetId === this.session.id && f.status === 'pending'
    )

    if (pending.length === 0) {
      list.innerHTML = '<div style="color:var(--text-muted);font-size:13px;padding:8px;">暂无好友请求</div>'
      return
    }

    list.innerHTML = pending.map(f => `
      <div class="friend-item">
        <div class="user-avatar">${this.esc(f.requesterName.charAt(0).toUpperCase())}</div>
        <div class="friend-info"><div class="friend-name">${this.esc(f.requesterName)}</div><div class="friend-status">请求加你为好友</div></div>
        <button class="btn btn-primary btn-sm" onclick="App.acceptFriend('${f.id}')">接受</button>
      </div>
    `).join('')
  },

  async loadFriendList() {
    const list = document.getElementById('friendsList')
    const all = Store.get(Store.FRIENDS_KEY, [])
    const myId = this.session.id

    this.friends = all.filter(f =>
      f.status === 'accepted' && (f.requesterId === myId || f.targetId === myId)
    )

    if (this.friends.length === 0) {
      list.innerHTML = '<div class="empty-state"><div class="empty-state-icon">👥</div><div class="empty-state-text">还没有好友<br>去搜索添加吧！</div></div>'
      return
    }

    list.innerHTML = this.friends.map(f => {
      const name = f.requesterId === myId ? f.targetName : f.requesterName
      return `
        <div class="friend-item">
          <div class="user-avatar">${this.esc(name.charAt(0).toUpperCase())}</div>
          <div class="friend-info"><div class="friend-name">${this.esc(name)}</div><div class="friend-status">好友</div></div>
        </div>
      `
    }).join('')
  },

  searchUsers() {
    const query = document.getElementById('friendSearchInput').value.trim()
    const results = document.getElementById('searchResults')

    if (!query) { results.innerHTML = '<div style="color:var(--text-muted);font-size:13px;padding:8px;">请输入搜索内容</div>'; return }

    const users = Store.get(Store.USERS_KEY, [])
    const filtered = users.filter(u =>
      u.id !== this.session.id &&
      (u.nickname.toLowerCase().includes(query.toLowerCase()) || u.email.toLowerCase().includes(query.toLowerCase()))
    )

    if (filtered.length === 0) {
      results.innerHTML = '<div style="color:var(--text-muted);font-size:13px;padding:8px;">未找到用户</div>'
      return
    }

    // Check existing friendships
    const allFriends = Store.get(Store.FRIENDS_KEY, [])
    const myId = this.session.id

    results.innerHTML = filtered.map(u => {
      const existing = allFriends.find(f =>
        (f.requesterId === myId && f.targetId === u.id) ||
        (f.requesterId === u.id && f.targetId === myId)
      )
      let actionHtml = ''
      if (existing?.status === 'accepted') {
        actionHtml = '<span class="badge badge-success">已好友</span>'
      } else if (existing?.status === 'pending') {
        actionHtml = '<span class="badge badge-warning">待确认</span>'
      } else {
        actionHtml = `<button class="btn btn-primary btn-sm" onclick="App.addFriend('${u.id}', '${this.escAttr(u.nickname)}')">加好友</button>`
      }
      return `
        <div class="friend-item">
          <div class="user-avatar">${this.esc(u.nickname.charAt(0).toUpperCase())}</div>
          <div class="friend-info"><div class="friend-name">${this.esc(u.nickname)}</div></div>
          ${actionHtml}
        </div>
      `
    }).join('')
  },

  addFriend(targetId, targetName) {
    const all = Store.get(Store.FRIENDS_KEY, [])
    const myId = this.session.id

    // Check existing
    const existing = all.find(f =>
      (f.requesterId === myId && f.targetId === targetId) ||
      (f.requesterId === targetId && f.targetId === myId)
    )
    if (existing) { this.showToast('已发送过好友请求', 'info'); return }

    all.push({
      id: Store.genId(),
      requesterId: myId,
      requesterName: this.session.nickname,
      targetId,
      targetName,
      status: 'pending',
      createdAt: new Date().toISOString(),
    })
    Store.set(Store.FRIENDS_KEY, all)
    this.showToast('好友请求已发送', 'success')
    this.searchUsers()
  },

  acceptFriend(friendshipId) {
    const all = Store.get(Store.FRIENDS_KEY, [])
    const f = all.find(x => x.id === friendshipId)
    if (!f) return
    if (f.targetId !== this.session.id) { this.showToast('无权操作', 'error'); return }

    f.status = 'accepted'
    Store.set(Store.FRIENDS_KEY, all)
    this.showToast('已添加好友', 'success')
    this.loadFriends()
  },

  // ===================== UTILS =====================
  esc(str) {
    if (str == null) return ''
    const d = document.createElement('div')
    d.textContent = String(str)
    return d.innerHTML
  },

  escAttr(str) {
    // For use inside inline onclick string parameters — escapes quotes and angle brackets
    if (str == null) return ''
    return String(str).replace(/'/g, "\\'").replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  },

  fmtDate(dateStr) {
    if (!dateStr) return ''
    const d = new Date(dateStr)
    return `${d.getMonth() + 1}月${d.getDate()}日`
  },

  showToast(msg, type) {
    type = type || 'info'
    const container = document.getElementById('toastContainer')
    const toast = document.createElement('div')
    toast.className = `toast toast-${type}`
    toast.textContent = msg
    container.appendChild(toast)
    setTimeout(() => { if (toast.parentNode) toast.parentNode.removeChild(toast) }, 3000)
  },

  // ===================== ANTI-THEFT / WATERMARK =====================
  setupAntiTheatHandlersBound: false,
  setupAntiTheft(manga) {
    const img = document.getElementById('readerPageImg')
    // Disable context menu on reader
    img.oncontextmenu = (e) => { e.preventDefault(); this.showToast('图片受版权保护，禁止保存', 'info'); return false }
    // Disable drag
    img.ondragstart = () => false
    // Disable selection
    img.style.userSelect = 'none'
    img.style.webkitUserDrag = 'none'

    // Also protect the reader container
    const container = document.getElementById('readerPageContainer')
    container.oncontextmenu = (e) => { e.preventDefault(); return false }
  },

  renderWatermark() {
    const layer = document.getElementById('watermarkLayer')
    if (!layer) return
    layer.innerHTML = ''

    if (!this.currentManga) return
    const enableWatermark = this.currentManga.watermark !== false // default on
    if (!enableWatermark) return

    const author = this.currentManga.author || this.currentManga.ownerName || 'MangaReader'
    const title = this.currentManga.title || ''
    const watermarkText = `${author} © ${title}`

    // Create tiled watermark text across the image area
    const containerW = document.getElementById('readerPageContainer').clientWidth
    const containerH = document.getElementById('readerPageContainer').clientHeight

    const tileSize = 200
    const cols = Math.ceil(containerW / tileSize) + 1
    const rows = Math.ceil(containerH / tileSize) + 1

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const tile = document.createElement('div')
        tile.className = 'watermark-tile'
        tile.textContent = watermarkText
        tile.style.left = `${c * tileSize - 50}px`
        tile.style.top = `${r * tileSize + 30}px`
        layer.appendChild(tile)
      }
    }
  },

  openWatermarkModal() {
    if (!this.currentManga) return
    if (this.currentManga.ownerId !== this.session.id) {
      this.showToast('只有发布者才能修改版权设置', 'error'); return
    }
    const toggle = document.getElementById('watermarkToggle')
    toggle.checked = this.currentManga.watermark !== false
    document.getElementById('watermarkModal').classList.add('active')
  },

  closeWatermarkModal() {
    document.getElementById('watermarkModal').classList.remove('active')
  },

  saveWatermarkSetting() {
    if (!this.currentManga || this.currentManga.ownerId !== this.session.id) return
    const enable = document.getElementById('watermarkToggle').checked

    const all = Store.get(Store.MANGAS_KEY, [])
    const manga = all.find(m => m.id === this.currentManga.id)
    if (!manga) return
    manga.watermark = enable
    manga.updatedAt = new Date().toISOString()
    Store.set(Store.MANGAS_KEY, all)

    this.currentManga.watermark = enable
    this.renderWatermark()
    this.showToast(enable ? '已开启防盗水印' : '已关闭防盗水印', 'success')
    this.closeWatermarkModal()
  },

  // ===================== DELETE MANGA =====================
  deleteTarget: null, // { type: 'manga'|'page', mangaId, chapterIdx, pageIdx }

  openDeleteModal(type, context) {
    this.deleteTarget = { type, ...context }
    const msg = document.getElementById('deleteMsg')
    if (type === 'manga') {
      msg.textContent = `确定要删除《${this.currentManga.title}》吗？所有章节和图片将被永久删除，无法恢复。`
    } else if (type === 'page') {
      msg.textContent = `确定要删除第 ${context.pageIdx + 1} 页吗？此操作不可撤销。`
    }
    document.getElementById('deleteModal').classList.add('active')
  },

  closeDeleteModal() {
    document.getElementById('deleteModal').classList.remove('active')
    this.deleteTarget = null
  },

  async confirmDelete() {
    if (!this.deleteTarget) return
    const { type, mangaId, chapterIdx, pageIdx } = this.deleteTarget

    if (type === 'manga') {
      const all = Store.get(Store.MANGAS_KEY, [])
      const manga = all.find(m => m.id === (mangaId || this.currentManga.id))
      if (!manga) { this.showToast('漫画不存在', 'error'); return }
      if (manga.ownerId !== this.session.id) { this.showToast('只有发布者才能删除', 'error'); return }

      // Delete all images from IndexedDB
      if (manga.coverKey) await Store.deleteImage(manga.coverKey)
      for (const ch of (manga.chapters || [])) {
        for (const pk of (ch.pageKeys || [])) {
          await Store.deleteImage(pk)
        }
      }

      // Remove from store
      const idx = all.findIndex(m => m.id === manga.id)
      if (idx >= 0) all.splice(idx, 1)
      Store.set(Store.MANGAS_KEY, all)

      this.showToast('漫画已删除', 'success')
      this.closeDeleteModal()
      this.navigate('home')
    } else if (type === 'page') {
      await this.deletePage(mangaId, chapterIdx, pageIdx)
    }
  },

  // ===================== CHAPTER PAGE EDIT =====================
  editingChapter: null, // { mangaId, chapterIdx }

  async openChapterEditModal(chapterIdx) {
    if (!this.currentManga) return
    if (this.currentManga.ownerId !== this.session.id) {
      this.showToast('只有发布者才能编辑页面', 'error'); return
    }

    const chapter = this.currentManga.chapters[chapterIdx]
    if (!chapter) { this.showToast('章节不存在', 'error'); return }

    this.editingChapter = { mangaId: this.currentManga.id, chapterIdx }

    // Load page image URLs
    const pageUrls = []
    for (const pageKey of chapter.pageKeys || []) {
      const blob = await Store.getImage(pageKey)
      pageUrls.push(blob ? URL.createObjectURL(blob) : '')
    }
    this._editingPageUrls = pageUrls
    this._editingPageKeys = [...(chapter.pageKeys || [])]

    document.getElementById('chapterEditTitle').textContent = `编辑页面 - 第${chapterIdx + 1}话 ${chapter.title}`
    this.renderPageEditGrid()
    document.getElementById('chapterEditModal').classList.add('active')
  },

  closeChapterEditModal() {
    document.getElementById('chapterEditModal').classList.remove('active')
    this.editingChapter = null
    this._editingPageUrls = null
    this._editingPageKeys = null
    this._pendingNewPages = null
  },

  renderPageEditGrid() {
    const grid = document.getElementById('pageEditGrid')
    const urls = this._editingPageUrls || []
    if (urls.length === 0) {
      grid.innerHTML = '<div style="grid-column:1/-1;" class="empty-state-text">暂无页面，点击上方按钮添加图片</div>'
      return
    }
    grid.innerHTML = urls.map((url, i) => `
      <div class="page-edit-item">
        <div class="page-edit-num">${i + 1}</div>
        ${url ? `<img src="${url}">` : '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--text-dim);">📄</div>'}
        <div class="page-edit-actions">
          <button class="btn-edit" onclick="App.editPageInEditor(${i})">编辑</button>
          ${i > 0 ? `<button class="btn-up" onclick="App.movePage(${i},-1)">↑</button>` : ''}
          ${i < urls.length - 1 ? `<button class="btn-down" onclick="App.movePage(${i},1)">↓</button>` : ''}
          <button class="btn-del" onclick="App.openDeleteModal('page',{mangaId:'${this.editingChapter.mangaId}',chapterIdx:${this.editingChapter.chapterIdx},pageIdx:${i}})">🗑</button>
        </div>
      </div>
    `).join('')
  },

  addPagesToChapter() {
    document.getElementById('chapterAddPagesInput').click()
  },

  onAddPagesSelected(input) {
    const files = Array.from(input.files)
    if (files.length === 0) return
    for (const f of files) {
      if (!f.type.startsWith('image/')) { this.showToast(`${f.name} 不是图片`, 'error'); return }
    }
    files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))

    if (!this._pendingNewPages) this._pendingNewPages = []
    for (const f of files) {
      this._pendingNewPages.push(f)
      this._editingPageUrls.push(URL.createObjectURL(f))
      this._editingPageKeys.push(null) // null = new page, not yet saved
    }
    input.value = ''
    this.renderPageEditGrid()
    this.showToast(`已添加 ${files.length} 张图片，记得保存`, 'info')
  },

  movePage(idx, dir) {
    const newIdx = idx + dir
    if (newIdx < 0 || newIdx >= this._editingPageUrls.length) return
    // Swap urls and keys
    const tmpUrl = this._editingPageUrls[idx]
    this._editingPageUrls[idx] = this._editingPageUrls[newIdx]
    this._editingPageUrls[newIdx] = tmpUrl

    const tmpKey = this._editingPageKeys[idx]
    this._editingPageKeys[idx] = this._editingPageKeys[newIdx]
    this._editingPageKeys[newIdx] = tmpKey

    this.renderPageEditGrid()
  },

  async deletePage(mangaId, chapterIdx, pageIdx) {
    if (pageIdx < 0 || pageIdx >= this._editingPageUrls.length) return

    // Remove from arrays
    this._editingPageUrls.splice(pageIdx, 1)
    const deletedKey = this._editingPageKeys.splice(pageIdx, 1)[0]

    // If the page had a saved key, delete from IndexedDB
    if (deletedKey) {
      await Store.deleteImage(deletedKey)
    }

    this.renderPageEditGrid()
    this.showToast(`已删除第 ${pageIdx + 1} 页`, 'success')
    this.closeDeleteModal()
  },

  async saveChapterPages() {
    if (!this.editingChapter) return
    const { mangaId, chapterIdx } = this.editingChapter

    const all = Store.get(Store.MANGAS_KEY, [])
    const manga = all.find(m => m.id === mangaId)
    if (!manga) { this.showToast('漫画不存在', 'error'); return }
    if (manga.ownerId !== this.session.id) { this.showToast('无权操作', 'error'); return }

    const chapter = manga.chapters[chapterIdx]
    if (!chapter) { this.showToast('章节不存在', 'error'); return }

    // Save new pages to IndexedDB and generate keys
    const newPageKeys = []
    for (let i = 0; i < this._editingPageKeys.length; i++) {
      const key = this._editingPageKeys[i]
      if (key) {
        // Existing page - keep key
        newPageKeys.push(key)
      } else {
        // New page - save to IndexedDB
        const newKey = `${mangaId}_ch${chapterIdx}_page${Date.now()}_${i}`
        const url = this._editingPageUrls[i]
        try {
          // Fetch blob from object URL
          const blob = await fetch(url).then(r => r.blob())
          await Store.saveImage(newKey, blob)
          newPageKeys.push(newKey)
        } catch (e) {
          console.error('Failed to save page:', e)
          this.showToast(`保存第 ${i + 1} 页失败`, 'error')
          return
        }
      }
    }

    // Update chapter data
    chapter.pageKeys = newPageKeys
    chapter.pageCount = newPageKeys.length
    chapter.updatedAt = new Date().toISOString()
    manga.updatedAt = new Date().toISOString()

    Store.set(Store.MANGAS_KEY, all)

    this.showToast('章节页面已保存', 'success')
    this.closeChapterEditModal()
    // Reload detail
    this.openMangaDetail(mangaId)
  },

  // ===================== IMAGE EDITOR ENTRY =====================
  editPageInEditor(pageIdx) {
    if (!this._editingPageUrls || !this._editingPageUrls[pageIdx]) return
    const url = this._editingPageUrls[pageIdx]
    Editor.open(url, (newBlob) => {
      // Replace the page with edited version
      const newUrl = URL.createObjectURL(newBlob)
      // Revoke old URL
      if (this._editingPageUrls[pageIdx]) URL.revokeObjectURL(this._editingPageUrls[pageIdx])
      this._editingPageUrls[pageIdx] = newUrl
      // Mark as new (needs saving)
      if (this._editingPageKeys[pageIdx]) {
        // Delete old image from IndexedDB
        Store.deleteImage(this._editingPageKeys[pageIdx])
      }
      this._editingPageKeys[pageIdx] = null
      this.renderPageEditGrid()
      this.showToast('图片已编辑，记得保存', 'success')
    })
  },

  // ===================== EDIT UPLOAD PAGE IN EDITOR =====================
  editUploadPageInEditor(chapterIdx, pageIdx) {
    if (!this.chapters[chapterIdx] || !this.chapters[chapterIdx].previews[pageIdx]) return
    const url = this.chapters[chapterIdx].previews[pageIdx]
    const file = this.chapters[chapterIdx].files[pageIdx]
    Editor.open(url, (newBlob) => {
      const newUrl = URL.createObjectURL(newBlob)
      URL.revokeObjectURL(url)
      this.chapters[chapterIdx].previews[pageIdx] = newUrl
      this.chapters[chapterIdx].files[pageIdx] = newBlob
      this.renderChapters()
      this.showToast('图片已编辑', 'success')
    })
  },

  // ===================== EDIT COVER IN EDITOR =====================
  editCoverInEditor() {
    if (!this.pendingCoverUrl) return
    Editor.open(this.pendingCoverUrl, (newBlob) => {
      URL.revokeObjectURL(this.pendingCoverUrl)
      this.pendingCoverFile = newBlob
      this.pendingCoverUrl = URL.createObjectURL(newBlob)
      document.getElementById('coverPreviewImg').src = this.pendingCoverUrl
      this.showToast('封面已编辑', 'success')
    })
  },
}

// Boot
document.addEventListener('DOMContentLoaded', () => {
  App.init()
  document.addEventListener('keydown', (e) => App.onKeydown(e))
})

/* ==================== Image Editor ==================== */
const Editor = {
  canvas: null,
  ctx: null,
  overlayCanvas: null,
  overlayCtx: null,
  tool: 'brush',
  color: '#e74c3c',
  size: 4,
  isDrawing: false,
  startX: 0,
  startY: 0,
  lastX: 0,
  lastY: 0,
  history: [],
  historyIdx: -1,
  maxHistory: 30,
  onSaveCallback: null,
  symmetry: false,
  grid: false,
  perspective: false,
  originalImage: null,

  open(imageUrl, onSaveCallback) {
    this.canvas = document.getElementById('editorCanvas')
    this.ctx = this.canvas.getContext('2d')
    this.overlayCanvas = document.getElementById('editorOverlayCanvas')
    this.overlayCtx = this.overlayCanvas.getContext('2d')
    this.onSaveCallback = onSaveCallback
    this.history = []
    this.historyIdx = -1

    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => {
      // Fit canvas to image dimensions (max 1200px)
      const maxW = 1200, maxH = 1800
      let w = img.width, h = img.height
      if (w > maxW) { h = h * maxW / w; w = maxW }
      if (h > maxH) { w = w * maxH / h; h = maxH }
      this.canvas.width = w
      this.canvas.height = h
      this.overlayCanvas.width = w
      this.overlayCanvas.height = h
      document.getElementById('editorCanvasInfo').textContent = `${Math.round(w)} × ${Math.round(h)}`

      // White background
      this.ctx.fillStyle = '#ffffff'
      this.ctx.fillRect(0, 0, w, h)
      // Draw image
      this.ctx.drawImage(img, 0, 0, w, h)
      this.originalImage = this.ctx.getImageData(0, 0, w, h)

      this.saveHistory()
      this.drawGuides()

      document.getElementById('editorOverlay').classList.add('active')
    }
    img.onerror = () => {
      App.showToast('无法加载图片', 'error')
    }
    img.src = imageUrl
  },

  cancel() {
    document.getElementById('editorOverlay').classList.remove('active')
    this.canvas = null
    this.ctx = null
    this.history = []
    this.historyIdx = -1
    this.onSaveCallback = null
    this.symmetry = false
    this.grid = false
    this.perspective = false
  },

  save() {
    if (!this.canvas || !this.onSaveCallback) return
    this.canvas.toBlob((blob) => {
      if (blob && this.onSaveCallback) {
        this.onSaveCallback(blob)
      }
      this.cancel()
    }, 'image/png')
  },

  selectTool(tool) {
    this.tool = tool
    document.querySelectorAll('.editor-tool-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tool === tool)
    })
    // Update cursor
    if (this.canvas) {
      if (tool === 'fill') this.canvas.style.cursor = 'cell'
      else if (tool === 'text') this.canvas.style.cursor = 'text'
      else this.canvas.style.cursor = 'crosshair'
    }
  },

  setColor(color) {
    this.color = color
    document.getElementById('editorColor').value = color
  },

  setSize(size) {
    this.size = size
    document.getElementById('editorSizeLabel').textContent = `${size}px`
  },

  // History
  saveHistory() {
    if (!this.ctx) return
    // Truncate future history if we went back
    if (this.historyIdx < this.history.length - 1) {
      this.history = this.history.slice(0, this.historyIdx + 1)
    }
    this.history.push(this.ctx.getImageData(0, 0, this.canvas.width, this.canvas.height))
    if (this.history.length > this.maxHistory) {
      this.history.shift()
    }
    this.historyIdx = this.history.length - 1
  },

  undo() {
    if (this.historyIdx <= 0) { App.showToast('无法继续撤销', 'info'); return }
    this.historyIdx--
    this.ctx.putImageData(this.history[this.historyIdx], 0, 0)
  },

  redo() {
    if (this.historyIdx >= this.history.length - 1) { App.showToast('无法继续重做', 'info'); return }
    this.historyIdx++
    this.ctx.putImageData(this.history[this.historyIdx], 0, 0)
  },

  clearCanvas() {
    if (!this.ctx) return
    this.ctx.fillStyle = '#ffffff'
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height)
    this.saveHistory()
  },

  // Drawing helpers
  getMousePos(e) {
    const rect = this.canvas.getBoundingClientRect()
    const scaleX = this.canvas.width / rect.width
    const scaleY = this.canvas.height / rect.height
    let clientX, clientY
    if (e.touches) {
      clientX = e.touches[0].clientX
      clientY = e.touches[0].clientY
    } else {
      clientX = e.clientX
      clientY = e.clientY
    }
    return {
      x: (clientX - rect.left) * scaleX,
      y: (clientY - rect.top) * scaleY
    }
  },

  // Symmetry helper - mirror x coordinate
  mirrorX(x) {
    return this.canvas.width - x
  },

  // Drawing events
  onPointerDown(e) {
    if (!this.ctx) return
    e.preventDefault()
    const pos = this.getMousePos(e)
    this.startX = pos.x
    this.startY = pos.y
    this.lastX = pos.x
    this.lastY = pos.y
    this.isDrawing = true

    if (this.tool === 'fill') {
      this.floodFill(Math.round(pos.x), Math.round(pos.y), this.hexToRgba(this.color))
      this.saveHistory()
      this.isDrawing = false
      return
    }

    if (this.tool === 'text') {
      const text = prompt('输入文字:')
      if (text) {
        this.ctx.fillStyle = this.color
        this.ctx.font = `${this.size * 4}px sans-serif`
        this.ctx.textBaseline = 'top'
        this.ctx.fillText(text, pos.x, pos.y)
        if (this.symmetry) {
          this.ctx.fillText(text, this.mirrorX(pos.x) - this.ctx.measureText(text).width, pos.y)
        }
        this.saveHistory()
      }
      this.isDrawing = false
      return
    }

    if (this.tool === 'brush' || this.tool === 'eraser') {
      this.ctx.beginPath()
      this.ctx.moveTo(pos.x, pos.y)
      // Draw initial dot
      this.ctx.fillStyle = this.tool === 'eraser' ? '#ffffff' : this.color
      this.ctx.beginPath()
      this.ctx.arc(pos.x, pos.y, this.size / 2, 0, Math.PI * 2)
      this.ctx.fill()
      if (this.symmetry) {
        this.ctx.beginPath()
        this.ctx.arc(this.mirrorX(pos.x), pos.y, this.size / 2, 0, Math.PI * 2)
        this.ctx.fill()
      }
    }
  },

  onPointerMove(e) {
    if (!this.ctx) return
    const pos = this.getMousePos(e)

    // Update coordinates display
    document.getElementById('editorCoords').textContent = `坐标: ${Math.round(pos.x)}, ${Math.round(pos.y)}`

    if (!this.isDrawing) return
    e.preventDefault()

    if (this.tool === 'brush' || this.tool === 'eraser') {
      this.ctx.strokeStyle = this.tool === 'eraser' ? '#ffffff' : this.color
      this.ctx.lineWidth = this.size
      this.ctx.lineCap = 'round'
      this.ctx.lineJoin = 'round'
      this.ctx.beginPath()
      this.ctx.moveTo(this.lastX, this.lastY)
      this.ctx.lineTo(pos.x, pos.y)
      this.ctx.stroke()

      if (this.symmetry) {
        this.ctx.beginPath()
        this.ctx.moveTo(this.mirrorX(this.lastX), this.lastY)
        this.ctx.lineTo(this.mirrorX(pos.x), pos.y)
        this.ctx.stroke()
      }

      this.lastX = pos.x
      this.lastY = pos.y
    } else if (this.tool === 'line' || this.tool === 'rect' || this.tool === 'circle') {
      // Preview on overlay canvas
      this.clearOverlay()
      this.overlayCtx.strokeStyle = this.color
      this.overlayCtx.lineWidth = this.size
      this.overlayCtx.setLineDash([5, 5])

      if (this.tool === 'line') {
        this.overlayCtx.beginPath()
        this.overlayCtx.moveTo(this.startX, this.startY)
        this.overlayCtx.lineTo(pos.x, pos.y)
        this.overlayCtx.stroke()
        if (this.symmetry) {
          this.overlayCtx.beginPath()
          this.overlayCtx.moveTo(this.mirrorX(this.startX), this.startY)
          this.overlayCtx.lineTo(this.mirrorX(pos.x), pos.y)
          this.overlayCtx.stroke()
        }
      } else if (this.tool === 'rect') {
        this.overlayCtx.strokeRect(this.startX, this.startY, pos.x - this.startX, pos.y - this.startY)
        if (this.symmetry) {
          const mx = this.mirrorX(this.startX)
          this.overlayCtx.strokeRect(mx, this.startY, this.mirrorX(pos.x) - mx, pos.y - this.startY)
        }
      } else if (this.tool === 'circle') {
        const cx = (this.startX + pos.x) / 2
        const cy = (this.startY + pos.y) / 2
        const rx = Math.abs(pos.x - this.startX) / 2
        const ry = Math.abs(pos.y - this.startY) / 2
        this.overlayCtx.beginPath()
        this.overlayCtx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2)
        this.overlayCtx.stroke()
        if (this.symmetry) {
          this.overlayCtx.beginPath()
          this.overlayCtx.ellipse(this.mirrorX(cx), cy, rx, ry, 0, 0, Math.PI * 2)
          this.overlayCtx.stroke()
        }
      }

      this.overlayCtx.setLineDash([])
    }
  },

  onPointerUp(e) {
    if (!this.ctx || !this.isDrawing) return
    e.preventDefault()
    const pos = this.getMousePos(e)
    this.isDrawing = false

    if (this.tool === 'line' || this.tool === 'rect' || this.tool === 'circle') {
      // Commit shape to main canvas
      this.ctx.strokeStyle = this.color
      this.ctx.lineWidth = this.size
      this.clearOverlay()

      if (this.tool === 'line') {
        this.ctx.beginPath()
        this.ctx.moveTo(this.startX, this.startY)
        this.ctx.lineTo(pos.x, pos.y)
        this.ctx.stroke()
        if (this.symmetry) {
          this.ctx.beginPath()
          this.ctx.moveTo(this.mirrorX(this.startX), this.startY)
          this.ctx.lineTo(this.mirrorX(pos.x), pos.y)
          this.ctx.stroke()
        }
      } else if (this.tool === 'rect') {
        this.ctx.strokeRect(this.startX, this.startY, pos.x - this.startX, pos.y - this.startY)
        if (this.symmetry) {
          const mx = this.mirrorX(this.startX)
          this.ctx.strokeRect(mx, this.startY, this.mirrorX(pos.x) - mx, pos.y - this.startY)
        }
      } else if (this.tool === 'circle') {
        const cx = (this.startX + pos.x) / 2
        const cy = (this.startY + pos.y) / 2
        const rx = Math.abs(pos.x - this.startX) / 2
        const ry = Math.abs(pos.y - this.startY) / 2
        this.ctx.beginPath()
        this.ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2)
        this.ctx.stroke()
        if (this.symmetry) {
          this.ctx.beginPath()
          this.ctx.ellipse(this.mirrorX(cx), cy, rx, ry, 0, 0, Math.PI * 2)
          this.ctx.stroke()
        }
      }
    }

    this.saveHistory()
  },

  clearOverlay() {
    if (!this.overlayCtx) return
    this.overlayCtx.clearRect(0, 0, this.overlayCanvas.width, this.overlayCanvas.height)
    this.drawGuides()
  },

  // Guide overlays (symmetry line, grid, perspective)
  drawGuides() {
    if (!this.overlayCtx) return
    if (!this.symmetry && !this.grid && !this.perspective) return

    this.overlayCtx.strokeStyle = 'rgba(108,92,231,.3)'
    this.overlayCtx.lineWidth = 1
    this.overlayCtx.setLineDash([8, 4])

    if (this.symmetry) {
      const midX = this.overlayCanvas.width / 2
      this.overlayCtx.beginPath()
      this.overlayCtx.moveTo(midX, 0)
      this.overlayCtx.lineTo(midX, this.overlayCanvas.height)
      this.overlayCtx.stroke()
    }

    if (this.grid) {
      const step = Math.max(20, this.overlayCanvas.width / 20)
      for (let x = step; x < this.overlayCanvas.width; x += step) {
        this.overlayCtx.beginPath()
        this.overlayCtx.moveTo(x, 0)
        this.overlayCtx.lineTo(x, this.overlayCanvas.height)
        this.overlayCtx.stroke()
      }
      for (let y = step; y < this.overlayCanvas.height; y += step) {
        this.overlayCtx.beginPath()
        this.overlayCtx.moveTo(0, y)
        this.overlayCtx.lineTo(this.overlayCanvas.width, y)
        this.overlayCtx.stroke()
      }
    }

    if (this.perspective) {
      const w = this.overlayCanvas.width
      const h = this.overlayCanvas.height
      const vpx = w / 2
      const vpy = h / 3
      // Draw lines from vanishing point
      for (let angle = -60; angle <= 60; angle += 15) {
        const rad = (angle * Math.PI) / 180
        this.overlayCtx.beginPath()
        this.overlayCtx.moveTo(vpx, vpy)
        this.overlayCtx.lineTo(vpx + Math.cos(rad) * w, vpy + Math.sin(rad) * h)
        this.overlayCtx.stroke()
      }
    }

    this.overlayCtx.setLineDash([])
  },

  toggleSymmetry() {
    this.symmetry = !this.symmetry
    App.showToast(this.symmetry ? '对称辅助线 开' : '对称辅助线 关', 'info')
    this.clearOverlay()
  },

  toggleGrid() {
    this.grid = !this.grid
    App.showToast(this.grid ? '网格辅助 开' : '网格辅助 关', 'info')
    this.clearOverlay()
  },

  togglePerspective() {
    this.perspective = !this.perspective
    App.showToast(this.perspective ? '透视辅助 开' : '透视辅助 关', 'info')
    this.clearOverlay()
  },

  // Flood fill algorithm
  floodFill(x, y, fillColor) {
    const imageData = this.ctx.getImageData(0, 0, this.canvas.width, this.canvas.height)
    const data = imageData.data
    const w = this.canvas.width
    const h = this.canvas.height

    const idx = (y * w + x) * 4
    const targetR = data[idx], targetG = data[idx + 1], targetB = data[idx + 2], targetA = data[idx + 3]

    if (targetR === fillColor.r && targetG === fillColor.g && targetB === fillColor.b && targetA === fillColor.a) return

    const stack = [[x, y]]
    const tolerance = 10

    while (stack.length > 0) {
      const [cx, cy] = stack.pop()
      if (cx < 0 || cx >= w || cy < 0 || cy >= h) continue
      const i = (cy * w + cx) * 4
      if (Math.abs(data[i] - targetR) > tolerance ||
          Math.abs(data[i + 1] - targetG) > tolerance ||
          Math.abs(data[i + 2] - targetB) > tolerance ||
          Math.abs(data[i + 3] - targetA) > tolerance) continue

      data[i] = fillColor.r
      data[i + 1] = fillColor.g
      data[i + 2] = fillColor.b
      data[i + 3] = fillColor.a

      stack.push([cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1])
    }

    this.ctx.putImageData(imageData, 0, 0)
  },

  hexToRgba(hex) {
    hex = hex.replace('#', '')
    const r = parseInt(hex.substr(0, 2), 16)
    const g = parseInt(hex.substr(2, 2), 16)
    const b = parseInt(hex.substr(4, 2), 16)
    return { r, g, b, a: 255 }
  },

  // Initialize event listeners
  initEvents() {
    const canvas = document.getElementById('editorCanvas')
    if (!canvas) return

    // Mouse events
    canvas.addEventListener('mousedown', (e) => this.onPointerDown(e))
    canvas.addEventListener('mousemove', (e) => this.onPointerMove(e))
    canvas.addEventListener('mouseup', (e) => this.onPointerUp(e))
    canvas.addEventListener('mouseleave', (e) => { if (this.isDrawing) this.onPointerUp(e) })

    // Touch events
    canvas.addEventListener('touchstart', (e) => this.onPointerDown(e), { passive: false })
    canvas.addEventListener('touchmove', (e) => this.onPointerMove(e), { passive: false })
    canvas.addEventListener('touchend', (e) => this.onPointerUp(e), { passive: false })
  },
}

// Initialize editor events after DOM loaded
document.addEventListener('DOMContentLoaded', () => {
  Editor.initEvents()
})
