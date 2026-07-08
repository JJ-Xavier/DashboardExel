/*============================================================
  filters.js
  Centraliza todo o estado de filtros do Dashboard. Gera os
  controles de filtro automaticamente a partir dos PAPÉIS
  semânticos descobertos pelo Analyzer (status, datas, entidades
  etc.), nunca a partir de nomes fixos de coluna.
==============================================================*/

const Filters = (() => {

    let state = {
        conditions: [],
        searchTerm: ""
    };

    const listeners = [];

    function onChange(cb) { listeners.push(cb); }

    function emit() { listeners.forEach(cb => cb(state)); }

    function setSearch(term) {
        state.searchTerm = term;
        emit();
    }

    function setCondition(role, value) {
        state.conditions = state.conditions.filter(c => c.role !== role);
        if (value !== null && value !== undefined && value !== "" && value !== "__all__") {
            state.conditions.push({ role, op: "=", value });
        }
        emit();
    }

    /**
     * Alterna um valor dentro de um filtro multi-seleção (op "in").
     * Se o valor já estiver selecionado, remove; caso contrário, adiciona.
     * Remove a condição inteira quando fica vazia.
     */
    function toggleValue(role, value) {
        let cond = state.conditions.find(c => c.role === role && c.op === "in");
        if (!cond) {
            cond = { role, op: "in", value: [value] };
            state.conditions.push(cond);
        } else {
            const idx = cond.value.indexOf(value);
            if (idx >= 0) cond.value.splice(idx, 1);
            else cond.value.push(value);
            if (cond.value.length === 0) {
                state.conditions = state.conditions.filter(c => c !== cond);
            }
        }
        emit();
    }

    /** Define de uma vez todos os valores selecionados de um filtro multi-seleção. */
    function setValues(role, values) {
        state.conditions = state.conditions.filter(c => c.role !== role);
        if (values && values.length) {
            state.conditions.push({ role, op: "in", value: [...values] });
        }
        emit();
    }

    /** Remove completamente a condição de um papel (ex.: clique no "x" de um chip agrupado). */
    function removeCondition(role) {
        state.conditions = state.conditions.filter(c => c.role !== role);
        emit();
    }

    /** Quantidade total de filtros ativos (cada condição conta 1, busca conta 1). */
    function activeCount() {
        return state.conditions.length + (state.searchTerm ? 1 : 0);
    }

    function setRangeCondition(role, min, max) {
        state.conditions = state.conditions.filter(c => c.role !== role);
        if (min !== null && max !== null) {
            state.conditions.push({ role, op: "dateBetween", value: [min, max] });
        }
        emit();
    }

    /**
     * Filtro de faixa numérica (mínimo/máximo) — usado em planilhas onde
     * as linhas já são um agregado (ex.: "resumo por dia") e não sobra
     * nenhuma coluna categórica para filtrar por igualdade. min/max
     * podem ser -Infinity/Infinity para um lado em aberto.
     */
    function setNumberRangeCondition(role, min, max) {
        state.conditions = state.conditions.filter(c => c.role !== role);
        if (min !== null && max !== null) {
            state.conditions.push({ role, op: "between", value: [min, max] });
        }
        emit();
    }

    function clearAll() {
        state = { conditions: [], searchTerm: "" };
        emit();
    }

    function getState() { return state; }

    /**
     * Aplica o estado atual de filtros sobre uma SheetAPI e
     * retorna as linhas resultantes.
     */
    function apply(sheetApi) {
        let rows = sheetApi.filter(state.conditions);
        if (state.searchTerm) {
            rows = sheetApi.search(state.searchTerm, { rows });
        }
        return rows;
    }

    // Papéis que NUNCA fazem sentido como filtro de seleção (dinheiro,
    // identificadores únicos, documentos, contato, data — que tem
    // controle próprio de intervalo). Qualquer outra coluna categórica
    // de baixa cardinalidade vira filtro automaticamente, em QUALQUER
    // aba, sem precisar saber o nome ou o papel da coluna de antemão.
    const NEVER_FILTERABLE_ROLES = new Set([
        "money", "serviceCost", "partsCost", "date",
        "document_cpf", "document_cnpj", "email", "phone",
        "id", "plate", "percentage", "number"
    ]);

    // Planilhas de RESUMO (uma linha = um dia agregado) não têm nenhuma
    // coluna categórica sobrando para filtrar por igualdade — só colunas
    // numéricas (valores, contagens, percentuais). Nessas abas específicas,
    // em vez de nenhum filtro além da data, geramos filtro de faixa
    // (mínimo/máximo) para cada coluna numérica agregada. Fora dessa
    // lista, colunas numéricas continuam sem filtro — a maioria das
    // outras abas é "por registro" (uma OS, um cliente), onde faixa
    // numérica tende a ser menos útil que os filtros categóricos normais.
    const NUMERIC_RANGE_SHEETS = new Set([
        "RESUMO POR DIA CARROS",
        "RESUMO POR DIA MOTO"
    ]);
    const NUMERIC_RANGE_ROLES = new Set(["money", "serviceCost", "partsCost", "number", "percentage"]);

    /**
     * Gera definições de controles de filtro automaticamente,
     * com base em QUALQUER coluna categórica de baixa cardinalidade
     * (2 a 60 valores únicos), independentemente do papel semântico
     * ou do nome de coluna. Isso garante que o mesmo sistema de
     * filtros funcione de forma padronizada em qualquer aba/planilha.
     */
    // Cabeçalhos em branco na planilha original viram "Coluna_N" (ver
    // excelEngine.js). Não é um campo de negócio de verdade — é um
    // preenchimento sintético para a planilha não quebrar — então nunca
    // deve virar filtro (só gera ruído do tipo "Coluna_18" na tela).
    const BLANK_HEADER_PATTERN = /^Coluna_\d+(_\d+)?$/i;

    function buildAutoFilters(sheetApi) {
        const columnRoles = sheetApi.getColumnRoles(); // [{column, role, ...}]
        const controls = [];
        const seen = new Set();

        // O limite de "quantos valores únicos ainda é um filtro útil"
        // se adapta ao tamanho da aba: planilhas grandes (ex.: milhares
        // de OS) tendem a acumular mais variações legítimas de uma
        // mesma coluna categórica (ex.: modelos de veículo) do que
        // planilhas pequenas. Um teto fixo (ex.: 60) fazia com que a
        // MESMA coluna (ex.: "MODELO VEÍCULO") virasse filtro em abas
        // menores e sumisse em abas maiores, dando a impressão de
        // filtros inconsistentes entre abas.
        const totalRows = sheetApi.rows.length;
        const maxUnique = Math.min(150, Math.max(60, Math.round(totalRows * 0.02)));

        for (const colInfo of columnRoles) {
            const col = colInfo.column;
            if (seen.has(col)) continue;
            if (NEVER_FILTERABLE_ROLES.has(colInfo.role)) continue;
            if (BLANK_HEADER_PATTERN.test(col)) continue;

            const values = sheetApi.unique(col);
            if (values.length < 2 || values.length > maxUnique) continue; // evita filtro inútil

            seen.add(col);
            controls.push({
                role: col, // a própria coluna é a chave única do filtro
                column: col,
                label: prettifyLabel(col),
                type: "select",
                options: values.sort()
            });
        }

        const dateCol = sheetApi.resolveColumn("date");
        if (dateCol) {
            controls.push({
                role: "date",
                column: dateCol,
                label: prettifyLabel(dateCol),
                type: "dateRange"
            });
        }

        if (NUMERIC_RANGE_SHEETS.has(sheetApi.name)) {
            for (const colInfo of columnRoles) {
                const col = colInfo.column;
                if (seen.has(col)) continue; // já é filtro de outro tipo
                if (!NUMERIC_RANGE_ROLES.has(colInfo.role)) continue;
                if (BLANK_HEADER_PATTERN.test(col)) continue;

                let min = null, max = null;
                for (const row of sheetApi.rows) {
                    const n = Utils.parseNumberSmart(row[col]);
                    if (n === null) continue;
                    if (min === null || n < min) min = n;
                    if (max === null || n > max) max = n;
                }
                if (min === null || max === null || min === max) continue; // sem variação = filtro inútil

                seen.add(col);
                controls.push({
                    role: col,
                    column: col,
                    label: prettifyLabel(col),
                    type: "numberRange",
                    min,
                    max
                });
            }
        }

        return controls;
    }

    function prettifyLabel(colName) {
        return colName
            .replace(/_/g, " ")
            .replace(/\b\w/g, c => c.toUpperCase());
    }

    return {
        onChange, setSearch, setCondition, setRangeCondition, setNumberRangeCondition,
        toggleValue, setValues, removeCondition, activeCount,
        clearAll, getState, apply, buildAutoFilters
    };
})();

if (typeof module !== "undefined" && module.exports) module.exports = Filters;