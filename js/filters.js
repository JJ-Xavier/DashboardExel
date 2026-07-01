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

    function setRangeCondition(role, min, max) {
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

    /**
     * Gera definições de controles de filtro automaticamente,
     * com base nos papéis disponíveis na planilha (sem hardcode
     * de nomes de coluna).
     */
    function buildAutoFilters(sheetApi) {
        const filterableRoles = ["status", "entityName", "modelName", "serviceOrder"];
        const controls = [];

        for (const role of filterableRoles) {
            const col = sheetApi.resolveColumn(role);
            if (!col) continue;

            const values = sheetApi.unique(role);
            if (values.length < 2 || values.length > 60) continue; // evita filtro inútil

            controls.push({
                role,
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

        return controls;
    }

    function prettifyLabel(colName) {
        return colName
            .replace(/_/g, " ")
            .replace(/\b\w/g, c => c.toUpperCase());
    }

    return {
        onChange, setSearch, setCondition, setRangeCondition,
        clearAll, getState, apply, buildAutoFilters
    };
})();

if (typeof module !== "undefined" && module.exports) module.exports = Filters;
