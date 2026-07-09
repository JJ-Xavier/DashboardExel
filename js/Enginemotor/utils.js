/*============================================================
  utils.js
  Funções utilitárias puras, sem dependência de nenhum outro
  módulo. Usadas por todo o restante do sistema (Analyzer,
  ExcelEngine, Statistics, Indexer, Dashboard...).
==============================================================*/

const Utils = (() => {

    /**
     * Remove acentos, espaços extras, deixa minúsculo.
     * Usado para comparar nomes de colunas de forma robusta,
     * independente de "Valor Total", "VALOR_TOTAL", "valor total".
     */
    function normalizeText(str) {
        if (str === null || str === undefined) return "";
        return String(str)
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "")   // remove acentos
            .toLowerCase()
            .replace(/[_\-./]+/g, " ")
            .replace(/[^a-z0-9% ]+/g, " ")
            .replace(/\s+/g, " ")
            .trim();
    }

    /**
     * Tokeniza um texto normalizado em palavras.
     */
    function tokenize(str) {
        const n = normalizeText(str);
        return n.length ? n.split(" ") : [];
    }

    /**
     * Distância de Levenshtein simples (para comparação fuzzy
     * de nomes de coluna / valores categóricos parecidos).
     */
    function levenshtein(a, b) {
        a = a || "";
        b = b || "";
        const m = a.length, n = b.length;
        if (m === 0) return n;
        if (n === 0) return m;

        const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));

        for (let i = 0; i <= m; i++) dp[i][0] = i;
        for (let j = 0; j <= n; j++) dp[0][j] = j;

        for (let i = 1; i <= m; i++) {
            for (let j = 1; j <= n; j++) {
                const cost = a[i - 1] === b[j - 1] ? 0 : 1;
                dp[i][j] = Math.min(
                    dp[i - 1][j] + 1,
                    dp[i][j - 1] + 1,
                    dp[i - 1][j - 1] + cost
                );
            }
        }
        return dp[m][n];
    }

    /**
     * Similaridade [0..1] entre duas strings, baseada em Levenshtein.
     */
    function similarity(a, b) {
        a = normalizeText(a);
        b = normalizeText(b);
        if (!a.length && !b.length) return 1;
        const dist = levenshtein(a, b);
        const maxLen = Math.max(a.length, b.length) || 1;
        return 1 - dist / maxLen;
    }

    /**
     * Converte string monetária brasileira / genérica em número.
     * Aceita: "R$ 1.234,56" | "1234.56" | "1.234,56" | "12%" | "-"
     */
    function parseNumberSmart(value) {
        if (typeof value === "number") return isFinite(value) ? value : null;
        if (value === null || value === undefined) return null;

        let s = String(value).trim();
        if (s === "" || s === "-" || s === "—") return null;

        const isPercent = /%\s*$/.test(s);
        s = s.replace(/[^\d,.\-]/g, "");

        if (s === "") return null;

        const hasComma = s.includes(",");
        const hasDot = s.includes(".");

        if (hasComma && hasDot) {
            // formato BR: 1.234,56 -> remove pontos (milhar), troca vírgula por ponto
            s = s.replace(/\./g, "").replace(",", ".");
        } else if (hasComma && !hasDot) {
            // 1234,56 -> 1234.56
            s = s.replace(",", ".");
        }
        // se só tem ponto, assume já é decimal padrão JS

        const num = parseFloat(s);
        if (isNaN(num)) return null;

        return isPercent ? num : num;
    }

    /**
     * Tenta interpretar uma data em vários formatos comuns
     * (BR dd/mm/yyyy, ISO yyyy-mm-dd, serial do Excel).
     * Retorna objeto Date válido ou null.
     */
    function parseDateSmart(value) {
        if (value === null || value === undefined || value === "") return null;

        // Serial do Excel (número de dias desde 1899-12-30)
        if (typeof value === "number") {
            const excelEpoch = new Date(Date.UTC(1899, 11, 30));
            const d = new Date(excelEpoch.getTime() + value * 86400000);
            return isNaN(d.getTime()) ? null : d;
        }

        const s = String(value).trim();
        if (!s) return null;

        // dd/mm/yyyy ou dd-mm-yyyy
        let m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
        if (m) {
            let [, d, mo, y, h, mi, se] = m;
            y = y.length === 2 ? "20" + y : y;
            const date = new Date(
                Number(y), Number(mo) - 1, Number(d),
                Number(h || 0), Number(mi || 0), Number(se || 0)
            );
            return isNaN(date.getTime()) ? null : date;
        }

        // yyyy-mm-dd (ISO)
        m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
        if (m) {
            let [, y, mo, d, h, mi, se] = m;
            const date = new Date(
                Number(y), Number(mo) - 1, Number(d),
                Number(h || 0), Number(mi || 0), Number(se || 0)
            );
            return isNaN(date.getTime()) ? null : date;
        }

        const generic = new Date(s);
        return isNaN(generic.getTime()) ? null : generic;
    }

    /** Formata número como moeda BRL */
    function formatMoney(n) {
        if (n === null || n === undefined || isNaN(n)) return "-";
        return n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
    }

    /** Formata número genérico com separador de milhar BR */
    function formatNumber(n, decimals = 0) {
        if (n === null || n === undefined || isNaN(n)) return "-";
        return n.toLocaleString("pt-BR", {
            minimumFractionDigits: decimals,
            maximumFractionDigits: decimals
        });
    }

    /** Formata data no padrão BR */
    function formatDate(d) {
        if (!(d instanceof Date) || isNaN(d.getTime())) return "-";
        return d.toLocaleDateString("pt-BR");
    }

    /** Gera um id único curto */
    function uid(prefix = "id") {
        return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    }

    /** Debounce simples para inputs de filtro/busca */
    function debounce(fn, wait = 250) {
        let t = null;
        return (...args) => {
            clearTimeout(t);
            t = setTimeout(() => fn(...args), wait);
        };
    }

    /** Calcula percentual de amostra que casa com um regex/testador */
    function matchRatio(samples, testFn) {
        const valid = samples.filter(v => v !== null && v !== undefined && String(v).trim() !== "");
        if (!valid.length) return 0;
        const hits = valid.filter(v => testFn(v)).length;
        return hits / valid.length;
    }

    /** Emissor de eventos simples (pub/sub) usado para progresso */
    class EventBus {
        constructor() { this.listeners = {}; }
        on(evt, cb) {
            (this.listeners[evt] = this.listeners[evt] || []).push(cb);
            return this;
        }
        off(evt, cb) {
            if (!this.listeners[evt]) return this;
            this.listeners[evt] = this.listeners[evt].filter(f => f !== cb);
            return this;
        }
        emit(evt, payload) {
            (this.listeners[evt] || []).forEach(cb => {
                try { cb(payload); } catch (e) { console.error(`[EventBus:${evt}]`, e); }
            });
            return this;
        }
    }

    return {
        normalizeText,
        tokenize,
        levenshtein,
        similarity,
        parseNumberSmart,
        parseDateSmart,
        formatMoney,
        formatNumber,
        formatDate,
        uid,
        debounce,
        matchRatio,
        EventBus
    };
})();

if (typeof module !== "undefined" && module.exports) module.exports = Utils;