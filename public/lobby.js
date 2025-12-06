/**
 * Lobby - Room list and creation
 */

const socket = io('https://yahya-oracle.duckdns.org');

// DOM Elements
const roomList = document.getElementById('roomList');
const noRooms = document.getElementById('noRooms');
const roomCount = document.getElementById('roomCount');
const btnCreateRoom = document.getElementById('btnCreateRoom');
const createModal = document.getElementById('createModal');
const btnCancelCreate = document.getElementById('btnCancelCreate');
const btnConfirmCreate = document.getElementById('btnConfirmCreate');
const roomNameInput = document.getElementById('roomName');
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

function loadRooms() {
    socket.emit('get-rooms', (rooms) => {
        renderRooms(rooms);
    });
}

function renderRooms(rooms) {
    roomList.innerHTML = '';

    if (rooms.length === 0) {
        noRooms.classList.remove('hidden');
        roomCount.textContent = '0 oda';
        return;
    }

    noRooms.classList.add('hidden');
    roomCount.textContent = `${rooms.length} oda`;

    rooms.forEach(room => {
        const card = createRoomCard(room);
        roomList.appendChild(card);
    });
}

function createRoomCard(room) {
    const div = document.createElement('div');
    div.className = 'bg-slate-800 rounded-xl p-5 border border-slate-700 hover:border-brand-500 transition-colors cursor-pointer';
    div.dataset.roomId = room.id;

    const lockIcon = room.is_locked
        ? `<svg class="w-4 h-4 text-yellow-500" fill="currentColor" viewBox="0 0 20 20">
            <path fill-rule="evenodd" d="M5 9V7a5 5 0 0110 0v2a2 2 0 012 2v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5a2 2 0 012-2zm8-2v2H7V7a3 3 0 016 0z" clip-rule="evenodd"/>
           </svg>`
        : `<svg class="w-4 h-4 text-green-500" fill="currentColor" viewBox="0 0 20 20">
            <path d="M10 2a5 5 0 00-5 5v2a2 2 0 00-2 2v5a2 2 0 002 2h10a2 2 0 002-2v-5a2 2 0 00-2-2H7V7a3 3 0 015.905-.75 1 1 0 001.937-.5A5.002 5.002 0 0010 2z"/>
           </svg>`;

    const streamingBadge = room.is_streaming
        ? `<span class="px-2 py-0.5 bg-red-500/20 text-red-400 text-xs rounded-full flex items-center gap-1">
            <span class="w-1.5 h-1.5 bg-red-500 rounded-full animate-pulse"></span>
            CANLI
           </span>`
        : '';

    div.innerHTML = `
        <div class="flex items-start justify-between mb-3">
            <h3 class="font-semibold text-lg truncate flex-1">${escapeHtml(room.name)}</h3>
            ${lockIcon}
        </div>
        <div class="flex items-center justify-between text-sm text-slate-400">
            <div class="flex items-center gap-2">
                <svg class="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                    <path d="M9 6a3 3 0 11-6 0 3 3 0 016 0zM17 6a3 3 0 11-6 0 3 3 0 016 0zM12.93 17c.046-.327.07-.66.07-1a6.97 6.97 0 00-1.5-4.33A5 5 0 0119 16v1h-6.07zM6 11a5 5 0 015 5v1H1v-1a5 5 0 015-5z"/>
                </svg>
                <span>${room.userCount || 0}/${room.max_users}</span>
            </div>
            ${streamingBadge}
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
    roomPasswordInput.value = '';
    roomMaxUsersInput.value = '8';
    createModal.classList.remove('hidden');
    createModal.classList.add('flex');
    roomNameInput.focus();
});

btnCancelCreate.addEventListener('click', () => {
    createModal.classList.add('hidden');
    createModal.classList.remove('flex');
});

btnConfirmCreate.addEventListener('click', () => {
    const name = roomNameInput.value.trim();
    const password = roomPasswordInput.value.trim() || null;
    const maxUsers = parseInt(roomMaxUsersInput.value) || 8;

    if (!name) {
        showToast('Oda adı gerekli');
        return;
    }

    socket.emit('create-room', { name, password, maxUsers }, (result) => {
        if (result.error) {
            showToast(result.error);
            return;
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

// ==================== SOCKET EVENTS ====================

socket.on('room-created', (room) => {
    loadRooms();
});

socket.on('room-updated', ({ id, userCount }) => {
    const card = document.querySelector(`[data-room-id="${id}"]`);
    if (card) {
        const countEl = card.querySelector('.text-slate-400 span');
        if (countEl) {
            const maxUsers = countEl.textContent.split('/')[1];
            countEl.textContent = `${userCount}/${maxUsers}`;
        }
    }
});

socket.on('room-deleted', ({ id }) => {
    loadRooms();
});

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

socket.on('connect', () => {
    console.log('Connected to server');
    loadRooms();
});

// Real-time room updates
socket.on('room-created', (room) => {
    console.log('Room created:', room);
    loadRooms(); // Refresh the entire list
});

socket.on('room-updated', (update) => {
    console.log('Room updated:', update);
    loadRooms(); // Refresh to show updated user count
});

socket.on('room-deleted', ({ id }) => {
    console.log('Room deleted:', id);
    loadRooms(); // Refresh to remove deleted room
});
