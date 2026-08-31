/**
 * Lobby - Room list and creation
 */

let socket;

async function getConfig() {
    try {
        const response = await fetch('/api/config', { cache: 'no-store' });
        if (!response.ok) return {};
        return await response.json();
    } catch (e) {
        return {};
    }
}

async function initSocket() {
    const config = await getConfig();
    const signalingUrl = config.signalingUrl || window.location.origin;

    socket = io(signalingUrl);

    socket.on('connect', () => {
        // Lobi odasına abone ol: oda listesi güncellemeleri yalnızca buraya gelir.
        // Abonelik cevabı ilk listeyi de taşıdığı için ek bir tur gerekmiyor.
        socket.emit('lobby-subscribe', (rooms) => renderRooms(rooms || []));
    });

    // Yeni oda / kapanan oda seyrek olaylar: listeyi yeniden çiz.
    socket.on('room-created', (room) => {
        rooms.set(room.id, { ...rooms.get(room.id), ...room });
        renderRooms([...rooms.values()]);
    });

    socket.on('room-deleted', ({ id }) => {
        if (rooms.delete(id)) renderRooms([...rooms.values()]);
    });

    // Kullanıcı sayısı sık değişir ve sunucuda saniyede bir toplulaştırılır:
    // tüm listeyi yeniden çizmek yerine yalnızca ilgili kartı yamalıyoruz.
    socket.on('rooms-updated', (updates) => {
        if (!Array.isArray(updates)) return;
        updates.forEach(({ id, userCount }) => {
            const room = rooms.get(id);
            if (!room) return;
            room.userCount = userCount;
            patchRoomCard(room);
        });
    });

    // Kaçan bir olaya karşı periyodik mutabakat (ucuz: dakikada iki tur).
    setInterval(loadRooms, 30000);
}

// DOM Elements
const roomList = document.getElementById('roomList');
const noRooms = document.getElementById('noRooms');
const roomCount = document.getElementById('roomCount');
const btnCreateRoom = document.getElementById('btnCreateRoom');
const createModal = document.getElementById('createModal');
const btnCancelCreate = document.getElementById('btnCancelCreate');
const btnConfirmCreate = document.getElementById('btnConfirmCreate');
const roomNameInput = document.getElementById('roomName');
const createNicknameInput = document.getElementById('createNickname');
const roomPasswordInput = document.getElementById('roomPassword');
const roomMaxUsersInput = document.getElementById('roomMaxUsers');

const passwordModal = document.getElementById('passwordModal');
const passwordRoomName = document.getElementById('passwordRoomName');
const joinPasswordInput = document.getElementById('joinPassword');
const passwordError = document.getElementById('passwordError');
const btnCancelPassword = document.getElementById('btnCancelPassword');
const btnConfirmPassword = document.getElementById('btnConfirmPassword');

const toast = document.getElementById('toast');
const toastMessage = document.getElementById('toastMessage');

let pendingRoomId = null;

// ==================== ROOM LIST ====================

// Ekrandaki modelin tek kopyası: id -> oda
const rooms = new Map();

function loadRooms() {
    if (!socket?.connected) return;
    socket.emit('get-rooms', (list) => renderRooms(list || []));
}

function renderRooms(list) {
    rooms.clear();
    list.forEach(room => rooms.set(room.id, room));

    roomList.innerHTML = '';

    if (list.length === 0) {
        noRooms.classList.remove('hidden');
        roomCount.textContent = '0 oda';
        return;
    }

    noRooms.classList.add('hidden');
    roomCount.textContent = `${list.length} oda`;

    list.forEach(room => roomList.appendChild(createRoomCard(room)));
}

/** Yalnızca kullanıcı sayısını ve doluluk çubuğunu güncelle. */
function patchRoomCard(room) {
    const card = roomList.querySelector(`[data-room-id="${CSS.escape(room.id)}"]`);
    if (!card) return;

    const countEl = card.querySelector('[data-role="user-count"]');
    const barEl = card.querySelector('[data-role="fill-bar"]');
    const max = room.max_users || 100;

    if (countEl) countEl.textContent = `${room.userCount || 0}/${max}`;
    if (barEl) barEl.style.width = `${Math.min(100, ((room.userCount || 0) / max) * 100)}%`;
}

function createRoomCard(room) {
    const div = document.createElement('div');
    div.className = 'bg-slate-800/60 backdrop-blur rounded-xl p-5 border border-slate-700/50 hover:border-brand-500/50 transition-all cursor-pointer hover:shadow-lg hover:shadow-brand-500/5';
    div.dataset.roomId = room.id;

    const lockIcon = room.is_locked
        ? `<span class="flex items-center gap-1 text-amber-400 text-xs"><svg class="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M5 9V7a5 5 0 0110 0v2a2 2 0 012 2v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5a2 2 0 012-2zm8-2v2H7V7a3 3 0 016 0z" clip-rule="evenodd"/></svg> Kilitli</span>`
        : `<span class="flex items-center gap-1 text-emerald-400 text-xs"><svg class="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 20 20"><path d="M10 2a5 5 0 00-5 5v2a2 2 0 00-2 2v5a2 2 0 002 2h10a2 2 0 002-2v-5a2 2 0 00-2-2H7V7a3 3 0 015.905-.75 1 1 0 001.937-.5A5.002 5.002 0 0010 2z"/></svg> Açık</span>`;

    const streamingBadge = room.is_streaming
        ? `<span class="px-2 py-0.5 bg-red-500/20 text-red-400 text-xs rounded-full flex items-center gap-1">
            <span class="w-1.5 h-1.5 bg-red-500 rounded-full live-dot"></span>
            CANLI
           </span>`
        : '';

    const fillPct = Math.min(100, ((room.userCount || 0) / (room.max_users || 100)) * 100);

    div.innerHTML = `
        <div class="flex items-start justify-between mb-3">
            <h3 class="font-semibold text-base truncate flex-1">${escapeHtml(room.name)}</h3>
            ${lockIcon}
        </div>
        <div class="flex items-center justify-between text-sm text-slate-400 mb-2">
            <div class="flex items-center gap-1.5">
                <svg class="w-4 h-4" fill="currentColor" viewBox="0 0 20 20"><path d="M9 6a3 3 0 11-6 0 3 3 0 016 0zM17 6a3 3 0 11-6 0 3 3 0 016 0zM12.93 17c.046-.327.07-.66.07-1a6.97 6.97 0 00-1.5-4.33A5 5 0 0119 16v1h-6.07zM6 11a5 5 0 015 5v1H1v-1a5 5 0 015-5z"/></svg>
                <span class="tabular-nums" data-role="user-count">${room.userCount || 0}/${room.max_users}</span>
            </div>
            ${streamingBadge}
        </div>
        <div class="h-1 bg-slate-700/50 rounded-full overflow-hidden">
            <div class="h-full bg-brand-500/50 rounded-full transition-all" data-role="fill-bar" style="width:${fillPct}%"></div>
        </div>
    `;

    div.addEventListener('click', () => handleRoomClick(room));
    return div;
}

function handleRoomClick(room) {
    if (room.is_locked) {
        // Show password modal
        pendingRoomId = room.id;
        passwordRoomName.textContent = room.name;
        passwordError.classList.add('hidden');
        joinPasswordInput.value = '';
        passwordModal.classList.remove('hidden');
        passwordModal.classList.add('flex');
        joinPasswordInput.focus();
    } else {
        // Direct join
        joinRoom(room.id);
    }
}

// ==================== JOIN ROOM ====================

function joinRoom(roomId, password = null) {
    socket.emit('join-room', { roomId, password }, (result) => {
        if (result.error) {
            if (result.blocked) {
                showToast(`${result.error}`, 5000);
                closePasswordModal();
            } else if (result.needPassword) {
                passwordError.textContent = `${result.error} (${result.remainingAttempts} deneme kaldı)`;
                passwordError.classList.remove('hidden');
            } else {
                showToast(result.error);
            }
            return;
        }

        // Success - store password for room.js and redirect
        if (password) {
            sessionStorage.setItem(`room_password_${roomId}`, password);
        }
        closePasswordModal();
        window.location.href = `room.html?roomId=${roomId}`;
    });
}

// ==================== CREATE ROOM ====================

btnCreateRoom.addEventListener('click', () => {
    roomNameInput.value = '';
    createNicknameInput.value = sessionStorage.getItem('velo_nickname') || '';
    roomPasswordInput.value = '';
    roomMaxUsersInput.value = '8';
    createModal.classList.remove('hidden');
    createModal.classList.add('flex');
    if(createNicknameInput.value) {
        roomNameInput.focus();
    } else {
        createNicknameInput.focus();
    }
});

btnCancelCreate.addEventListener('click', () => {
    createModal.classList.add('hidden');
    createModal.classList.remove('flex');
});

btnConfirmCreate.addEventListener('click', () => {
    const name = roomNameInput.value.trim();
    const nickname = createNicknameInput.value.trim();
    const password = roomPasswordInput.value.trim() || null;
    const maxUsers = parseInt(roomMaxUsersInput.value) || 8;

    if (!name) {
        showToast('Oda adı gerekli');
        return;
    }

    if (!nickname) {
        showToast('Nickname gerekli');
        return;
    }

    if (nickname.length < 3 || nickname.length > 30) {
        showToast('Nickname 3-30 karakter arası olmalı');
        return;
    }

    sessionStorage.setItem('velo_nickname', nickname);

    socket.emit('create-room', { name, password, maxUsers }, (result) => {
        if (result.error) {
            showToast(result.error);
            return;
        }

        // Yönetici sırrını sakla: room.js bunu admin-rejoin'de sunucuya
        // kanıt olarak gönderecek. URL'deki ?admin=true artık tek başına
        // hiçbir yetki vermiyor.
        if (result.adminToken) {
            try {
                sessionStorage.setItem(`velo_admin_token_${result.roomId}`, result.adminToken);
            } catch (e) {
                showToast('Tarayıcı depolaması kapalı, yönetici olarak giriş yapılamaz');
                return;
            }
        }

        // Success - redirect to room as admin
        createModal.classList.add('hidden');
        window.location.href = `room.html?roomId=${result.roomId}&admin=true`;
    });
});

// ==================== PASSWORD MODAL ====================

btnCancelPassword.addEventListener('click', closePasswordModal);

btnConfirmPassword.addEventListener('click', () => {
    const password = joinPasswordInput.value;
    if (!password) {
        passwordError.textContent = 'Şifre girin';
        passwordError.classList.remove('hidden');
        return;
    }
    joinRoom(pendingRoomId, password);
});

joinPasswordInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') btnConfirmPassword.click();
});

function closePasswordModal() {
    passwordModal.classList.add('hidden');
    passwordModal.classList.remove('flex');
    pendingRoomId = null;
}

// ==================== HELPERS ====================

function showToast(message, duration = 3000) {
    toastMessage.textContent = message;
    toast.classList.remove('hidden');
    setTimeout(() => toast.classList.add('hidden'), duration);
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// ==================== INIT ====================

initSocket();
