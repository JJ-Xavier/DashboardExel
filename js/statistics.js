/*============================================================
  statistics.js
  Cálculo de estatísticas descritivas por coluna, operando
  sempre sobre PAPÉIS SEMÂNTICOS ou nomes literais de coluna,
  nunca assumindo schema fixo.
==============================================================*/

const Statistics = (() => {

    function numericValues(rows, col) {
        return rows
            .map(r => Utils.parseNumberSmart(r[col]))
            .filter(v => v !== null && !isNaN(v));
    }

    function sum(rows, col) {
        return numericValues(rows, col).reduce((a, b) => a + b, 0);
    }

    function average(rows, col) {
        const vals = numericValues(rows, col);
        return vals.length ? sum(rows, col) / vals.length : 0;
    }

    function min(rows, col) {
        const vals = numericValues(rows, col);
        return vals.length ? Math.min(...vals) : null;
    }

    function max(rows, col) {
        const vals = numericValues(rows, col);
        return vals.length ? Math.max(...vals) : null;
    }

    function median(rows, col) {
        const vals = numericValues(rows, col).sort((a, b) => a - b);
        if (!vals.length) return null;
        const mid = Math.floor(vals.length / 2);
        return vals.length % 2 ? vals[mid] : (vals[mid - 1] + vals[mid]) / 2;
    }

    function mode(rows, col) {
        const freq = new Map();
        rows.forEach(r => {
            const v = r[col];
            if (v === null || v === undefined || v === "") return;
            freq.set(v, (freq.get(v) || 0) + 1);
        });
        let best = null, bestCount = -1;
        for (const [val, count] of freq.entries()) {
            if (count > bestCount) { best = val; bestCount = count; }
        }
        return best;
    }

    function stddev(rows, col) {
        const vals = numericValues(rows, col);
        if (vals.length < 2) return 0;
        const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
        const variance = vals.reduce((acc, v) => acc + Math.pow(v - avg, 2), 0) / vals.length;
        return Math.sqrt(variance);
    }

    function uniqueValues(rows, col) {
        return [...new Set(rows.map(r => r[col]).filter(v => v !== null && v !== undefined && v !== ""))];
    }

    function nullCount(rows, col) {
        return rows.filter(r => r[col] === null || r[col] === undefined || r[col] === "").length;
    }

    function distribution(rows, col, maxBuckets = 12) {
        const freq = new Map();
        rows.forEach(r => {
            const v = r[col];
            if (v === null || v === undefined || v === "") return;
            const key = String(v);
            freq.set(key, (freq.get(key) || 0) + 1);
        });

        const sorted = [...freq.entries()].sort((a, b) => b[1] - a[1]);
        const top = sorted.slice(0, maxBuckets);
        const rest = sorted.slice(maxBuckets).reduce((acc, [, c]) => acc + c, 0);

        const result = top.map(([label, value]) => ({ label, value }));
        if (rest > 0) result.push({ label: "Outros", value: rest });
        return result;
    }

    /**
     * Gera um resumo estatístico completo de uma coluna, adaptando
     * o conjunto de métricas ao tipo detectado.
     */
    function summarizeColumn(rows, col, role = "text") {
        const base = {
            column: col,
            role,
            count: rows.length,
            nulls: nullCount(rows, col),
            unique: uniqueValues(rows, col).length
        };

        const numericRoles = ["money", "number", "percentage"];

        if (numericRoles.includes(role)) {
            return {
                ...base,
                sum: sum(rows, col),
                average: average(rows, col),
                median: median(rows, col),
                mode: mode(rows, col),
                min: min(rows, col),
                max: max(rows, col),
                stddev: stddev(rows, col)
            };
        }

        if (role === "date") {
            const dates = rows.map(r => Utils.parseDateSmart(r[col])).filter(Boolean);
            return {
                ...base,
                minDate: dates.length ? new Date(Math.min(...dates)) : null,
                maxDate: dates.length ? new Date(Math.max(...dates)) : null
            };
        }

        return {
            ...base,
            mode: mode(rows, col),
            distribution: distribution(rows, col)
        };
    }

    return {
        sum, average, min, max, median, mode, stddev,
        uniqueValues, nullCount, distribution, summarizeColumn
    };
})();

if (typeof module !== "undefined" && module.exports) module.exports = Statistics;
