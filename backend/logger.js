/**
 * logger - Seviyeli, bağımlılıksız günlükleme.
 *
 * Tüm günlükleme emoji'li console.log'du: seviye yok, filtre yok, üretimde
 * her istemci bağlantısı ve her transport için satır basılıyordu. LOG_LEVEL
 * ile üretimde 'info', hata ayıklarken 'debug' seçilebilir.
 *
 * LOG_FORMAT=json verilirse satırlar JSON olarak basılır (log toplayıcılar için).
 */

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

const configuredLevel = (process.env.LOG_LEVEL || 'info').toLowerCase();
const threshold = LEVELS[configuredLevel] !== undefined ? LEVELS[configuredLevel] : LEVELS.info;
const asJson = (process.env.LOG_FORMAT || '').toLowerCase() === 'json';

function write(level, args) {
    if (LEVELS[level] > threshold) return;

    const target = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;

    if (asJson) {
        target(JSON.stringify({
            ts: new Date().toISOString(),
            level,
            msg: args.map(a => (typeof a === 'string' ? a : inspect(a))).join(' ')
        }));
        return;
    }

    target(...args);
}

function inspect(value) {
    if (value instanceof Error) return `${value.name}: ${value.message}`;
    try { return JSON.stringify(value); } catch { return String(value); }
}

module.exports = {
    level: configuredLevel,
    error: (...args) => write('error', args),
    warn: (...args) => write('warn', args),
    info: (...args) => write('info', args),
    debug: (...args) => write('debug', args)
};
