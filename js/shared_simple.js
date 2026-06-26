// =====================
// SHARED UTILITIES - SIMPLE VERSION
// =====================

function norm(s) {
    return s ? s.trim().replace(/\s+/g, ' ') : '';
}

function normEq(a, b) {
    return norm(a).toLowerCase() === norm(b).toLowerCase();
}

function escapeHtml(str) {
    return (str || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function extractProduk(str) {
    if (!str) return null;
    const match = str.match(/\b(DIABCARE|URICARE|GASTRIC|STROCAV|DIALIVE)\b/i);
    return match ? match[0].toUpperCase() : null;
}

function extractEkspedisi(str) {
    if (!str) return null;
    const match = str.match(/\b(JNE|JNT|SICEPAT|ANTERAJA|NINJA|ID EXPRESS|SAP|GOSEND|GRAB)\b/i);
    return match ? match[0].toUpperCase() : null;
}
