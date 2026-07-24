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
        if (!vals.length) return 0;
        let total = 0;
        for (let i = 0; i < vals.length; i++) total += vals[i];
        return total / vals.length;
    }

    /**
     * min/max por VARREDURA, não por spread.
     * `Math.min(...vals)` empurra cada valor como argumento na pilha de
     * chamada: em abas grandes (dezenas de milhares de linhas) isso
     * estoura com "Maximum call stack size exceeded" e derruba a
     * renderizacao inteira. Um laco simples nao tem esse limite.
     */
    function min(rows, col) {
        const vals = numericValues(rows, col);
        if (!vals.length) return null;
        let m = vals[0];
        for (let i = 1; i < vals.length; i++) if (vals[i] < m) m = vals[i];
        return m;
    }

    function max(rows, col) {
        const vals = numericValues(rows, col);
        if (!vals.length) return null;
        let m = vals[0];
        for (let i = 1; i < vals.length; i++) if (vals[i] > m) m = vals[i];
        return m;
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
     *
     * OTIMIZAÇÃO: antes, cada métrica (sum/average/median/mode/min/max/
     * stddev/unique/nulls) chamava sua própria função, e cada uma delas
     * varria TODAS as linhas de novo (~9 passadas completas por coluna
     * numérica, cada uma reprocessando parseNumberSmart/parseDateSmart
     * do zero). Aqui, para uso interno de summarizeColumn, os mesmos
     * resultados são obtidos em UMA única passada pelas linhas; os
     * valores numéricos/datas já extraídos nessa passada alimentam sum,
     * average, median, mode, min, max e stddev sem re-scan.
     *
     * As funções públicas (Statistics.sum, .average, .distribution etc.)
     * continuam existindo e podem ser chamadas isoladamente com
     * qualquer subconjunto de linhas (ex: dashboard.js durante filtros
     * ao vivo) — não foram removidas nem tiveram assinatura alterada.
     */
    /**
     * Menor (dir = -1) ou maior (dir = 1) data de uma lista, por
     * varredura. Mesmo motivo do min/max numerico: `Math.min(...arr)`
     * estoura a pilha em listas grandes.
     */
    function minMaxDate(dateVals, dir) {
        if (!dateVals || !dateVals.length) return null;
        let best = dateVals[0];
        for (let i = 1; i < dateVals.length; i++) {
            const cmp = dateVals[i].getTime() - best.getTime();
            if ((dir < 0 && cmp < 0) || (dir > 0 && cmp > 0)) best = dateVals[i];
        }
        return new Date(best.getTime());
    }

    function summarizeColumn(rows, col, role = "text") {
        // serviceCost e partsCost sao valores monetarios como qualquer
        // outro: sem eles nesta lista, colunas de custo eram resumidas
        // como CATEGORICAS — sem soma/media/mediana/min/max — e ainda
        // montavam uma tabela de frequencia com milhares de valores
        // distintos a cada importacao (resumo errado + trabalho jogado
        // fora).
        const numericRoles = ["money", "serviceCost", "partsCost", "number", "percentage"];
        const isNumeric = numericRoles.includes(role);
        const isDate = role === "date";

        let nulls = 0;
        const uniqueSet = new Set();
        const freq = new Map();          // valor bruto -> contagem (usado por mode, igual à função mode() original)
        const freqStr = isNumeric || isDate ? null : new Map(); // String(valor) -> contagem (usado por distribution, igual à função distribution() original)
        const numericVals = isNumeric ? [] : null;
        const dateVals = isDate ? [] : null;

        for (let i = 0; i < rows.length; i++) {
            const v = rows[i][col];
            if (v === null || v === undefined || v === "") {
                nulls++;
                continue;
            }

            uniqueSet.add(v);
            freq.set(v, (freq.get(v) || 0) + 1);
            if (freqStr) {
                const key = String(v);
                freqStr.set(key, (freqStr.get(key) || 0) + 1);
            }

            if (isNumeric) {
                const n = Utils.parseNumberSmart(v);
                if (n !== null && !isNaN(n)) numericVals.push(n);
            } else if (isDate) {
                const d = Utils.parseDateSmart(v);
                if (d) dateVals.push(d);
            }
        }

        const base = {
            column: col,
            role,
            count: rows.length,
            nulls,
            unique: uniqueSet.size
        };

        const modeFromFreq = () => {
            let best = null, bestCount = -1;
            for (const [val, count] of freq.entries()) {
                if (count > bestCount) { best = val; bestCount = count; }
            }
            return best;
        };

        if (isNumeric) {
            const n = numericVals.length;
            let sumV = 0, minV = Infinity, maxV = -Infinity;
            for (let i = 0; i < n; i++) {
                const val = numericVals[i];
                sumV += val;
                if (val < minV) minV = val;
                if (val > maxV) maxV = val;
            }
            const avg = n ? sumV / n : 0;

            let variance = 0;
            for (let i = 0; i < n; i++) variance += Math.pow(numericVals[i] - avg, 2);
            const stddevV = n >= 2 ? Math.sqrt(variance / n) : 0;

            const sorted = numericVals.slice().sort((a, b) => a - b);
            let med = null;
            if (sorted.length) {
                const mid = Math.floor(sorted.length / 2);
                med = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
            }

            return {
                ...base,
                sum: sumV,
                average: avg,
                median: med,
                mode: modeFromFreq(),
                min: n ? minV : null,
                max: n ? maxV : null,
                stddev: stddevV
            };
        }

        if (isDate) {
            return {
                ...base,
                minDate: minMaxDate(dateVals, -1),
                maxDate: minMaxDate(dateVals, 1)
            };
        }

        const maxBuckets = 12;
        const sortedFreq = [...freqStr.entries()].sort((a, b) => b[1] - a[1]);
        const top = sortedFreq.slice(0, maxBuckets);
        const rest = sortedFreq.slice(maxBuckets).reduce((acc, [, c]) => acc + c, 0);
        const dist = top.map(([label, value]) => ({ label, value }));
        if (rest > 0) dist.push({ label: "Outros", value: rest });

        return {
            ...base,
            mode: modeFromFreq(),
            distribution: dist
        };
    }

    return {
        sum, average, min, max, median, mode, stddev,
        uniqueValues, nullCount, distribution, summarizeColumn
    };
})();

if (typeof module !== "undefined" && module.exports) module.exports = Statistics;