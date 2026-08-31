/**
 * svcLayers - scalabilityMode ayrıştırma ve otomatik kalite kademesi.
 *
 * Yayıncı tek encoding ve 'L1T3' gönderiyordu: 1 uzamsal, 3 zamansal katman.
 * Sunucudaki otomatik kalite bu yüzden maxSpatialLayer=0 ile çalışıyor, sadece
 * kare hızını bir kademe düşürebiliyordu. Sonuç: bağlantısı zayıf bir izleyici
 * 1080p akışı almaya devam edip donuyordu. Doğru davranış, aynı akıcılıkta
 * daha küçük bir çözünürlüğe inmektir — VP9 SVC ('L3T3_KEY') bunu simulcast'in
 * transport karmaşıklığı olmadan sağlar.
 */

const SCALABILITY_MODE = /L(\d+)T(\d+)/i;

/** encodings dizisinden en yüksek zamansal katman indeksini çıkar. */
function getMaxTemporalLayer(encodings = []) {
    let max = 0;
    for (const enc of encodings) {
        const match = (enc && enc.scalabilityMode || '').match(SCALABILITY_MODE);
        if (match) {
            const layers = parseInt(match[2], 10);
            if (Number.isFinite(layers) && layers > 0) max = Math.max(max, layers - 1);
        }
    }
    return max;
}

/**
 * En yüksek uzamsal katman indeksi.
 * SVC'de katmanlar scalabilityMode'da (L3T3 → 3 uzamsal katman); simulcast'te
 * ise ayrı encoding'lerdedir. İkisinin büyüğü alınır.
 */
function getMaxSpatialLayer(encodings = []) {
    let fromMode = 0;
    for (const enc of encodings) {
        const match = (enc && enc.scalabilityMode || '').match(SCALABILITY_MODE);
        if (match) {
            const layers = parseInt(match[1], 10);
            if (Number.isFinite(layers) && layers > 0) fromMode = Math.max(fromMode, layers - 1);
        }
    }
    const fromEncodings = Math.max(0, (encodings.length || 1) - 1);
    return Math.max(fromMode, fromEncodings);
}

/**
 * Consumer skoruna göre hedef katmanları seç.
 *
 * Önce çözünürlükten (uzamsal) feragat edilir, kare hızı olabildiğince korunur:
 * ekran paylaşımında takılan 1080p, akıcı 720p'den kötüdür.
 *
 * Yukarı çıkarken histerezis var: skor 8'in altındayken kalite artırılmaz,
 * aksi halde sınırda gidip gelen bir bağlantı sürekli katman değiştirir.
 *
 * @param {number} score mediasoup consumer skoru (0-10)
 * @param {{maxSpatialLayer:number,maxTemporalLayer:number,spatialLayer:number,temporalLayer:number}} state
 * @returns {{spatialLayer:number,temporalLayer:number}}
 */
function pickLayers(score, state) {
    const { maxSpatialLayer, maxTemporalLayer, spatialLayer, temporalLayer } = state;

    let spatial;
    let temporal;

    if (score >= 7) {
        spatial = maxSpatialLayer;
        temporal = maxTemporalLayer;
    } else if (score >= 5) {
        spatial = maxSpatialLayer;
        temporal = Math.max(0, maxTemporalLayer - 1);
    } else if (score >= 3) {
        spatial = Math.max(0, maxSpatialLayer - 1);
        temporal = maxTemporalLayer;
    } else {
        spatial = Math.max(0, maxSpatialLayer - 2);
        temporal = Math.max(0, maxTemporalLayer - 1);
    }

    // Histerezis: yükselme yalnızca skor açıkça iyiyken
    const goingUp = spatial > spatialLayer || (spatial === spatialLayer && temporal > temporalLayer);
    if (goingUp && score < 8) {
        return { spatialLayer, temporalLayer };
    }

    return { spatialLayer: spatial, temporalLayer: temporal };
}

/** mediasoup 'score' olayının dizisinden tek bir skor türet (en kötüsü). */
function overallScore(score) {
    const values = Array.isArray(score)
        ? score.map(s => s && s.score).filter(v => typeof v === 'number')
        : [];
    return values.length ? Math.min(...values) : 10;
}

module.exports = { getMaxTemporalLayer, getMaxSpatialLayer, pickLayers, overallScore };
