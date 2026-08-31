/**
 * metrics - Prometheus metin formatında sunucu durumu.
 *
 * WorkerManager.getStats() worker başına consumer/producer/oda sayısını zaten
 * hesaplıyordu ama hiçbir yerden erişilemiyordu: bir oda takıldığında hangi
 * worker'ın doygun olduğunu görmenin yolu yoktu ve kapasite iddiası
 * ölçülemiyordu.
 *
 * Oda kimliği etiket olarak KULLANILMAZ (kardinalite patlaması); oda başına
 * dağılım yerine toplamlar ve worker kırılımı verilir.
 */

function line(name, value, labels) {
    const labelText = labels
        ? '{' + Object.entries(labels).map(([k, v]) => `${k}="${v}"`).join(',') + '}'
        : '';
    return `${name}${labelText} ${value}`;
}

/**
 * @param {{ workerManager: Object, roomManager: Object, io: Object }} deps
 * @returns {string} Prometheus exposition formatı
 */
function render({ workerManager, roomManager, io }) {
    const out = [];
    const workerStats = workerManager ? workerManager.getStats() : [];

    let rooms = 0;
    let streaming = 0;
    let users = 0;
    let largestRoom = 0;

    if (roomManager) {
        for (const [roomId, roomState] of roomManager.rooms) {
            rooms++;
            if (roomState.isStreaming) streaming++;
            const count = roomManager.getRoomUserCount(roomId);
            users += count;
            if (count > largestRoom) largestRoom = count;
        }
    }

    out.push('# HELP velostream_up Sunucu ayakta mı');
    out.push('# TYPE velostream_up gauge');
    out.push(line('velostream_up', 1));

    out.push('# HELP velostream_uptime_seconds Süreç çalışma süresi');
    out.push('# TYPE velostream_uptime_seconds counter');
    out.push(line('velostream_uptime_seconds', Math.floor(process.uptime())));

    out.push('# HELP velostream_rooms Açık oda sayısı');
    out.push('# TYPE velostream_rooms gauge');
    out.push(line('velostream_rooms', rooms));

    out.push('# HELP velostream_rooms_streaming Yayın yapan oda sayısı');
    out.push('# TYPE velostream_rooms_streaming gauge');
    out.push(line('velostream_rooms_streaming', streaming));

    out.push('# HELP velostream_users Odalardaki toplam kullanıcı');
    out.push('# TYPE velostream_users gauge');
    out.push(line('velostream_users', users));

    out.push('# HELP velostream_largest_room_users En kalabalık odadaki kullanıcı sayısı');
    out.push('# TYPE velostream_largest_room_users gauge');
    out.push(line('velostream_largest_room_users', largestRoom));

    out.push('# HELP velostream_socket_connections Bağlı soket sayısı');
    out.push('# TYPE velostream_socket_connections gauge');
    out.push(line('velostream_socket_connections', io ? io.sockets.sockets.size : 0));

    out.push('# HELP velostream_worker_consumers Worker başına consumer sayısı');
    out.push('# TYPE velostream_worker_consumers gauge');
    workerStats.forEach(w => out.push(line('velostream_worker_consumers', w.consumers, { worker: w.index })));

    out.push('# HELP velostream_worker_producers Worker başına producer sayısı');
    out.push('# TYPE velostream_worker_producers gauge');
    workerStats.forEach(w => out.push(line('velostream_worker_producers', w.producers, { worker: w.index })));

    out.push('# HELP velostream_worker_rooms Worker başına router (oda) sayısı');
    out.push('# TYPE velostream_worker_rooms gauge');
    workerStats.forEach(w => out.push(line('velostream_worker_rooms', w.rooms, { worker: w.index })));

    out.push('# HELP velostream_workers_alive Ayakta olan worker sayısı');
    out.push('# TYPE velostream_workers_alive gauge');
    out.push(line('velostream_workers_alive', workerStats.length));

    const memory = process.memoryUsage();
    out.push('# HELP velostream_memory_bytes Süreç bellek kullanımı');
    out.push('# TYPE velostream_memory_bytes gauge');
    out.push(line('velostream_memory_bytes', memory.rss, { type: 'rss' }));
    out.push(line('velostream_memory_bytes', memory.heapUsed, { type: 'heap_used' }));
    out.push(line('velostream_memory_bytes', memory.external, { type: 'external' }));

    return out.join('\n') + '\n';
}

/**
 * /metrics erişim kontrolü: METRICS_TOKEN tanımlıysa token zorunlu,
 * tanımlı değilse yalnızca özel ağdan (loopback/RFC1918) erişilebilir.
 */
function isAuthorized(req, { token = process.env.METRICS_TOKEN, ip } = {}) {
    if (token) {
        const header = req.headers.authorization || '';
        const bearer = header.startsWith('Bearer ') ? header.slice(7) : '';
        const provided = bearer || (req.query && req.query.token) || '';
        return provided === token;
    }
    return isPrivateAddress(ip);
}

function isPrivateAddress(ip) {
    if (!ip) return false;
    const clean = String(ip).replace(/^::ffff:/, '');
    if (clean === '127.0.0.1' || clean === '::1' || clean === 'localhost') return true;
    if (/^10\./.test(clean)) return true;
    if (/^192\.168\./.test(clean)) return true;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(clean)) return true;
    return false;
}

module.exports = { render, isAuthorized, isPrivateAddress };
