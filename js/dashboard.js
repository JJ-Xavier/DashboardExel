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
        clearFiltersBtn: document.getElementById("clearFiltersBtn"),
        filterCountBadge: document.getElementById("filterCountBadge"),
        activeChipsRow: document.getElementById("activeChipsRow"),
        dashboardView: document.getElementById("dashboardView"),
        reportsView: document.getElementById("reportsView"),
        reportsContainer: document.getElementById("reportsContainer"),
        topbarTitle: document.getElementById("topbarTitle"),
        sidebarLinks: document.querySelectorAll(".sidebar-link[data-view]"),
        newImportLink: document.getElementById("newImportLink"),
        newImportBtnTop: document.getElementById("newImportBtnTop"),
        emptyStateImportBtn: document.getElementById("emptyStateImportBtn"),
        clearCacheLink: document.getElementById("clearCacheLink"),
        configColumnsBtn: document.getElementById("configColumnsBtn"),
        columnPickerPanel: document.getElementById("columnPickerPanel")
    };

    let db = null;
    let currentSheet = null;
    let currentView = "dashboard";
    let roleLabels = {};        // rótulo legível de cada filtro da aba atual
    let visibleColumns = null;  // colunas escolhidas manualmente para a aba atual (null = usar padrão)

    async function boot() {
        wireCacheControls();
        wireColumnPicker();

        db = await Database.loadFromStorage();

        if (!db || !db.getSheets().length) {
            els.emptyState && (els.emptyState.style.display = "flex");
            app.style.display = "none";
            return;
        }

        populateSheetSelector();
        loadSheet(pickDefaultSheet());

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

        Filters.onChange(() => { render(); syncFilterUI(); });

        els.sidebarLinks.forEach(link => {
            link.addEventListener("click", e => {
                e.preventDefault();
                switchView(link.dataset.view);
            });
        });
    }

    /*==================== TROCA DE VIEW (Dashboard / Relatórios) ====================*/

    function switchView(view) {
        currentView = view;

        els.sidebarLinks.forEach(link => {
            link.classList.toggle("active", link.dataset.view === view);
        });

        if (els.dashboardView) els.dashboardView.style.display = view === "dashboard" ? "flex" : "none";
        if (els.reportsView) els.reportsView.style.display = view === "reports" ? "flex" : "none";
        if (els.topbarTitle) els.topbarTitle.textContent = view === "reports" ? "Relatórios" : "Dashboard";

        if (view === "reports") renderReports();
    }

    /**
     * "Nova importação" agora limpa o banco local (IndexedDB) ANTES de
     * redirecionar para a tela de import — evita o cenário de dados
     * antigos/de uma versão anterior do sistema ficarem "grudados" e
     * mostrarem números incoerentes mesmo depois de importar uma
     * planilha nova. "Limpar cache" faz o mesmo sem sair da página,
     * útil para diagnosticar problemas sem precisar reimportar na hora.
     */
    function wireCacheControls() {
        const goToImportAfterClear = async (e) => {
            e.preventDefault();
            try { await Database.clear(); } catch (err) { console.error("Falha ao limpar cache:", err); }
            window.location.href = "index.html";
        };

        els.newImportLink && els.newImportLink.addEventListener("click", goToImportAfterClear);
        els.newImportBtnTop && els.newImportBtnTop.addEventListener("click", goToImportAfterClear);
        els.emptyStateImportBtn && els.emptyStateImportBtn.addEventListener("click", goToImportAfterClear);

        els.clearCacheLink && els.clearCacheLink.addEventListener("click", async (e) => {
            e.preventDefault();
            const confirmed = window.confirm(
                "Isso vai apagar os dados importados salvos neste navegador. " +
                "Você precisará importar a planilha novamente. Continuar?"
            );
            if (!confirmed) return;

            try {
                await Database.clear();
                window.location.reload();
            } catch (err) {
                console.error("Falha ao limpar cache:", err);
                alert("Não foi possível limpar o cache. Veja o console (F12) para detalhes.");
            }
        });
    }

    /*==================== COLUNAS VISÍVEIS NO DETALHAMENTO (config manual) ====================*/

    const COLUMN_PREFS_KEY = "kapo_column_prefs";

    /**
     * Cada planilha tem sua própria "quantidade relevante" de colunas —
     * decidida manualmente pela pessoa usando o dashboard, não adivinhada
     * automaticamente. As escolhas ficam salvas no localStorage por nome
     * de aba, então sobrevivem a reimportações da mesma planilha.
     */
    function getAllColumnPrefs() {
        try {
            return JSON.parse(localStorage.getItem(COLUMN_PREFS_KEY)) || {};
        } catch (e) {
            return {};
        }
    }

    function loadColumnPrefs(sheetName) {
        const all = getAllColumnPrefs();
        return all[sheetName] || null; // null = sem preferência salva, usa padrão
    }

    function saveColumnPrefs(sheetName, columns) {
        const all = getAllColumnPrefs();
        all[sheetName] = columns;
        localStorage.setItem(COLUMN_PREFS_KEY, JSON.stringify(all));
    }

    function wireColumnPicker() {
        if (!els.configColumnsBtn || !els.columnPickerPanel) return;

        els.configColumnsBtn.addEventListener("click", () => {
            const isOpen = els.columnPickerPanel.style.display !== "none";
            if (isOpen) {
                els.columnPickerPanel.style.display = "none";
                return;
            }
            renderColumnPickerPanel();
            els.columnPickerPanel.style.display = "flex";
        });
    }

    function renderColumnPickerPanel() {
        if (!currentSheet) return;

        const allCols = currentSheet.columns;
        const defaultVisible = allCols.slice(0, 10);
        const selected = new Set(visibleColumns || defaultVisible);

        const checkboxesHtml = allCols.map(col => `
            <label>
                <input type="checkbox" value="${escapeHtml(col)}" ${selected.has(col) ? "checked" : ""}>
                ${escapeHtml(prettify(col))}
            </label>
        `).join("");

        els.columnPickerPanel.innerHTML = `
            ${checkboxesHtml}
            <div class="column-picker-actions">
                <button class="btn-primary" id="applyColumnsBtn" type="button">Aplicar</button>
                <button class="btn-secondary" id="resetColumnsBtn" type="button">Restaurar padrão</button>
            </div>
        `;

        els.columnPickerPanel.querySelector("#applyColumnsBtn").addEventListener("click", () => {
            const checked = [...els.columnPickerPanel.querySelectorAll("input[type=checkbox]:checked")]
                .map(cb => cb.value);
            visibleColumns = checked.length ? checked : defaultVisible;
            saveColumnPrefs(currentSheet.name, visibleColumns);
            els.columnPickerPanel.style.display = "none";
            render();
        });

        els.columnPickerPanel.querySelector("#resetColumnsBtn").addEventListener("click", () => {
            visibleColumns = null;
            saveColumnPrefs(currentSheet.name, null);
            els.columnPickerPanel.style.display = "none";
            render();
        });
    }

    function populateSheetSelector() {
        if (!els.sheetSelect) return;
        els.sheetSelect.innerHTML = db.getSheets()
            .map(name => `<option value="${name}">${name}</option>`)
            .join("");
        els.sheetSelect.value = pickDefaultSheet();
    }

    /**
     * Evita abrir por padrão uma aba "legada"/histórica (comum em bases
     * financeiras que mantêm uma planilha antiga junto da atual). Prefere
     * a primeira aba cujo nome não sinalize isso; se todas sinalizarem,
     * cai de volta para a primeira aba mesmo assim.
     */
    function pickDefaultSheet() {
        const names = db.getSheets();
        const legacyPattern = /antiga?|legad|legacy|hist[oó]ric/i;
        const preferred = names.find(n => !legacyPattern.test(n));
        return preferred || names[0];
    }

    function loadSheet(name) {
        currentSheet = db.sheet(name);
        visibleColumns = loadColumnPrefs(name);
        renderFilterControls();
        render();
        if (currentView === "reports") renderReports();
    }

    /*==================== FILTROS AUTOMÁTICOS ====================*/

    function renderFilterControls() {
        if (!els.filtersRow || !currentSheet) return;

        const controls = Filters.buildAutoFilters(currentSheet);
        els.filtersRow.innerHTML = "";
        roleLabels = {};
        controls.forEach(ctrl => { roleLabels[ctrl.role] = ctrl.label; });

        controls.forEach(ctrl => {
            const wrap = document.createElement("div");
            wrap.className = "filter-control";

            if (ctrl.type === "select") {
                wrap.classList.add("multiselect");
                wrap.dataset.role = ctrl.role;
                wrap.innerHTML = `
                    <label>${ctrl.label}</label>
                    <button type="button" class="ms-toggle" data-role="${ctrl.role}">
                        <span class="ms-toggle-text">Todos</span>
                        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>
                    </button>
                    <div class="ms-panel" hidden>
                        <div class="ms-panel-actions">
                            <button type="button" class="ms-clear">Limpar</button>
                        </div>
                        <div class="ms-options">
                            ${ctrl.options.map(v => `
                                <label class="ms-option">
                                    <input type="checkbox" value="${escapeHtml(v)}">
                                    <span>${escapeHtml(v)}</span>
                                </label>
                            `).join("")}
                        </div>
                    </div>
                `;

                const toggleBtn = wrap.querySelector(".ms-toggle");
                const panel = wrap.querySelector(".ms-panel");
                const checkboxes = [...wrap.querySelectorAll('input[type="checkbox"]')];

                toggleBtn.addEventListener("click", e => {
                    e.stopPropagation();
                    const isOpen = !panel.hidden;
                    closeAllMultiselects();
                    panel.hidden = isOpen;
                    toggleBtn.classList.toggle("open", !panel.hidden);
                });

                checkboxes.forEach(cb => {
                    cb.addEventListener("change", () => {
                        Filters.toggleValue(ctrl.role, cb.value);
                        updateMultiselectToggleText(wrap, ctrl);
                    });
                });

                wrap.querySelector(".ms-clear").addEventListener("click", () => {
                    Filters.removeCondition(ctrl.role);
                    checkboxes.forEach(cb => cb.checked = false);
                    updateMultiselectToggleText(wrap, ctrl);
                });
            }

            if (ctrl.type === "dateRange") {
                wrap.classList.add("date-filter");
                wrap.dataset.role = ctrl.role;
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
                    if (!startInput.value && !endInput.value) {
                        Filters.removeCondition(ctrl.role);
                        return;
                    }

                    let start = startInput.value ? new Date(startInput.value) : null;
                    let end = endInput.value ? new Date(endInput.value) : null;

                    if (start) start.setHours(0, 0, 0, 0);
                    if (end) end.setHours(23, 59, 59, 999);

                    // Se o usuário inverter as datas, troca automaticamente
                    if (start && end && start.getTime() > end.getTime()) {
                        [start, end] = [end, start];
                    }

                    Filters.setRangeCondition(
                        ctrl.role,
                        start ? start.getTime() : -Infinity,
                        end ? end.getTime() : Infinity
                    );
                };
                startInput.addEventListener("change", applyRange);
                endInput.addEventListener("change", applyRange);
            }

            els.filtersRow.appendChild(wrap);
        });

        syncFilterUI();
    }

    function closeAllMultiselects() {
        els.filtersRow.querySelectorAll(".ms-panel").forEach(p => p.hidden = true);
        els.filtersRow.querySelectorAll(".ms-toggle").forEach(b => b.classList.remove("open"));
    }

    // Fecha os dropdowns de multi-seleção ao clicar fora deles
    document.addEventListener("click", e => {
        if (els.filtersRow && !els.filtersRow.contains(e.target)) closeAllMultiselects();
    });

    function updateMultiselectToggleText(wrap, ctrl) {
        const cond = Filters.getState().conditions.find(c => c.role === ctrl.role && c.op === "in");
        const textEl = wrap.querySelector(".ms-toggle-text");
        if (!cond || !cond.value.length) {
            textEl.textContent = "Todos";
        } else if (cond.value.length === 1) {
            textEl.textContent = cond.value[0];
        } else {
            textEl.textContent = `${cond.value.length} selecionados`;
        }
    }

    /**
     * Mantém os checkboxes, o texto dos dropdowns, o contador de filtros
     * ativos e a linha de chips removíveis em sincronia com Filters.state.
     */
    function syncFilterUI() {
        if (!els.filtersRow) return;

        const state = Filters.getState();

        els.filtersRow.querySelectorAll(".multiselect").forEach(wrap => {
            const role = wrap.dataset.role;
            const cond = state.conditions.find(c => c.role === role && c.op === "in");
            const selected = cond ? cond.value : [];

            wrap.querySelectorAll('input[type="checkbox"]').forEach(cb => {
                cb.checked = selected.includes(cb.value);
            });

            const textEl = wrap.querySelector(".ms-toggle-text");
            if (textEl) {
                if (!selected.length) textEl.textContent = "Todos";
                else if (selected.length === 1) textEl.textContent = selected[0];
                else textEl.textContent = `${selected.length} selecionados`;
            }
        });

        els.filtersRow.querySelectorAll(".date-filter").forEach(wrap => {
            const role = wrap.dataset.role;
            const cond = state.conditions.find(c => c.role === role && c.op === "dateBetween");
            const [startInput, endInput] = wrap.querySelectorAll("input");
            if (!cond) {
                if (startInput) startInput.value = "";
                if (endInput) endInput.value = "";
            }
        });

        const count = Filters.activeCount();
        if (els.filterCountBadge) {
            els.filterCountBadge.style.display = count > 0 ? "inline-block" : "none";
            els.filterCountBadge.textContent = count;
        }

        renderActiveChips(state);
    }

    /** Renderiza chips removíveis para cada filtro/valor ativo, mais a busca. */
    function renderActiveChips(state) {
        if (!els.activeChipsRow) return;

        const chips = [];

        state.conditions.forEach(cond => {
            const label = prettifyRole(cond.role);
            if (cond.op === "in") {
                cond.value.forEach(v => {
                    chips.push({ text: `${label}: ${v}`, onRemove: () => Filters.toggleValue(cond.role, v) });
                });
            } else if (cond.op === "dateBetween" || cond.op === "between") {
                const [min, max] = cond.value;
                const fmt = ts => isFinite(ts) ? Utils.formatDate(new Date(ts)) : null;
                const startTxt = fmt(min);
                const endTxt = fmt(max);
                let rangeTxt;
                if (startTxt && endTxt) rangeTxt = `${startTxt} até ${endTxt}`;
                else if (startTxt) rangeTxt = `a partir de ${startTxt}`;
                else if (endTxt) rangeTxt = `até ${endTxt}`;
                else rangeTxt = "intervalo";
                chips.push({ text: `${label}: ${rangeTxt}`, onRemove: () => Filters.removeCondition(cond.role) });
            } else {
                chips.push({ text: `${label}: ${cond.value}`, onRemove: () => Filters.removeCondition(cond.role) });
            }
        });

        if (state.searchTerm) {
            chips.push({
                text: `Busca: "${state.searchTerm}"`,
                onRemove: () => {
                    Filters.setSearch("");
                    if (els.searchInput) els.searchInput.value = "";
                }
            });
        }

        els.activeChipsRow.innerHTML = "";
        els.activeChipsRow.style.display = chips.length ? "flex" : "none";

        chips.forEach(chip => {
            const el = document.createElement("span");
            el.className = "filter-chip";
            el.innerHTML = `${escapeHtml(chip.text)} <button type="button" aria-label="Remover filtro">&times;</button>`;
            el.querySelector("button").addEventListener("click", chip.onRemove);
            els.activeChipsRow.appendChild(el);
        });
    }

    function prettifyRole(role) {
        if (roleLabels[role]) return roleLabels[role];
        return String(role)
            .replace(/_/g, " ")
            .replace(/\b\w/g, c => c.toUpperCase());
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

        if (moneyCol) {
            cards.push({
                label: "Faturamento Total",
                value: Utils.formatMoney(Statistics.sum(rows, moneyCol))
            });
            cards.push({
                label: "Ticket Médio por O.S",
                value: Utils.formatMoney(Statistics.average(rows, moneyCol))
            });
        }

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
                label: "% Serviço sobre Serviço+Peças",
                value: `${Utils.formatNumber(pctService, 1)}%`
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

        const moneyCol = currentSheet.resolveColumn("money");
        const serviceCostCol = currentSheet.resolveColumn("serviceCost");
        const partsCostCol = currentSheet.resolveColumn("partsCost");
        const dateCol = currentSheet.resolveColumn("date");
        const entityCol = currentSheet.resolveColumn("entityName") || currentSheet.resolveColumn("modelName");
        const maintenanceCol = currentSheet.resolveColumn("maintenanceType");
        const statusCol = currentSheet.resolveColumn("status");

        let chartCount = 0;

        // 1) FATURAMENTO MENSAL — prioridade máxima, gráfico largo no topo.
        if (moneyCol && dateCol) {
            addChartCanvas("chartMonthlyRevenue", "Faturamento Total (Evolução Mensal)", { wide: true });
            const trend = groupByMonth(rows, dateCol, moneyCol);
            requestAnimationFrame(() =>
                Charts.line("chartMonthlyRevenue", {
                    label: "Faturamento",
                    labels: trend.map(t => t.label),
                    values: trend.map(t => t.value)
                })
            );
            chartCount++;
        }

        // 2) SERVIÇO x PEÇAS — proporção total + evolução mensal comparada.
        if (serviceCostCol && partsCostCol) {
            addChartCanvas("chartServicePartsSplit", "Custo de Serviço x Peças (Proporção)");
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
                addChartCanvas("chartServicePartsTrend", "Serviço x Peças — Evolução Mensal", { wide: true });
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

        // 3) TIPO DE MANUTENÇÃO — faturamento por Corretiva/Preventiva/Sinistro.
        if (maintenanceCol && moneyCol) {
            addChartCanvas("chartMaintenanceType", "Faturamento por Tipo de Manutenção");
            const grouped = groupSum(rows, maintenanceCol, moneyCol);
            requestAnimationFrame(() =>
                Charts.donut("chartMaintenanceType", {
                    labels: grouped.map(g => String(g.key)),
                    values: grouped.map(g => g.value)
                })
            );
            chartCount++;
        } else if (maintenanceCol) {
            addChartCanvas("chartMaintenanceType", "Distribuição por Tipo de Manutenção");
            const dist = Statistics.distribution(rows, maintenanceCol, 8);
            requestAnimationFrame(() =>
                Charts.donut("chartMaintenanceType", {
                    labels: dist.map(d => String(d.label)),
                    values: dist.map(d => d.value)
                })
            );
            chartCount++;
        }

        // 4) RANKING DE CLIENTES/FROTAS — quem mais fatura.
        if (moneyCol && entityCol) {
            addChartCanvas("chartTopEntities", `Top 10 ${prettify(entityCol)} por Faturamento`);
            const grouped = groupSum(rows, entityCol, moneyCol).slice(0, 10);
            requestAnimationFrame(() =>
                Charts.horizontalBar("chartTopEntities", {
                    label: "Faturamento",
                    labels: grouped.map(g => String(g.key)),
                    values: grouped.map(g => g.value)
                })
            );
            chartCount++;
        }

        // Extra: status, só se ainda houver espaço relevante e a coluna existir.
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

    function addChartCanvas(id, title, opts = {}) {
        const card = document.createElement("div");
        card.className = opts.wide ? "chart-card chart-card-wide" : "chart-card";
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

        const cols = (visibleColumns && visibleColumns.length)
            ? visibleColumns.filter(c => currentSheet.columns.includes(c))
            : currentSheet.columns.slice(0, 10); // padrão: primeiras 10, até o usuário configurar
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

    /*==================== RELATÓRIOS AUTOMÁTICOS ====================*/

    /**
     * Gera relatórios de negócio automaticamente a partir dos PAPÉIS
     * SEMÂNTICOS disponíveis na aba atual (nunca por nome fixo de
     * coluna). Cada relatório só aparece se os dados necessários
     * existirem na planilha selecionada.
     */
    function renderReports() {
        if (!els.reportsContainer || !currentSheet) return;

        const rows = currentSheet.getRows(); // relatório reflete a base completa, não os filtros do Dashboard
        const moneyCol = currentSheet.resolveColumn("money");
        const serviceCostCol = currentSheet.resolveColumn("serviceCost");
        const partsCostCol = currentSheet.resolveColumn("partsCost");
        const dateCol = currentSheet.resolveColumn("date");
        const entityCol = currentSheet.resolveColumn("entityName");
        const maintenanceCol = currentSheet.resolveColumn("maintenanceType");
        const statusCol = currentSheet.resolveColumn("status");
        const serviceOrderCol = currentSheet.resolveColumn("serviceOrder");

        els.reportsContainer.innerHTML = "";

        let reportCount = 0;

        // 1) Resumo Mensal
        if (dateCol && moneyCol) {
            const monthly = groupByMonth(rows, dateCol, moneyCol);
            const monthlyService = serviceCostCol ? new Map(groupByMonth(rows, dateCol, serviceCostCol).map(r => [r.label, r.value])) : null;
            const monthlyParts = partsCostCol ? new Map(groupByMonth(rows, dateCol, partsCostCol).map(r => [r.label, r.value])) : null;

            const headers = ["Mês", "Faturamento"];
            if (monthlyService) headers.push("Custo Serviço");
            if (monthlyParts) headers.push("Custo Peças");

            const tableRows = monthly.map(m => {
                const r = [formatMonthLabel(m.label), Utils.formatMoney(m.value)];
                if (monthlyService) r.push(Utils.formatMoney(monthlyService.get(m.label) || 0));
                if (monthlyParts) r.push(Utils.formatMoney(monthlyParts.get(m.label) || 0));
                return r;
            });

            const csvRows = monthly.map(m => {
                const r = [formatMonthLabel(m.label), m.value.toFixed(2)];
                if (monthlyService) r.push((monthlyService.get(m.label) || 0).toFixed(2));
                if (monthlyParts) r.push((monthlyParts.get(m.label) || 0).toFixed(2));
                return r;
            });

            addReportCard("Resumo Mensal de Faturamento", headers, tableRows, csvRows, "resumo_mensal");
            reportCount++;
        }

        // 2) Resumo por Cliente/Frota
        if (entityCol && moneyCol) {
            const grouped = groupSum(rows, entityCol, moneyCol);
            const osCountMap = serviceOrderCol ? countByKey(rows, entityCol, serviceOrderCol) : null;

            const headers = [prettify(entityCol), "Faturamento Total"];
            if (osCountMap) headers.push("Qtd. O.S", "Ticket Médio");

            const tableRows = grouped.map(g => {
                const r = [String(g.key), Utils.formatMoney(g.value)];
                if (osCountMap) {
                    const count = osCountMap.get(g.key) || 0;
                    r.push(Utils.formatNumber(count), Utils.formatMoney(count ? g.value / count : 0));
                }
                return r;
            });

            const csvRows = grouped.map(g => {
                const r = [String(g.key), g.value.toFixed(2)];
                if (osCountMap) {
                    const count = osCountMap.get(g.key) || 0;
                    r.push(String(count), (count ? g.value / count : 0).toFixed(2));
                }
                return r;
            });

            addReportCard(`Resumo por ${prettify(entityCol)}`, headers, tableRows, csvRows, "resumo_clientes");
            reportCount++;
        }

        // 3) Resumo por Tipo de Manutenção
        if (maintenanceCol && moneyCol) {
            const grouped = groupSum(rows, maintenanceCol, moneyCol);
            const total = grouped.reduce((acc, g) => acc + g.value, 0);

            const headers = ["Tipo de Manutenção", "Faturamento", "% do Total", "Qtd. Registros"];
            const countMap = countSimple(rows, maintenanceCol);

            const tableRows = grouped.map(g => [
                String(g.key),
                Utils.formatMoney(g.value),
                `${Utils.formatNumber(total ? (g.value / total) * 100 : 0, 1)}%`,
                Utils.formatNumber(countMap.get(g.key) || 0)
            ]);

            const csvRows = grouped.map(g => [
                String(g.key),
                g.value.toFixed(2),
                (total ? (g.value / total) * 100 : 0).toFixed(1),
                String(countMap.get(g.key) || 0)
            ]);

            addReportCard("Resumo por Tipo de Manutenção", headers, tableRows, csvRows, "resumo_tipo_manutencao");
            reportCount++;
        }

        // 4) Resumo por Status
        if (statusCol) {
            const countMap = countSimple(rows, statusCol);
            const moneyByStatus = moneyCol ? groupSum(rows, statusCol, moneyCol) : null;
            const moneyMap = moneyByStatus ? new Map(moneyByStatus.map(g => [g.key, g.value])) : null;

            const headers = ["Status", "Qtd. Registros"];
            if (moneyMap) headers.push("Faturamento");

            const keys = [...countMap.keys()];
            const tableRows = keys.map(k => {
                const r = [String(k), Utils.formatNumber(countMap.get(k) || 0)];
                if (moneyMap) r.push(Utils.formatMoney(moneyMap.get(k) || 0));
                return r;
            });

            const csvRows = keys.map(k => {
                const r = [String(k), String(countMap.get(k) || 0)];
                if (moneyMap) r.push((moneyMap.get(k) || 0).toFixed(2));
                return r;
            });

            addReportCard("Resumo por Status", headers, tableRows, csvRows, "resumo_status");
            reportCount++;
        }

        if (!reportCount) {
            els.reportsContainer.innerHTML =
                '<div class="empty-card" style="margin:0 auto;">' +
                '<h2>Sem dados suficientes</h2>' +
                '<p>Não encontramos colunas de valor, data ou cliente nesta aba para gerar relatórios automáticos.</p>' +
                '</div>';
        }
    }

    function addReportCard(title, headers, tableRows, csvRows, filenamePrefix) {
        const card = document.createElement("section");
        card.className = "table-section";

        const thead = `<thead><tr>${headers.map(h => `<th>${escapeHtml(h)}</th>`).join("")}</tr></thead>`;
        const tbody = `<tbody>${tableRows.map(r => `<tr>${r.map(c => `<td>${escapeHtml(String(c))}</td>`).join("")}</tr>`).join("")}</tbody>`;

        card.innerHTML = `
            <div class="table-header">
                <h3>${escapeHtml(title)}</h3>
                <button class="btn-secondary btn-export">Exportar CSV</button>
            </div>
            <div class="table-scroll">
                <table>${thead}${tbody}</table>
            </div>
        `;

        card.querySelector(".btn-export").addEventListener("click", () => {
            exportCSV(`${filenamePrefix}.csv`, headers, csvRows);
        });

        els.reportsContainer.appendChild(card);
    }

    function countByKey(rows, groupCol, countCol) {
        const map = new Map();
        rows.forEach(r => {
            const k = r[groupCol] ?? "(vazio)";
            if (r[countCol] === null || r[countCol] === undefined || r[countCol] === "") return;
            map.set(k, (map.get(k) || 0) + 1);
        });
        return map;
    }

    function countSimple(rows, col) {
        const map = new Map();
        rows.forEach(r => {
            const k = r[col] ?? "(vazio)";
            map.set(k, (map.get(k) || 0) + 1);
        });
        return map;
    }

    function formatMonthLabel(label) {
        // label vem como "2026-01" -> "Jan/2026"
        const [year, month] = label.split("-");
        const meses = ["Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"];
        const idx = parseInt(month, 10) - 1;
        return meses[idx] ? `${meses[idx]}/${year}` : label;
    }

    /**
     * Gera e baixa um arquivo CSV a partir de cabeçalhos e linhas.
     * Usa BOM UTF-8 para o Excel abrir acentos corretamente.
     */
    function exportCSV(filename, headers, rows) {
        const escapeCSV = v => {
            const s = String(v ?? "");
            return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
        };

        const lines = [
            headers.map(escapeCSV).join(";"),
            ...rows.map(r => r.map(escapeCSV).join(";"))
        ];

        const csvContent = "\uFEFF" + lines.join("\r\n");
        const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
        const url = URL.createObjectURL(blob);

        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
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