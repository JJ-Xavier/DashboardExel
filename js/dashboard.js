/*============================================================
  dashboard.js
  Orquestra a página de Dashboard. NÃO conhece nomes de coluna
  da planilha — descobre tudo via Database (que por sua vez usa
  o Analyzer). Cria KPIs, gráficos, filtros e tabela
  automaticamente, adaptando-se a qualquer planilha nova.
==============================================================*/

(function () {

    const app = document.getElementById("app");
    if (!app) return; // não é a página de dashboard

    const els = {
        sheetSelect: document.getElementById("sheetSelect"),
        kpiRow: document.getElementById("kpiRow"),
        filtersRow: document.getElementById("filtersRow"),
        searchInput: document.getElementById("searchInput"),
        chartsGrid: document.getElementById("chartsGrid"),
        dataTable: document.getElementById("dataTable"),
        rowCountLabel: document.getElementById("rowCountLabel"),
        emptyState: document.getElementById("emptyState"),
        clearFiltersBtn: document.getElementById("clearFiltersBtn")
    };

    let db = null;
    let currentSheet = null;

    async function boot() {
        db = await Database.loadFromStorage();

        if (!db || !db.getSheets().length) {
            els.emptyState && (els.emptyState.style.display = "flex");
            app.style.display = "none";
            return;
        }

        populateSheetSelector();
        loadSheet(db.getSheets()[0]);

        els.sheetSelect && els.sheetSelect.addEventListener("change", e => {
            Filters.clearAll();
            loadSheet(e.target.value);
        });

        els.searchInput && els.searchInput.addEventListener(
            "input",
            Utils.debounce(e => { Filters.setSearch(e.target.value); render(); }, 250)
        );

        els.clearFiltersBtn && els.clearFiltersBtn.addEventListener("click", () => {
            Filters.clearAll();
            if (els.searchInput) els.searchInput.value = "";
            renderFilterControls();
            render();
        });

        Filters.onChange(() => render());
    }

    function populateSheetSelector() {
        if (!els.sheetSelect) return;
        els.sheetSelect.innerHTML = db.getSheets()
            .map(name => `<option value="${name}">${name}</option>`)
            .join("");
    }

    function loadSheet(name) {
        currentSheet = db.sheet(name);
        renderFilterControls();
        render();
    }

    /*==================== FILTROS AUTOMÁTICOS ====================*/

    function renderFilterControls() {
        if (!els.filtersRow || !currentSheet) return;

        const controls = Filters.buildAutoFilters(currentSheet);
        els.filtersRow.innerHTML = "";

        controls.forEach(ctrl => {
            const wrap = document.createElement("div");
            wrap.className = "filter-control";

            if (ctrl.type === "select") {
                wrap.innerHTML = `
                    <label>${ctrl.label}</label>
                    <select data-role="${ctrl.role}">
                        <option value="__all__">Todos</option>
                        ${ctrl.options.map(v => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join("")}
                    </select>
                `;
                wrap.querySelector("select").addEventListener("change", e => {
                    Filters.setCondition(ctrl.role, e.target.value);
                });
            }

            if (ctrl.type === "dateRange") {
                wrap.innerHTML = `
                    <label>${ctrl.label}</label>
                    <div class="date-range">
                        <input type="date" data-role="${ctrl.role}" data-edge="start">
                        <span>até</span>
                        <input type="date" data-role="${ctrl.role}" data-edge="end">
                    </div>
                `;
                const [startInput, endInput] = wrap.querySelectorAll("input");
                const applyRange = () => {
                    if (startInput.value && endInput.value) {
                        Filters.setRangeCondition(
                            ctrl.role,
                            new Date(startInput.value).getTime(),
                            new Date(endInput.value).getTime()
                        );
                    }
                };
                startInput.addEventListener("change", applyRange);
                endInput.addEventListener("change", applyRange);
            }

            els.filtersRow.appendChild(wrap);
        });
    }

    /*==================== RENDER PRINCIPAL ====================*/

    function render() {
        if (!currentSheet) return;

        const rows = Filters.apply(currentSheet);

        renderKPIs(rows);
        renderCharts(rows);
        renderTable(rows);

        if (els.rowCountLabel) {
            els.rowCountLabel.textContent = `${Utils.formatNumber(rows.length)} registros`;
        }
    }

    /*==================== KPIs AUTOMÁTICOS ====================*/

    function renderKPIs(rows) {
        if (!els.kpiRow) return;

        const moneyCol = currentSheet.resolveColumn("money");
        const serviceCostCol = currentSheet.resolveColumn("serviceCost");
        const partsCostCol = currentSheet.resolveColumn("partsCost");
        const entityCol = currentSheet.resolveColumn("entityName");
        const statusCol = currentSheet.resolveColumn("status");
        const dateCol = currentSheet.resolveColumn("date");

        const cards = [];

        cards.push({
            label: "Total de Registros",
            value: Utils.formatNumber(rows.length)
        });

        if (serviceCostCol) {
            cards.push({
                label: "Custo de Serviço (Total)",
                value: Utils.formatMoney(Statistics.sum(rows, serviceCostCol))
            });
        }

        if (partsCostCol) {
            cards.push({
                label: "Custo de Peças (Total)",
                value: Utils.formatMoney(Statistics.sum(rows, partsCostCol))
            });
        }

        if (serviceCostCol && partsCostCol) {
            const sService = Statistics.sum(rows, serviceCostCol);
            const sParts = Statistics.sum(rows, partsCostCol);
            const totalSP = sService + sParts;
            const pctService = totalSP ? (sService / totalSP) * 100 : 0;
            cards.push({
                label: "% Serviço sobre o Total (Serviço+Peças)",
                value: `${Utils.formatNumber(pctService, 1)}%`
            });
        }

        if (moneyCol && !serviceCostCol && !partsCostCol) {
            cards.push({
                label: prettify(moneyCol) + " (Total)",
                value: Utils.formatMoney(Statistics.sum(rows, moneyCol))
            });
            cards.push({
                label: prettify(moneyCol) + " (Média)",
                value: Utils.formatMoney(Statistics.average(rows, moneyCol))
            });
        }

        if (entityCol) {
            cards.push({
                label: prettify(entityCol) + "s Únicos",
                value: Utils.formatNumber(Statistics.uniqueValues(rows, entityCol).length)
            });
        }

        if (statusCol) {
            const dist = Statistics.distribution(rows, statusCol, 1);
            if (dist.length) {
                cards.push({ label: `Status mais comum`, value: String(dist[0].label) });
            }
        }

        if (dateCol) {
            const dates = rows.map(r => Utils.parseDateSmart(r[dateCol])).filter(Boolean);
            if (dates.length) {
                const max = new Date(Math.max(...dates));
                cards.push({ label: "Registro mais recente", value: Utils.formatDate(max) });
            }
        }

        els.kpiRow.innerHTML = cards.map(c => `
            <div class="kpi-card">
                <span class="kpi-label">${c.label}</span>
                <span class="kpi-value">${c.value}</span>
            </div>
        `).join("");
    }

    /*==================== GRÁFICOS AUTOMÁTICOS ====================*/

    function renderCharts(rows) {
        if (!els.chartsGrid) return;

        // limpa
        els.chartsGrid.innerHTML = "";

        const statusCol = currentSheet.resolveColumn("status");
        const moneyCol = currentSheet.resolveColumn("money");
        const serviceCostCol = currentSheet.resolveColumn("serviceCost");
        const partsCostCol = currentSheet.resolveColumn("partsCost");
        const dateCol = currentSheet.resolveColumn("date");
        const entityCol = currentSheet.resolveColumn("entityName") || currentSheet.resolveColumn("modelName");

        let chartCount = 0;

        if (serviceCostCol && partsCostCol) {
            addChartCanvas("chartServicePartsSplit", "Custo de Serviço x Peças (Total)");
            const sService = Statistics.sum(rows, serviceCostCol);
            const sParts = Statistics.sum(rows, partsCostCol);
            requestAnimationFrame(() =>
                Charts.donut("chartServicePartsSplit", {
                    labels: ["Serviço", "Peças"],
                    values: [sService, sParts]
                })
            );
            chartCount++;

            if (dateCol) {
                addChartCanvas("chartServicePartsTrend", "Evolução: Serviço x Peças no Tempo");
                const trendService = groupByMonth(rows, dateCol, serviceCostCol);
                const trendParts = groupByMonth(rows, dateCol, partsCostCol);
                const allLabels = [...new Set([...trendService.map(t => t.label), ...trendParts.map(t => t.label)])].sort();
                const serviceMap = new Map(trendService.map(t => [t.label, t.value]));
                const partsMap = new Map(trendParts.map(t => [t.label, t.value]));
                requestAnimationFrame(() =>
                    Charts.multiLine("chartServicePartsTrend", {
                        labels: allLabels,
                        series: [
                            { label: "Serviço", data: allLabels.map(l => serviceMap.get(l) || 0) },
                            { label: "Peças", data: allLabels.map(l => partsMap.get(l) || 0) }
                        ]
                    })
                );
                chartCount++;
            }
        }

        if (statusCol) {
            addChartCanvas("chartStatus", "Distribuição por Status");
            const dist = Statistics.distribution(rows, statusCol, 8);
            requestAnimationFrame(() =>
                Charts.donut("chartStatus", {
                    labels: dist.map(d => String(d.label)),
                    values: dist.map(d => d.value)
                })
            );
            chartCount++;
        }

        if (moneyCol && entityCol) {
            addChartCanvas("chartTopEntities", `Top 10 por ${prettify(entityCol)}`);
            const grouped = groupSum(rows, entityCol, moneyCol).slice(0, 10);
            requestAnimationFrame(() =>
                Charts.horizontalBar("chartTopEntities", {
                    label: prettify(moneyCol),
                    labels: grouped.map(g => String(g.key)),
                    values: grouped.map(g => g.value)
                })
            );
            chartCount++;
        }

        if (moneyCol && dateCol) {
            addChartCanvas("chartTrend", `Evolução de ${prettify(moneyCol)} no Tempo`);
            const trend = groupByMonth(rows, dateCol, moneyCol);
            requestAnimationFrame(() =>
                Charts.line("chartTrend", {
                    label: prettify(moneyCol),
                    labels: trend.map(t => t.label),
                    values: trend.map(t => t.value)
                })
            );
            chartCount++;
        }

        if (!chartCount) {
            const firstCategorical = currentSheet.analysis.columns.find(c => c.role === "text" || c.role === "status");
            if (firstCategorical) {
                addChartCanvas("chartGeneric", `Distribuição de ${prettify(firstCategorical.column)}`);
                const dist = Statistics.distribution(rows, firstCategorical.column, 8);
                requestAnimationFrame(() =>
                    Charts.bar("chartGeneric", {
                        labels: dist.map(d => String(d.label)),
                        values: dist.map(d => d.value)
                    })
                );
            }
        }
    }

    function addChartCanvas(id, title) {
        const card = document.createElement("div");
        card.className = "chart-card";
        card.innerHTML = `<h3>${title}</h3><div class="chart-wrap"><canvas id="${id}"></canvas></div>`;
        els.chartsGrid.appendChild(card);
    }

    function groupSum(rows, keyCol, valCol) {
        const map = new Map();
        rows.forEach(r => {
            const k = r[keyCol] ?? "(vazio)";
            const v = Utils.parseNumberSmart(r[valCol]) || 0;
            map.set(k, (map.get(k) || 0) + v);
        });
        return [...map.entries()]
            .map(([key, value]) => ({ key, value }))
            .sort((a, b) => b.value - a.value);
    }

    function groupByMonth(rows, dateCol, valCol) {
        const map = new Map();
        rows.forEach(r => {
            const d = Utils.parseDateSmart(r[dateCol]);
            if (!d) return;
            const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
            const v = Utils.parseNumberSmart(r[valCol]) || 0;
            map.set(key, (map.get(key) || 0) + v);
        });
        return [...map.entries()]
            .sort((a, b) => a[0].localeCompare(b[0]))
            .map(([label, value]) => ({ label, value }));
    }

    /*==================== TABELA AUTOMÁTICA ====================*/

    function renderTable(rows) {
        if (!els.dataTable || !currentSheet) return;

        const cols = currentSheet.columns.slice(0, 10); // limita largura visual
        const visibleRows = rows.slice(0, 200);

        const thead = `<thead><tr>${cols.map(c => `<th>${prettify(c)}</th>`).join("")}</tr></thead>`;
        const tbody = `<tbody>${visibleRows.map(r => `
            <tr>${cols.map(c => `<td>${formatCell(r[c], c)}</td>`).join("")}</tr>
        `).join("")}</tbody>`;

        els.dataTable.innerHTML = thead + tbody;
    }

    function formatCell(value, colName) {
        if (value === null || value === undefined) return "-";
        const role = currentSheet.analysis.columns.find(c => c.column === colName)?.role;

        if (role === "money") {
            const n = Utils.parseNumberSmart(value);
            return n !== null ? Utils.formatMoney(n) : escapeHtml(String(value));
        }
        if (role === "date") {
            const d = Utils.parseDateSmart(value);
            return d ? Utils.formatDate(d) : escapeHtml(String(value));
        }
        if (value instanceof Date) return Utils.formatDate(value);

        return escapeHtml(String(value));
    }

    /*==================== HELPERS ====================*/

    function prettify(colName) {
        return colName.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
    }

    function escapeHtml(s) {
        return s.replace(/[&<>"']/g, c => ({
            "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
        }[c]));
    }

    document.addEventListener("DOMContentLoaded", boot);
    if (document.readyState !== "loading") boot();

})();