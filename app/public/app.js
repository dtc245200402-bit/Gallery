const $ = (selector) => document.querySelector(selector);
const categories = ['Du lịch', 'Gia đình', 'Bạn bè', 'Thiên nhiên', 'Công việc', 'Ẩm thực', 'Khác'];
let csrfToken = '';
let albums = [];
let activeAlbumId = null;
let selectedFiles = [];
let allPhotos = [];
let toastTimer;

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}
function icon(name, label = '') {
  return `<svg class="icon"${label ? ` role="img" aria-label="${escapeHtml(label)}"` : ' aria-hidden="true"'}><use href="#icon-${name}"></use></svg>`;
}
function showToast(message, kind = 'success') {
  const toast = $('#toast');
  toast.textContent = message;
  toast.className = `toast show ${kind === 'error' ? 'toast-error' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.className = 'toast'; }, 3200);
}
async function api(url, options = {}) {
  const headers = new Headers(options.headers || {});
  const isFormData = options.body instanceof FormData;
  if (options.body && !isFormData && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  if (options.method && !['GET', 'HEAD', 'OPTIONS'].includes(options.method.toUpperCase()) && csrfToken) headers.set('X-CSRF-Token', csrfToken);
  const response = await fetch(url, { ...options, headers, credentials: 'same-origin' });
  const contentType = response.headers.get('content-type') || '';
  const payload = contentType.includes('application/json') ? await response.json() : await response.text();
  if (!response.ok) {
    if (response.status === 401 && !location.pathname.startsWith('/share/')) {
      showLogin();
      // Refresh the CSRF token if the server-side session expired while this tab stayed open.
      try {
        const csrfResponse = await fetch('/api/csrf', { credentials: 'same-origin' });
        if (csrfResponse.ok) csrfToken = (await csrfResponse.json()).csrfToken;
      } catch {}
    }
    throw new Error(payload?.error || `Lỗi HTTP ${response.status}`);
  }
  return payload;
}
async function refreshCsrf() {
  const result = await api('/api/csrf');
  csrfToken = result.csrfToken;
}
function showLogin() {
  $('#loginView').classList.remove('hidden');
  $('#appView').classList.add('hidden');
  $('#logoutBtn').classList.add('hidden');
}
function showApp(username) {
  $('#loginView').classList.add('hidden');
  $('#appView').classList.remove('hidden');
  $('#logoutBtn').classList.remove('hidden');
  $('#signedInUser').textContent = username || 'Admin';
  $('#welcomeAdminName').textContent = (username || 'ADMIN').toLocaleUpperCase('vi-VN');
  showModule('dashboard');
}
function showModule(view) {
  const content = {
    dashboard: ['TỔNG QUAN', 'Tổng quan thư viện', 'Theo dõi nhanh bộ sưu tập ảnh của bạn.'],
    albums: ['TỔNG QUAN', 'Quản lý album ảnh', 'Tạo bộ sưu tập, xem ảnh và quản lý nội dung của bạn.'],
    albumDetail: ['ALBUM ẢNH / XEM ẢNH', 'Hình ảnh trong album', 'Xem và quản lý ảnh trong bộ sưu tập đã chọn.'],
    createAlbum: ['QUẢN LÝ ALBUM / TẠO MỚI', 'Tạo album mới', 'Nhập thông tin cho bộ sưu tập mới.'],
    editAlbum: ['QUẢN LÝ ALBUM / CHỈNH SỬA', 'Sửa thông tin album', 'Cập nhật thông tin cho bộ sưu tập đã chọn.'],
    upload: ['THƯ VIỆN / UPLOAD', 'Quản lý upload', 'Tải ảnh lên đúng album và theo dõi nội dung đã lưu.'],
    categories: ['THƯ VIỆN / PHÂN LOẠI', 'Quản lý phân loại', 'Gán và lọc chủ đề cho từng ảnh trong thư viện.'],
    sharing: ['THƯ VIỆN / CHIA SẺ', 'Quản lý chia sẻ', 'Tạo liên kết xem album hoặc thu hồi quyền truy cập.']
  }[view] || ['TỔNG QUAN', 'Quản lý album ảnh', 'Tạo bộ sưu tập, xem ảnh và quản lý nội dung của bạn.'];
  const navigationView = ['createAlbum', 'editAlbum', 'albumDetail'].includes(view) ? 'albums' : view;
  document.querySelectorAll('.module-view').forEach((section) => section.classList.toggle('hidden', section.id !== `${view}View`));
  document.querySelectorAll('.nav-item[data-view]').forEach((button) => {
    const active = button.dataset.view === navigationView;
    button.classList.toggle('active', active);
    button.setAttribute('aria-current', active ? 'page' : 'false');
  });
  $('#pageEyebrow').textContent = content[0];
  $('#pageTitle').textContent = content[1];
  $('#pageDescription').textContent = content[2];
  $('#scrollCreateBtn').classList.toggle('hidden', view !== 'albums');
}

async function initialize() {
  if (location.pathname.startsWith('/photo/')) {
    $('#shareRoot').classList.remove('hidden');
    await renderSharedPhoto(location.pathname.split('/')[2] || '');
    return;
  }
  if (location.pathname.startsWith('/share/')) {
    $('#shareRoot').classList.remove('hidden');
    await renderSharedAlbum(location.pathname.split('/')[2] || '');
    return;
  }
  try {
    await refreshCsrf();
    const state = await api('/api/session');
    if (state.authenticated) {
      showApp(state.username);
      await loadAlbums();
    } else showLogin();
  } catch (error) {
    showLogin();
    showToast(error.message || 'Không thể kết nối máy chủ.', 'error');
  }
}

$('#loginForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('#loginError').textContent = '';
  const button = event.currentTarget.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    const result = await api('/api/login', {
      method: 'POST',
      body: JSON.stringify({ username: $('#username').value, password: $('#password').value })
    });
    csrfToken = result.csrfToken;
    $('#password').value = '';
    showApp(result.username);
    await loadAlbums();
  } catch (error) {
    $('#loginError').textContent = error.message;
  } finally { button.disabled = false; }
});

$('#logoutBtn').addEventListener('click', async () => {
  try {
    await api('/api/logout', { method: 'POST' });
    activeAlbumId = null;
    await refreshCsrf();
    showLogin();
    showToast('Đã đăng xuất.');
  } catch (error) { showToast(error.message, 'error'); }
});

$('#backToAlbums').addEventListener('click', () => showModule('albums'));
$('#overviewCreateAlbum').addEventListener('click', () => {
  $('#createAlbumForm').reset();
  showModule('createAlbum');
  $('#albumName').focus();
});
$('#overviewAllAlbums').addEventListener('click', () => showModule('albums'));

document.querySelectorAll('.nav-item[data-view]').forEach((button) => {
  button.addEventListener('click', () => showModule(button.dataset.view));
});

$('#createAlbumForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const albumForm = event.currentTarget;
  const form = new FormData(albumForm);
  const button = albumForm.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    const result = await api('/api/albums', { method: 'POST', body: JSON.stringify(Object.fromEntries(form.entries())) });
    albumForm.reset();
    await loadAlbums();
    showModule('albums');
    await selectAlbum(result.album.id, result.album.name);
    showToast('Đã tạo album mới.');
  } catch (error) { showToast(error.message, 'error'); }
  finally { button.disabled = false; }
});

$('#editAlbumForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const albumForm = event.currentTarget;
  const form = new FormData(albumForm);
  const id = Number(form.get('id'));
  const button = albumForm.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    await api(`/api/albums/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        name: form.get('name'),
        category: form.get('category'),
        description: form.get('description')
      })
    });
    albumForm.reset();
    await loadAlbums();
    showModule('albums');
    if (Number(activeAlbumId) === id) await refreshAlbumPhotos(id);
    showToast('Đã cập nhật album.');
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    button.disabled = false;
  }
});

$('#cancelEditAlbum').addEventListener('click', () => {
  $('#editAlbumForm').reset();
  showModule('albums');
});

$('#cancelCreateAlbum').addEventListener('click', () => {
  $('#createAlbumForm').reset();
  showModule('albums');
});

function editAlbum(id) {
  const album = albums.find((item) => Number(item.id) === Number(id));
  if (!album) return;
  $('#editAlbumId').value = album.id;
  $('#editAlbumName').value = album.name;
  $('#editAlbumCategory').value = album.category;
  $('#editAlbumDescription').value = album.description || '';
  showModule('editAlbum');
  $('#editAlbumName').focus({ preventScroll: true });
}

$('#scrollCreateBtn').addEventListener('click', () => {
  $('#createAlbumForm').reset();
  showModule('createAlbum');
  $('#albumName').focus();
});

$('#photoCategoryFilter').addEventListener('change', renderPhotoCategories);

$('#photoFile').addEventListener('change', (event) => {
  selectedFiles = Array.from(event.target.files || []);
  if (selectedFiles.length > 5) {
    selectedFiles = [];
    event.target.value = '';
    showToast('Mỗi lần chỉ có thể tải lên tối đa 5 ảnh.', 'error');
  }
  $('#uploadBtn').disabled = !selectedFiles.length || !$('#uploadAlbumSelect').value;
  $('#uploadFileName').textContent = selectedFiles.length
    ? selectedFiles.length === 1 ? selectedFiles[0].name : `Đã chọn ${selectedFiles.length} ảnh`
    : 'Chọn một hoặc nhiều ảnh';
});

$('#uploadAlbumSelect').addEventListener('change', () => {
  $('#uploadBtn').disabled = !selectedFiles.length || !$('#uploadAlbumSelect').value;
});

$('#uploadForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const albumId = Number($('#uploadAlbumSelect').value);
  if (!selectedFiles.length || !albumId) return;
  const form = new FormData();
  selectedFiles.forEach((file) => form.append('photos', file));
  form.append('category', $('#uploadCategory').value);
  $('#uploadBtn').disabled = true;
  $('#uploadBtn').textContent = `Đang tải ${selectedFiles.length} ảnh...`;
  try {
    const result = await api(`/api/albums/${albumId}/photos`, { method: 'POST', body: form });
    $('#photoFile').value = '';
    selectedFiles = [];
    $('#uploadFileName').textContent = 'Chọn một hoặc nhiều ảnh';
    await loadAlbums();
    if (Number(activeAlbumId) === albumId) await refreshAlbumPhotos(albumId);
    showToast(`Đã tải lên ${result.photos.length} ảnh.`);
  } catch (error) { showToast(error.message, 'error'); }
  finally { $('#uploadBtn').innerHTML = `Tải ảnh lên ${icon('arrow-right')}`; $('#uploadBtn').disabled = !selectedFiles.length || !$('#uploadAlbumSelect').value; }
});

async function loadAlbums() {
  const result = await api('/api/albums');
  albums = result.albums;
  $('#albumCount').textContent = albums.length;
  $('#albumPill').textContent = `${albums.length} album`;
  $('#photoCount').textContent = albums.reduce((sum, album) => sum + Number(album.photo_count || 0), 0);
  $('#categoryCount').textContent = new Set(albums.map((album) => album.category)).size;
  $('#overviewAlbumCount').textContent = albums.length;
  $('#overviewPhotoCount').textContent = albums.reduce((sum, album) => sum + Number(album.photo_count || 0), 0);
  $('#overviewCategoryCount').textContent = new Set(albums.map((album) => album.category)).size;
  syncUploadAlbums();
  renderAlbums();
  renderOverviewAlbums();
  renderSharingAlbums();
  await loadPhotos();
  if (activeAlbumId && albums.some((album) => Number(album.id) === Number(activeAlbumId))) {
    const current = albums.find((album) => Number(album.id) === Number(activeAlbumId));
    $('#photoHeading').textContent = current.name;
    $('#photoSubheading').textContent = `${current.category} · ${current.photo_count} hình ảnh`;
  } else if (!albums.length) {
    activeAlbumId = null;
    $('#photoHeading').textContent = 'Hình ảnh';
    $('#photoSubheading').textContent = 'Tạo album đầu tiên để bắt đầu lưu ảnh.';
    $('#photoGrid').innerHTML = `<div class="empty-state photo-empty"><div class="empty-icon">${icon('image')}</div><strong>Thư viện đang trống</strong><span>Tạo album mới rồi tải ảnh lên.</span></div>`;
  }
}

function syncUploadAlbums() {
  const select = $('#uploadAlbumSelect');
  const previousValue = select.value || String(activeAlbumId || '');
  select.innerHTML = '<option value="">Chọn album</option>' + albums.map((album) =>
    `<option value="${Number(album.id)}">${escapeHtml(album.name)}</option>`).join('');
  select.value = albums.some((album) => String(album.id) === previousValue)
    ? previousValue
    : (activeAlbumId && albums.some((album) => Number(album.id) === Number(activeAlbumId)) ? String(activeAlbumId) : '');
  if (!albums.length) {
    select.innerHTML = '<option value="">Tạo album trước khi tải ảnh</option>';
    select.value = '';
  }
  $('#uploadBtn').disabled = !selectedFiles.length || !select.value;
}

function renderAlbums() {
  renderAlbumCards($('#albumList'), albums, false);
}

function renderOverviewAlbums() {
  const container = $('#overviewAlbumList');
  if (!albums.length) {
    container.innerHTML = `<div class="empty-state"><div class="empty-icon">${icon('album')}</div><strong>Chưa có album</strong><span>Tạo album đầu tiên để bắt đầu lưu ảnh.</span></div>`;
    return;
  }
  container.innerHTML = albums.slice(0, 4).map((album, index) => `
    <button class="overview-album-card" type="button" data-overview-album="${Number(album.id)}">
      <span class="album-cover cover-${index % 4}"><span class="cover-symbol">${icon('image')}</span></span>
      <span class="overview-album-info"><strong>${escapeHtml(album.name)}</strong><small>${escapeHtml(album.category)} · ${Number(album.photo_count)} ảnh</small></span>
      <span class="overview-album-arrow">${icon('arrow-right')}</span>
    </button>`).join('');
  container.querySelectorAll('[data-overview-album]').forEach((button) => button.addEventListener('click', () => {
    const album = albums.find((item) => Number(item.id) === Number(button.dataset.overviewAlbum));
    if (album) selectAlbum(album.id, album.name);
  }));
}

function renderSharingAlbums() {
  renderAlbumCards($('#sharingAlbumList'), albums, true);
}

function renderAlbumCards(container, items, sharingView) {
  if (!items.length) {
    container.innerHTML = `<div class="empty-state album-empty"><div class="empty-icon">${icon('plus')}</div><strong>Chưa có album nào</strong><span>Tạo một album để bắt đầu bộ sưu tập của bạn.</span></div>`;
    return;
  }
  container.innerHTML = items.map((album, index) => `
    <article class="album-card ${Number(activeAlbumId) === Number(album.id) ? 'selected' : ''}" data-album-id="${Number(album.id)}">
      <button class="album-open" type="button" data-action="open" data-id="${Number(album.id)}" aria-label="Xem ảnh trong album ${escapeHtml(album.name)}">
        <span class="album-cover cover-${index % 4}"><span class="cover-symbol">${icon('image')}</span></span>
        <span class="album-info"><strong>${escapeHtml(album.name)}</strong><small>${escapeHtml(album.category)} · ${Number(album.photo_count)} ảnh</small>${sharingView ? `<small class="share-status ${Number(album.share_enabled) ? 'is-shared' : ''}">${Number(album.share_enabled) ? 'Đang chia sẻ' : 'Chưa chia sẻ'}</small>` : ''}</span>
      </button>
      <div class="album-actions">${sharingView
        ? `<button class="button button-outline" type="button" data-action="revoke" data-id="${Number(album.id)}">Thu hồi</button><button class="button button-primary" type="button" data-action="share" data-id="${Number(album.id)}">Tạo liên kết</button>`
        : `<button class="icon-button" type="button" data-action="edit" data-id="${Number(album.id)}" title="Sửa album" aria-label="Sửa album">${icon('edit')}</button><button class="icon-button delete-icon" type="button" data-action="delete" data-id="${Number(album.id)}" title="Xóa album" aria-label="Xóa album">${icon('trash')}</button>`}</div>
    </article>`).join('');
  if (!sharingView) container.querySelectorAll('.album-card').forEach((card) => card.addEventListener('click', (event) => {
    if (event.target.closest('button')) return;
    const album = albums.find((item) => Number(item.id) === Number(card.dataset.albumId));
    if (album) selectAlbum(album.id, album.name);
  }));
  container.querySelectorAll('button[data-action]').forEach((button) => button.addEventListener('click', async (event) => {
    event.stopPropagation();
    const id = Number(button.dataset.id);
    const album = albums.find((item) => Number(item.id) === id);
    if (!album) return;
    if (button.dataset.action === 'open') await selectAlbum(id, album.name);
    if (button.dataset.action === 'edit') editAlbum(id);
    if (button.dataset.action === 'share') await shareAlbum(id);
    if (button.dataset.action === 'revoke') await revokeShare(id);
    if (button.dataset.action === 'delete') await deleteAlbum(id, album.name);
  }));
}

async function loadPhotos() {
  const result = await api('/api/photos');
  allPhotos = result.photos;
  $('#categoryPhotoCount').textContent = `${allPhotos.length} ảnh`;
  const filter = $('#photoCategoryFilter');
  const selectedCategory = filter.value;
  const availableCategories = [...new Set([...categories, ...allPhotos.map((photo) => photo.category || 'Khác')])];
  filter.innerHTML = '<option value="">Tất cả chủ đề</option>' + availableCategories.map((category) =>
    `<option value="${escapeHtml(category)}">${escapeHtml(category)}</option>`).join('');
  filter.value = availableCategories.includes(selectedCategory) ? selectedCategory : '';
  renderPhotoCategories();
  renderPhotoShareManager();
}

function categoryOptions(selectedCategory) {
  return [...new Set([...categories, selectedCategory])].map((category) =>
    `<option value="${escapeHtml(category)}"${category === selectedCategory ? ' selected' : ''}>${escapeHtml(category)}</option>`
  ).join('');
}

function renderPhotoCategories() {
  const container = $('#photoCategoryList');
  if (!allPhotos.length) {
    container.innerHTML = `<div class="empty-state album-empty"><div class="empty-icon">${icon('tag')}</div><strong>Chưa có ảnh</strong><span>Tải ảnh lên để phân loại từng tấm ảnh.</span></div>`;
    return;
  }
  const selectedCategory = $('#photoCategoryFilter').value;
  const filteredPhotos = selectedCategory ? allPhotos.filter((photo) => photo.category === selectedCategory) : allPhotos;
  if (!filteredPhotos.length) {
    container.innerHTML = '<div class="empty-state album-empty"><strong>Không có ảnh trong phân loại này</strong><span>Chọn chủ đề khác hoặc thay đổi bộ lọc.</span></div>';
    return;
  }
  container.innerHTML = filteredPhotos.map((photo) => `
    <form class="category-album-row photo-category-row" data-photo-category="${Number(photo.id)}">
      <div class="category-album-info"><strong>${escapeHtml(photo.original_name)}</strong><small>${escapeHtml(photo.album_name)} · Hiện tại: ${escapeHtml(photo.category || 'Khác')}</small></div>
      <label class="visually-hidden" for="photo-category-${Number(photo.id)}">Phân loại ảnh ${escapeHtml(photo.original_name)}</label>
      <select id="photo-category-${Number(photo.id)}" name="category">${categoryOptions(photo.category || 'Khác')}</select>
      <button class="button button-outline" type="submit">Lưu</button>
    </form>`).join('');
  container.querySelectorAll('[data-photo-category]').forEach((form) => {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const id = Number(form.dataset.photoCategory);
      const category = new FormData(form).get('category');
      const button = form.querySelector('button');
      button.disabled = true;
      try {
        await api(`/api/photos/${id}/category`, { method: 'PATCH', body: JSON.stringify({ category }) });
        await loadPhotos();
        if (activeAlbumId) await refreshAlbumPhotos(activeAlbumId);
        showToast('Đã cập nhật phân loại ảnh.');
      } catch (error) {
        showToast(error.message, 'error');
      } finally {
        button.disabled = false;
      }
    });
  });
}

function renderPhotoShareManager() {
  const container = $('#sharingPhotoGrid');
  if (!allPhotos.length) {
    container.innerHTML = '<div class="empty-state photo-empty"><strong>Chưa có ảnh</strong><span>Tải ảnh lên để tạo liên kết chia sẻ riêng.</span></div>';
    return;
  }
  container.innerHTML = allPhotos.map((photo) => `
    <article class="photo-card">
      <a class="photo-image" href="${escapeHtml(photo.url)}" target="_blank" rel="noopener noreferrer"><img src="${escapeHtml(photo.url)}" alt="${escapeHtml(photo.original_name)}" loading="lazy"></a>
      <div class="photo-caption"><div><strong title="${escapeHtml(photo.original_name)}">${escapeHtml(photo.original_name)}</strong><small>${escapeHtml(photo.album_name)} · ${escapeHtml(photo.category || 'Khác')}</small></div></div>
      <div class="photo-share-actions">
        <span class="share-status ${Number(photo.share_enabled) ? 'is-shared' : ''}">${Number(photo.share_enabled) ? 'Đang chia sẻ' : 'Chưa chia sẻ'}</span>
        ${Number(photo.share_enabled) ? `<button class="button button-outline" type="button" data-revoke-photo="${Number(photo.id)}">Thu hồi</button>` : ''}
        <button class="button button-primary" type="button" data-share-photo="${Number(photo.id)}">${Number(photo.share_enabled) ? 'Tạo link mới' : 'Chia sẻ ảnh'}</button>
      </div>
    </article>`).join('');
  container.querySelectorAll('[data-share-photo]').forEach((button) =>
    button.addEventListener('click', () => sharePhoto(Number(button.dataset.sharePhoto))));
  container.querySelectorAll('[data-revoke-photo]').forEach((button) =>
    button.addEventListener('click', () => revokePhotoShare(Number(button.dataset.revokePhoto))));
}

async function selectAlbum(id, name = '') {
  activeAlbumId = Number(id);
  $('#uploadAlbumSelect').value = String(activeAlbumId);
  renderAlbums();
  showModule('albumDetail');
  await refreshAlbumPhotos(id, name);
}

async function refreshAlbumPhotos(id, name = '') {
  activeAlbumId = Number(id);
  const album = albums.find((item) => Number(item.id) === activeAlbumId);
  $('#photoHeading').textContent = name || album?.name || 'Hình ảnh';
  $('#photoSubheading').textContent = `${album?.category || 'Album'} · ${album?.photo_count ?? 0} hình ảnh`;
  $('#uploadBtn').disabled = !selectedFiles.length || !$('#uploadAlbumSelect').value;
  $('#photoGrid').innerHTML = '<div class="empty-state">Đang tải ảnh...</div>';
  try {
    const result = await api(`/api/albums/${activeAlbumId}/photos`);
    renderPhotos(result.photos);
    const fresh = albums.find((item) => Number(item.id) === activeAlbumId);
    if (fresh) $('#photoSubheading').textContent = `${fresh.category} · ${result.photos.length} hình ảnh`;
  } catch (error) { showToast(error.message, 'error'); }
}

function renderPhotos(photos) {
  if (!photos.length) {
    $('#photoGrid').innerHTML = `<div class="empty-state photo-empty"><div class="empty-icon">${icon('image')}</div><strong>Album chưa có ảnh</strong><span>Tải ảnh lên từ mục “Tải ảnh lên” để bắt đầu bộ sưu tập.</span></div>`;
    return;
  }
  $('#photoGrid').innerHTML = photos.map((photo) => `
    <article class="photo-card">
      <a class="photo-image" href="${escapeHtml(photo.url)}" target="_blank" rel="noopener noreferrer"><img src="${escapeHtml(photo.url)}" alt="${escapeHtml(photo.original_name)}" loading="lazy"></a>
      <div class="photo-caption"><div><strong title="${escapeHtml(photo.original_name)}">${escapeHtml(photo.original_name)}</strong><small>${(Number(photo.size_bytes) / 1024 / 1024).toFixed(2)} MB</small></div><button type="button" class="icon-button delete-icon" data-delete-photo="${Number(photo.id)}" title="Xóa ảnh" aria-label="Xóa ảnh">${icon('trash')}</button></div>
      <div class="photo-card-footer"><span class="category-chip">${escapeHtml(photo.category || 'Khác')}</span><button type="button" class="photo-share-button" data-share-photo="${Number(photo.id)}">${icon('share')} Chia sẻ</button></div>
    </article>`).join('');
  $('#photoGrid').querySelectorAll('[data-share-photo]').forEach((button) =>
    button.addEventListener('click', () => sharePhoto(Number(button.dataset.sharePhoto))));
  $('#photoGrid').querySelectorAll('[data-delete-photo]').forEach((button) => button.addEventListener('click', async () => {
    if (!confirm('Bạn có chắc muốn xóa ảnh này?')) return;
    try {
      await api(`/api/photos/${Number(button.dataset.deletePhoto)}`, { method: 'DELETE' });
      await loadAlbums();
      await refreshAlbumPhotos(activeAlbumId);
      showToast('Đã xóa ảnh.');
    } catch (error) { showToast(error.message, 'error'); }
  }));
}

async function shareAlbum(id) {
  try {
    const result = await api(`/api/albums/${id}/share`, { method: 'POST', body: '{}' });
    const shareUrl = `${location.origin}${result.sharePath}`;
    await loadAlbums();
    try {
      await navigator.clipboard.writeText(shareUrl);
      showToast('Đã tạo liên kết và sao chép vào clipboard.');
    } catch {
      prompt('Sao chép liên kết chia sẻ này:', shareUrl);
    }
  } catch (error) { showToast(error.message, 'error'); }
}

async function sharePhoto(id) {
  try {
    const result = await api(`/api/photos/${id}/share`, { method: 'POST', body: '{}' });
    const shareUrl = `${location.origin}${result.sharePath}`;
    await loadPhotos();
    if (activeAlbumId) await refreshAlbumPhotos(activeAlbumId);
    try {
      await navigator.clipboard.writeText(shareUrl);
      showToast('Đã tạo liên kết riêng và sao chép vào clipboard.');
    } catch {
      prompt('Sao chép liên kết chia sẻ ảnh này:', shareUrl);
    }
  } catch (error) { showToast(error.message, 'error'); }
}

async function revokePhotoShare(id) {
  if (!confirm('Thu hồi liên kết riêng của ảnh này?')) return;
  try {
    const result = await api(`/api/photos/${id}/share`, { method: 'DELETE' });
    await loadPhotos();
    if (activeAlbumId) await refreshAlbumPhotos(activeAlbumId);
    showToast(result.revoked ? 'Đã thu hồi liên kết ảnh.' : 'Ảnh chưa có liên kết đang hoạt động.');
  } catch (error) { showToast(error.message, 'error'); }
}

async function revokeShare(id) {
  if (!confirm('Thu hồi liên kết chia sẻ của album này? Những người đang dùng liên kết sẽ không xem được nữa.')) return;
  try {
    const result = await api(`/api/albums/${id}/share`, { method: 'DELETE' });
    await loadAlbums();
    showToast(result.revoked ? 'Đã thu hồi liên kết chia sẻ.' : 'Album chưa có liên kết chia sẻ đang hoạt động.');
  } catch (error) { showToast(error.message, 'error'); }
}

async function deleteAlbum(id, name) {
  if (!confirm(`Xóa album “${name}” cùng toàn bộ ảnh bên trong? Thao tác này không thể hoàn tác.`)) return;
  try {
    await api(`/api/albums/${id}`, { method: 'DELETE' });
    if (Number(activeAlbumId) === id) {
      activeAlbumId = null;
      $('#uploadAlbumSelect').value = '';
      $('#uploadBtn').disabled = true;
      $('#photoHeading').textContent = 'Hình ảnh';
      $('#photoSubheading').textContent = 'Chọn một album để xem ảnh.';
      $('#photoGrid').innerHTML = `<div class="empty-state photo-empty"><div class="empty-icon">${icon('image')}</div><strong>Chưa chọn album</strong><span>Chọn một album để xem ảnh.</span></div>`;
      showModule('albums');
    }
    await loadAlbums();
    showToast('Đã xóa album.');
  } catch (error) { showToast(error.message, 'error'); }
}

async function renderSharedAlbum(token) {
  const root = $('#sharedAlbumContent');
  try {
    const result = await api(`/api/share/${encodeURIComponent(token)}`);
    const album = result.album;
    root.innerHTML = `<div class="shared-heading"><p class="eyebrow">GALLERY / SHARED COLLECTION</p><h1>${escapeHtml(album.name)}</h1><p>${escapeHtml(album.description || 'Một bộ sưu tập ảnh được chia sẻ với bạn.')}</p><span class="category-chip">${escapeHtml(album.category)}</span><div class="shared-count">${result.photos.length} hình ảnh</div></div><div class="shared-grid">${result.photos.map((photo) => `<a class="shared-photo" href="${escapeHtml(photo.url)}" target="_blank" rel="noopener noreferrer"><img src="${escapeHtml(photo.url)}" alt="${escapeHtml(photo.original_name)}" loading="lazy"><span>${escapeHtml(photo.original_name)}</span></a>`).join('') || '<div class="empty-state"><strong>Album chưa có ảnh</strong></div>'}</div><p class="share-footer">Được chia sẻ bằng Gallery.</p>`;
  } catch (error) {
    root.innerHTML = `<div class="share-error"><div class="empty-icon">${icon('image')}</div><h1>Không mở được album</h1><p>${escapeHtml(error.message || 'Liên kết này không tồn tại hoặc đã bị thu hồi.')}</p><a href="/" class="button button-primary">Về trang chủ</a></div>`;
  }

  async function renderSharedPhoto(token) {
    const root = $('#sharedAlbumContent');
    try {
      const result = await api(`/api/photo-share/${encodeURIComponent(token)}`);
      const photo = result.photo;
      root.innerHTML = `<div class="shared-heading"><p class="eyebrow">GALLERY / SHARED PHOTO</p><h1>${escapeHtml(photo.original_name)}</h1><p>Ảnh từ album ${escapeHtml(photo.album_name)}</p><span class="category-chip">${escapeHtml(photo.category || 'Khác')}</span></div><a class="shared-single-photo" href="${escapeHtml(photo.url)}" target="_blank" rel="noopener noreferrer"><img src="${escapeHtml(photo.url)}" alt="${escapeHtml(photo.original_name)}"></a><p class="share-footer">Được chia sẻ bằng Gallery.</p>`;
    } catch (error) {
      root.innerHTML = `<div class="share-error"><div class="empty-icon">${icon('image')}</div><h1>Không mở được ảnh</h1><p>${escapeHtml(error.message || 'Liên kết này không tồn tại hoặc đã bị thu hồi.')}</p><a href="/" class="button button-primary">Về trang chủ</a></div>`;
    }
  }
}

initialize();
