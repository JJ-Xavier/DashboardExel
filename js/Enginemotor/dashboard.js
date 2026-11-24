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
        columnPickerPanel: document.getElementById("columnPickerPanel"),
        manageSheetsBtn: document.getElementById("manageSheetsBtn"),
        sheetManagerPanel: document.getElementById("sheetManagerPanel")
    };

    let db = null;
    let currentSheet = null;
    let currentView = "dashboard";
    let roleLabels = {};        // rótulo legível de cada filtro da aba atual
    let visibleColumns = null;  // colunas escolhidas manualmente para a aba atual (null = usar padrão)
    let hiddenSheets = [];      // nomes de abas ocultadas manualmente pelo usuário

    async function boot() {
        wireCacheControls();
        wireColumnPicker();
        wireSheetManager();
        wireKpiBreakdown();

        db = await Database.loadFromStorage();

        if (!db || !db.getSheets().length) {
            els.emptyState && (els.emptyState.style.display = "flex");
            app.style.display = "none";
            return;
        }

        hiddenSheets = loadHiddenSheets();
        populateSheetSelector();
        loadSheet(pickDefaultSheet());

        els.sheetSelect && els.sheetSelect.addEventListener("change", e => {
            resetFiltersForSheetChange();
            loadSheet(e.target.value);
        });

        // Filters.onChange (abaixo) já renderiza; chamar render() aqui
        // também fazia cada busca filtrar e redesenhar tudo duas vezes.
        els.searchInput && els.searchInput.addEventListener(
            "input",
            Utils.debounce(e => Filters.setSearch(e.target.value), 250)
        );

        // clearAll avisa o onChange, que renderiza e sincroniza os controles
        // (checkboxes, datas, faixas, chips) — não precisa reconstruí-los.
        els.clearFiltersBtn && els.clearFiltersBtn.addEventListener("click", () => {
            if (els.searchInput) els.searchInput.value = "";
            Filters.clearAll();
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
        const visible = visibleSheetNames();
        els.sheetSelect.innerHTML = visible
            .map(name => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`)
            .join("");
        // Mantém a aba aberta selecionada se ela continua visível. Antes
        // voltava sempre para a aba padrão: ocultar OUTRA aba no gerenciador
        // fazia o seletor mostrar um nome enquanto a tela exibia outra aba.
        const keepCurrent = currentSheet && visible.includes(currentSheet.name);
        els.sheetSelect.value = keepCurrent ? currentSheet.name : pickDefaultSheet();
    }

    /** Filtros valem por aba: ao trocar, zera o estado (sem renderizar a
     *  aba antiga) e limpa também o texto da busca — antes o campo
     *  continuava preenchido com a busca já desativada. */
    function resetFiltersForSheetChange() {
        Filters.clearAll({ silent: true });
        if (els.searchInput) els.searchInput.value = "";
    }

    /** Nomes de abas que devem aparecer no seletor (todas, menos as ocultadas manualmente). */
    function visibleSheetNames() {
        const all = db.getSheets();
        const visible = all.filter(n => !hiddenSheets.includes(n));
        return visible.length ? visible : all; // segurança: nunca esconde todas de uma vez
    }

    /**
     * Evita abrir por padrão uma aba "legada"/histórica (comum em bases
     * financeiras que mantêm uma planilha antiga junto da atual). Prefere
     * a primeira aba cujo nome não sinalize isso; se todas sinalizarem,
     * cai de volta para a primeira aba mesmo assim. Nunca escolhe uma
     * aba que o usuário ocultou manualmente.
     */
    function pickDefaultSheet() {
        const names = visibleSheetNames();
        const legacyPattern = /antiga?|legad|legacy|hist[oó]ric/i;
        const preferred = names.find(n => !legacyPattern.test(n));
        return preferred || names[0];
    }

    /*==================== ABAS VISÍVEIS/OCULTAS (config manual) ====================*/

    const HIDDEN_SHEETS_KEY = "kapo_hidden_sheets";

    /**
     * Nem toda base tem uso para todas as abas o tempo todo (ex.: uma
     * "BASE GERAL ANTIGA" mantida só de histórico). Em vez de forçar a
     * pessoa a rolar por abas que não vai olhar, ela pode ocultar/
     * reexibir cada aba manualmente — a escolha fica salva no
     * localStorage e sobrevive a reimportações.
     */
    function loadHiddenSheets() {
        try {
            return JSON.parse(localStorage.getItem(HIDDEN_SHEETS_KEY)) || [];
        } catch (e) {
            return [];
        }
    }

    function saveHiddenSheets(names) {
        localStorage.setItem(HIDDEN_SHEETS_KEY, JSON.stringify(names));
    }

    function wireSheetManager() {
        if (!els.manageSheetsBtn || !els.sheetManagerPanel) return;

        els.manageSheetsBtn.addEventListener("click", e => {
            e.stopPropagation();
            const isOpen = !els.sheetManagerPanel.hidden;
            if (isOpen) {
                els.sheetManagerPanel.hidden = true;
                return;
            }
            renderSheetManagerPanel();
            els.sheetManagerPanel.hidden = false;
        });

        document.addEventListener("click", e => {
            if (els.sheetManagerPanel && !els.sheetManagerPanel.hidden &&
                !els.sheetManagerPanel.contains(e.target) && e.target !== els.manageSheetsBtn) {
                els.sheetManagerPanel.hidden = true;
            }
        });
    }

    function renderSheetManagerPanel() {
        if (!db) return;
        const all = db.getSheets();

        els.sheetManagerPanel.innerHTML = `
            <div class="sheet-manager-title">Abas visíveis</div>
            <div class="sheet-manager-list">
                ${all.map(name => `
                    <label class="sheet-manager-option">
                        <input type="checkbox" value="${escapeHtml(name)}" ${hiddenSheets.includes(name) ? "" : "checked"}>
                        <span>${escapeHtml(name)}</span>
                    </label>
                `).join("")}
            </div>
        `;

        els.sheetManagerPanel.querySelectorAll('input[type="checkbox"]').forEach(cb => {
            cb.addEventListener("change", () => {
                const name = cb.value;
                if (cb.checked) {
                    hiddenSheets = hiddenSheets.filter(n => n !== name);
                } else if (!hiddenSheets.includes(name)) {
                    hiddenSheets = [...hiddenSheets, name];
                }
                saveHiddenSheets(hiddenSheets);

                const wasShowingHiddenSheet = currentSheet && !visibleSheetNames().includes(currentSheet.name);
                populateSheetSelector();
                if (wasShowingHiddenSheet) {
                    resetFiltersForSheetChange();
                    loadSheet(els.sheetSelect.value);
                }
            });
        });
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

        // Filtros de faixa numérica (ex.: abas de resumo diário) não vão
        // soltos na linha de filtros — em abas com muitas colunas
        // agregadas isso vira uma parede de campos. Em vez disso, todos
        // eles ficam agrupados atrás de um único botão "Filtros
        // avançados", que abre um painel com todos juntos.
        const numberRangeControls = controls.filter(c => c.type === "numberRange");

        controls.filter(c => c.type !== "numberRange").forEach(ctrl => {
            const wrap = document.createElement("div");
            wrap.className = "filter-control";

            if (ctrl.type === "select") {
                wrap.classList.add("multiselect");
                wrap.dataset.role = ctrl.role;
                wrap.innerHTML = `
                    <label>${escapeHtml(ctrl.label)}</label>
                    <button type="button" class="ms-toggle" data-role="${escapeHtml(ctrl.role)}">
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
                    <label>${escapeHtml(ctrl.label)}</label>
                    <div class="date-range">
                        <input type="date" data-role="${escapeHtml(ctrl.role)}" data-edge="start">
                        <span>até</span>
                        <input type="date" data-role="${escapeHtml(ctrl.role)}" data-edge="end">
                    </div>
                `;
                const [startInput, endInput] = wrap.querySelectorAll("input");
                const applyRange = () => {
                    if (!startInput.value && !endInput.value) {
                        Filters.removeCondition(ctrl.role);
                        return;
                    }

                    let start = startInput.value ? parseInputDate(startInput.value) : null;
                    let end = endInput.value ? parseInputDate(endInput.value) : null;

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

        if (numberRangeControls.length) {
            renderAdvancedFiltersButton(numberRangeControls);
        }

        syncFilterUI();
    }

    /**
     * Lê o "aaaa-mm-dd" de um <input type="date"> como data LOCAL.
     * `new Date("2025-01-31")` é meia-noite UTC — no Brasil (UTC-3) isso
     * é 30/01 às 21h, então o filtro "até 31/01" deixava o dia 31 de fora
     * e "a partir de 02/01" incluía o dia 01.
     */
    function parseInputDate(value) {
        const [y, m, d] = value.split("-").map(Number);
        return new Date(y, m - 1, d);
    }

    function closeAllMultiselects() {
        els.filtersRow.querySelectorAll(".ms-panel").forEach(p => p.hidden = true);
        els.filtersRow.querySelectorAll(".ms-toggle").forEach(b => b.classList.remove("open"));
        const advPanel = els.filtersRow.querySelector(".advanced-filters-panel");
        const advToggle = els.filtersRow.querySelector(".advanced-filters-toggle");
        if (advPanel) advPanel.hidden = true;
        if (advToggle) advToggle.classList.remove("open");
    }

    // Fecha os dropdowns de multi-seleção ao clicar fora deles
    document.addEventListener("click", e => {
        if (els.filtersRow && !els.filtersRow.contains(e.target)) closeAllMultiselects();
    });

    /**
     * Agrupa filtros de faixa numérica (potencialmente muitos, em abas de
     * resumo agregado) atrás de um único botão "Filtros avançados", em
     * vez de espalhar um campo min/max para cada coluna na linha de
     * filtros. Evita que a área de filtros vire uma parede de campos.
     */
    function renderAdvancedFiltersButton(numberRangeControls) {
        const wrap = document.createElement("div");
        wrap.className = "filter-control advanced-filters";

        const fmtHint = n => Number.isInteger(n) ? n : Number(n.toFixed(2));

        // Passo do stepper proporcional à faixa de cada coluna: percentuais
        // (max <= 5) andam de 0.1 em 0.1, contagens pequenas de 1 em 1,
        // valores grandes (dinheiro) de 10 ou 100 em 100 — evita ter que
        // clicar dezenas de vezes para sair do canto da faixa.
        const stepFor = ctrl => {
            if (ctrl.max <= 5) return 0.1;
            if (ctrl.max <= 50) return 1;
            if (ctrl.max <= 500) return 10;
            return 100;
        };

        const stepperHtml = (edge, placeholder) => `
            <div class="num-stepper">
                <input type="number" step="any" data-edge="${edge}" placeholder="${placeholder}">
                <div class="num-stepper-btns">
                    <button type="button" class="num-step-up" tabindex="-1" aria-label="Aumentar">
                        <svg viewBox="0 0 24 24" width="9" height="9" fill="none" stroke="currentColor" stroke-width="3"><path d="M18 15l-6-6-6 6"/></svg>
                    </button>
                    <button type="button" class="num-step-down" tabindex="-1" aria-label="Diminuir">
                        <svg viewBox="0 0 24 24" width="9" height="9" fill="none" stroke="currentColor" stroke-width="3"><path d="M6 9l6 6 6-6"/></svg>
                    </button>
                </div>
            </div>
        `;

        wrap.innerHTML = `
            <label>&nbsp;</label>
            <button type="button" class="advanced-filters-toggle">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 6h16M7 12h10M10 18h4"/></svg>
                <span>Filtros avançados</span>
                <span class="advanced-filters-badge" style="display:none;">0</span>
            </button>
            <div class="advanced-filters-panel" hidden>
                <div class="ms-panel-actions">
                    <button type="button" class="advanced-filters-clear">Limpar filtros avançados</button>
                </div>
                <div class="advanced-filters-grid">
                    ${numberRangeControls.map(ctrl => `
                        <div class="number-filter" data-role="${escapeHtml(ctrl.role)}">
                            <label>${escapeHtml(ctrl.label)}</label>
                            <div class="number-range">
                                ${stepperHtml("min", fmtHint(ctrl.min))}
                                <span>até</span>
                                ${stepperHtml("max", fmtHint(ctrl.max))}
                            </div>
                        </div>
                    `).join("")}
                </div>
            </div>
        `;

        const toggleBtn = wrap.querySelector(".advanced-filters-toggle");
        const panel = wrap.querySelector(".advanced-filters-panel");

        toggleBtn.addEventListener("click", e => {
            e.stopPropagation();
            const isOpen = !panel.hidden;
            closeAllMultiselects();
            panel.hidden = isOpen;
            toggleBtn.classList.toggle("open", !panel.hidden);
        });

        numberRangeControls.forEach(ctrl => {
            const row = panel.querySelector(`.number-filter[data-role="${cssEscape(ctrl.role)}"]`);
            const [minInput, maxInput] = row.querySelectorAll("input");
            const step = stepFor(ctrl);

            const applyRange = () => {
                if (minInput.value === "" && maxInput.value === "") {
                    Filters.removeCondition(ctrl.role);
                    return;
                }
                let min = minInput.value !== "" ? Number(minInput.value) : -Infinity;
                let max = maxInput.value !== "" ? Number(maxInput.value) : Infinity;
                if (min > max) [min, max] = [max, min];
                Filters.setNumberRangeCondition(ctrl.role, min, max);
            };
            minInput.addEventListener("change", applyRange);
            maxInput.addEventListener("change", applyRange);

            row.querySelectorAll(".num-stepper").forEach(stepperWrap => {
                const input = stepperWrap.querySelector("input");
                const fallback = input.dataset.edge === "min" ? ctrl.min : ctrl.max;
                const bump = delta => {
                    const current = input.value !== "" ? Number(input.value) : fallback;
                    const next = Math.round((current + delta) * 1000) / 1000; // evita erro de ponto flutuante
                    input.value = next;
                    input.dispatchEvent(new Event("change", { bubbles: true }));
                };
                stepperWrap.querySelector(".num-step-up").addEventListener("click", () => bump(step));
                stepperWrap.querySelector(".num-step-down").addEventListener("click", () => bump(-step));
            });
        });

        wrap.querySelector(".advanced-filters-clear").addEventListener("click", () => {
            numberRangeControls.forEach(ctrl => Filters.removeCondition(ctrl.role));
        });

        els.filtersRow.appendChild(wrap);
    }

    /** Escapa um valor para uso seguro dentro de um seletor de atributo CSS. */
    function cssEscape(value) {
        return String(value).replace(/["\\]/g, "\\$&");
    }

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

        els.filtersRow.querySelectorAll(".number-filter").forEach(wrap => {
            const role = wrap.dataset.role;
            const cond = state.conditions.find(c => c.role === role && c.op === "between");
            const [minInput, maxInput] = wrap.querySelectorAll("input");
            if (!cond) {
                if (minInput) minInput.value = "";
                if (maxInput) maxInput.value = "";
            }
        });

        const advBadge = els.filtersRow.querySelector(".advanced-filters-badge");
        if (advBadge) {
            const activeNumberRanges = state.conditions.filter(c =>
                c.op === "between" &&
                els.filtersRow.querySelector(`.number-filter[data-role="${cssEscape(c.role)}"]`)
            ).length;
            advBadge.style.display = activeNumberRanges > 0 ? "inline-block" : "none";
            advBadge.textContent = activeNumberRanges;
        }

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
            } else if (cond.op === "dateBetween") {
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
            } else if (cond.op === "between") {
                const [min, max] = cond.value;
                const fmt = n => isFinite(n) ? Utils.formatNumber(n, 2).replace(/\,00$/, "") : null;
                const minTxt = fmt(min);
                const maxTxt = fmt(max);
                let rangeTxt;
                if (minTxt && maxTxt) rangeTxt = `${minTxt} até ${maxTxt}`;
                else if (minTxt) rangeTxt = `≥ ${minTxt}`;
                else if (maxTxt) rangeTxt = `≤ ${maxTxt}`;
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

    // Guarda as linhas usadas no último render, pra poder recalcular o
    // breakdown de um card sem precisar re-filtrar tudo de novo ao clicar.
    let lastKpiRows = [];

    function renderKPIs(rows) {
        if (!els.kpiRow) return;

        lastKpiRows = rows;

        const moneyCol = currentSheet.resolveColumn("money");
        const serviceCostCol = currentSheet.resolveColumn("serviceCost");
        const partsCostCol = currentSheet.resolveColumn("partsCost");
        const entityCol = currentSheet.resolveColumn("entityName");
        const statusCol = currentSheet.resolveColumn("status");
        const dateCol = currentSheet.resolveColumn("date");

        // Cards agrupados por categoria; a ordem final segue a prioridade
        // dinheiro > contagem > percentuais > outros, e só entra o que a
        // aba realmente tiver (colunas ausentes simplesmente não geram card).
        const money = [];
        const counting = [];
        const percentual = [];
        const others = [];

        if (moneyCol) {
            money.push({
                label: "Faturamento Total",
                value: Utils.formatMoney(Statistics.sum(rows, moneyCol)),
                type: "positive",
                column: moneyCol // clicável: abre o detalhamento do que compõe este total
            });
            money.push({
                label: "Ticket Médio por O.S",
                value: Utils.formatMoney(Statistics.average(rows, moneyCol)),
                type: "positive"
            });
        }

        if (serviceCostCol) {
            money.push({
                label: "Custo de Serviço (Total)",
                value: Utils.formatMoney(Statistics.sum(rows, serviceCostCol)),
                type: "negative"
                // sem `column`: não é clicável — a composição só faz
                // sentido no total (Faturamento), não nos componentes.
            });
        }

        if (partsCostCol) {
            money.push({
                label: "Custo de Peças (Total)",
                value: Utils.formatMoney(Statistics.sum(rows, partsCostCol)),
                type: "negative"
            });
        }

        // "Outros Valores" — tudo que compõe o Faturamento além de Serviço
        // e Peças (mesma reconciliação linha a linha usada no gráfico
        // "Outros Lançamentos" e no modal de composição do Faturamento
        // Total), pra o valor bater igual nos três lugares.
        if (moneyCol && (serviceCostCol || partsCostCol)) {
            const otherComponentCols = [serviceCostCol, partsCostCol].filter(Boolean);
            const otherParts = decomposeByComponents(moneyCol, otherComponentCols, rows);
            const otherAdjustment = otherParts.find(p => p.kind === "adjustment");
            money.push({
                label: "Outros Valores",
                value: Utils.formatMoney(otherAdjustment ? otherAdjustment.sum : 0),
                type: "negative"
                // sem `column`: mesmo critério das outras duas — não é
                // clicável aqui; o detalhamento fica no botão "Ver
                // detalhes" do gráfico "Outros Lançamentos".
            });
        }

        // Cards de percentual — completa o que ficou pendente: o array
        // `percentual` era declarado e mesclado no resultado final, mas
        // nada nunca o preenchia. Para cada coluna de percentual da aba
        // (ex.: "% Faturado manut"), mostra a MÉDIA no período filtrado.
        // Percentuais armazenados como fração (0.65 = 65%) são detectados
        // pelo máximo da coluna e escalados para exibição; colunas já em
        // escala 0-100 são exibidas como estão.
        const percentageCols = currentSheet.resolveColumns("percentage");
        for (const pcol of percentageCols.slice(0, 2)) { // no máx. 2 cards, pra não inflar a linha
            let sum = 0, count = 0;
            for (const r of rows) {
                const v = Utils.parseNumberSmart(r[pcol]);
                if (v === null || isNaN(v)) continue;
                sum += v;
                count++;
            }
            if (!count) continue;

            const avg = sum / count;
            const displayValue = isFractionPercent(pcol) ? avg * 100 : avg; // fração -> %

            percentual.push({
                label: `${prettify(pcol)} (Média)`,
                value: `${Utils.formatNumber(displayValue, 1)}%`,
                type: "neutral"
            });
        }

        counting.push({
            label: "Total de Registros",
            value: Utils.formatNumber(rows.length),
            type: "neutral"
        });

        if (entityCol) {
            counting.push({
                label: prettify(entityCol) + "s Únicos",
                value: Utils.formatNumber(Statistics.uniqueValues(rows, entityCol).length),
                type: "neutral"
            });
        }

        if (statusCol) {
            const dist = Statistics.distribution(rows, statusCol, 1);
            if (dist.length) {
                others.push({ label: `Status mais comum`, value: String(dist[0].label), type: "neutral" });
            }
        }

        if (dateCol) {
            // Varredura em vez de Math.max(...datas): o spread estoura a
            // pilha ("Maximum call stack size exceeded") a partir de ~120 mil
            // linhas e derrubava a renderização inteira dos KPIs.
            let latest = null;
            for (const r of rows) {
                const d = Utils.parseDateSmart(r[dateCol]);
                if (d && (!latest || d > latest)) latest = d;
            }
            if (latest) {
                others.push({ label: "Registro mais recente", value: Utils.formatDate(latest), type: "neutral" });
            }
        }

        const cards = [...money, ...counting, ...percentual, ...others];

        els.kpiRow.innerHTML = cards.map(c => {
            const clickable = !!c.column;
            return `
            <div class="kpi-card kpi-${c.type}${clickable ? " kpi-clickable" : ""}"
                 ${clickable ? `data-kpi-column="${escapeHtml(c.column)}" data-kpi-label="${escapeHtml(c.label)}" tabindex="0" role="button"` : ""}>
                <span class="kpi-label">${escapeHtml(c.label)}${clickable ? '<span class="kpi-expand-hint">Ver composição ›</span>' : ""}</span>
                <span class="kpi-value">${escapeHtml(c.value)}</span>
            </div>
        `;
        }).join("");
    }

    /*==================== DETALHAMENTO DE KPI (modal) ==================
      Ao clicar num card de KPI monetário (soma), mostra:
      1) Componentes — outras colunas de valor/custo desta aba, para dar
         contexto de como o total se relaciona com elas.
      2) Agrupamento — quanto cada categoria (cliente, categoria, mês)
         contribui para aquele total, com abas pra trocar a dimensão.
    ======================================================================*/

    const MONEY_LIKE_ROLES = new Set(["money", "serviceCost", "partsCost"]);
    const BLANK_HEADER_RX = /^Coluna_\d+(_\d+)?$/i;

    // Mesmos papéis que nunca viram filtro de seleção (filters.js):
    // valores, datas, documentos, contatos e números não são "categorias".
    const NON_CATEGORY_ROLES = new Set([
        ...MONEY_LIKE_ROLES, "date", "document_cpf", "document_cnpj", "email",
        "phone", "id", "plate", "percentage", "number"
    ]);

    /** Percentual guardado como fração (0,15 = 15%)? Decide pela coluna
     *  INTEIRA (máximo ≤ 2), não pelo recorte filtrado, para o card de KPI
     *  e a tabela sempre usarem a mesma escala. */
    function isFractionPercent(col) {
        const st = currentSheet && currentSheet.statistics[col];
        return !!st && st.max !== null && st.max !== undefined && st.max <= 2;
    }

    /** "OS 1234" para números puros; valores que já trazem o prefixo
     *  ("OS-50001") ficam como estão, em vez de virar "OS OS-50001". */
    function osLabel(value) {
        const s = String(value);
        return /^os[\s\-.:]?\d/i.test(s) ? s : `OS ${s}`;
    }

    let kpiModalState = null; // { column, label, rows, groupDims, activeDim }

    function wireKpiBreakdown() {
        if (!els.kpiRow) return;
        els.kpiRow.addEventListener("click", e => {
            const card = e.target.closest(".kpi-card[data-kpi-column]");
            if (!card) return;
            openKpiBreakdown(card.dataset.kpiColumn, card.dataset.kpiLabel);
        });
        els.kpiRow.addEventListener("keydown", e => {
            if (e.key !== "Enter" && e.key !== " ") return;
            const card = e.target.closest(".kpi-card[data-kpi-column]");
            if (!card) return;
            e.preventDefault();
            openKpiBreakdown(card.dataset.kpiColumn, card.dataset.kpiLabel);
        });
        document.addEventListener("keydown", e => {
            if (e.key === "Escape" && kpiModalState) closeKpiBreakdown();
        });
    }

    function monthBucketLabel(date) {
        const meses = ["Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"];
        return `${meses[date.getMonth()]}/${date.getFullYear()}`;
    }

    /** Soma `valueCol` agrupando pelas categorias de `dimCol` (ou por mês, se isDate). */
    function groupSumBy(rows, valueCol, dimCol, isDate) {
        const groups = new Map();
        for (const row of rows) {
            let key;
            if (isDate) {
                const d = Utils.parseDateSmart(row[dimCol]);
                key = d ? monthBucketLabel(d) : "(sem data)";
            } else {
                const v = row[dimCol];
                key = (v === null || v === undefined || v === "") ? "(vazio)" : String(v);
            }
            const n = Utils.parseNumberSmart(row[valueCol]) || 0;
            groups.set(key, (groups.get(key) || 0) + n);
        }
        return [...groups.entries()]
            .map(([label, sum]) => ({ label, sum }))
            .sort((a, b) => b.sum - a.sum);
    }

    /** Mantém as top N entradas e agrupa o resto em "Outros". */
    function bucketTop(list, topN) {
        if (list.length <= topN) return list;
        const top = list.slice(0, topN);
        const rest = list.slice(topN);
        const restSum = rest.reduce((s, r) => s + r.sum, 0);
        top.push({ label: `Outros (${rest.length})`, sum: restSum });
        return top;
    }

    /** Descobre as colunas que atuam como "peças" da composição de um total
     *  monetário (ex.: Mão de Obra + Peças formam o Faturamento). Só faz
     *  sentido para o total COMPOSTO em si (o papel "money"/Faturamento) —
     *  se a coluna clicada já É um dos componentes (Custo de Serviço,
     *  Custo de Peças), não existe uma decomposição mais "de baixo" pra
     *  mostrar, então cai no modo de comparação. */
    function findComponentColumns(targetColumn) {
        const moneyCol = currentSheet.resolveColumn("money");
        if (targetColumn !== moneyCol) return [];

        const serviceCol = currentSheet.resolveColumn("serviceCost");
        const partsCol = currentSheet.resolveColumn("partsCost");
        const known = [serviceCol, partsCol].filter(c => c && c !== targetColumn);
        if (known.length) return known;

        // Esta aba não tem colunas com o papel M.O/Peças (ex.: abas de
        // "resumo" com estrutura diferente, tipo Manutenção + Sinistro).
        // Em vez de desistir e cair num modo de comparação sem relação
        // real com o total, procura entre as outras colunas monetárias da
        // aba um conjunto que realmente componha o total, linha a linha.
        return autoDetectComponentColumns(targetColumn);
    }

    /** Testa combinações de colunas monetárias da aba (pares, depois trios)
     *  contra `targetColumn`, linha a linha, e retorna a combinação mais
     *  simples cuja soma bate com o total na grande maioria das linhas.
     *  Isso generaliza a decomposição pra qualquer aba, sem precisar
     *  cadastrar manualmente cada novo padrão de colunas (tipo "Manutenção
     *  + Sinistro"). Retorna [] se nenhuma combinação bater bem o
     *  suficiente — nesse caso o card cai no modo de comparação, como
     *  antes. */
    function autoDetectComponentColumns(targetColumn) {
        const candidates = currentSheet.getColumnRoles()
            .filter(c => MONEY_LIKE_ROLES.has(c.role) && c.column !== targetColumn && !BLANK_HEADER_RX.test(c.column))
            .map(c => c.column);
        if (candidates.length < 2) return [];

        const rows = lastKpiRows;

        function matchRatio(cols) {
            let matches = 0, checked = 0;
            for (const row of rows) {
                const target = Utils.parseNumberSmart(row[targetColumn]);
                if (target === null || target === undefined) continue;
                checked++;
                const sum = cols.reduce((s, c) => s + (Utils.parseNumberSmart(row[c]) || 0), 0);
                const tolerance = Math.max(1, Math.abs(target) * 0.01); // 1% ou R$1
                if (Math.abs(sum - target) <= tolerance) matches++;
            }
            return checked ? matches / checked : 0;
        }

        function combinations(arr, size) {
            if (size === 0) return [[]];
            if (arr.length < size) return [];
            const [first, ...rest] = arr;
            const withFirst = combinations(rest, size - 1).map(c => [first, ...c]);
            return [...withFirst, ...combinations(rest, size)];
        }

        // Prefere a combinação mais simples (menos colunas) que já explique
        // bem o total; só sobe pra trios se nenhum par servir.
        for (let size = 2; size <= Math.min(3, candidates.length); size++) {
            let best = null;
            for (const combo of combinations(candidates, size)) {
                const ratio = matchRatio(combo);
                if (ratio >= 0.9 && (!best || ratio > best.ratio)) best = { combo, ratio };
            }
            if (best) return best.combo;
        }
        return [];
    }

    /**
     * Decompõe `total` linha a linha: para cada registro, verifica se a
     * soma dos componentes (ex.: M.O Total + Peças Total) bate com o
     * valor da coluna alvo (ex.: Valor a Faturar) naquela linha. Quando
     * bate, o valor de cada componente entra na sua própria soma; quando
     * não bate (ex.: valor lançado manualmente, sem seguir a composição
     * padrão), o valor da linha inteira entra num balde à parte, deixando
     * isso visível em vez de escondido dentro de uma soma que não fecha.
     *
     * Resultado: as partes retornadas sempre somam (a centavos de
     * arredondamento) o total clicado — é uma decomposição de verdade,
     * não só colunas parecidas mostradas lado a lado.
     */
    function decomposeByComponents(targetColumn, componentCols, rows) {
        const componentSums = componentCols.map(() => 0);
        const serviceOrderCol = currentSheet.resolveColumn("serviceOrder");
        const entityCol = currentSheet.resolveColumn("entityName");

        let adjustmentSum = 0;
        let adjustmentCount = 0;
        const adjustmentSamples = [];

        for (const row of rows) {
            const target = Utils.parseNumberSmart(row[targetColumn]) || 0;
            const compVals = componentCols.map(c => Utils.parseNumberSmart(row[c]) || 0);
            const compSum = compVals.reduce((a, b) => a + b, 0);
            const tolerance = Math.max(1, Math.abs(target) * 0.01); // 1% ou R$1, o que for maior

            if (Math.abs(compSum - target) <= tolerance) {
                compVals.forEach((v, i) => { componentSums[i] += v; });
            } else {
                adjustmentSum += target;
                adjustmentCount++;

                // Guarda uma identificação (O.S / cliente) de cada linha que
                // caiu nesse balde, pra dar contexto no hover — em vez de um
                // valor anônimo, dá pra ver exatamente de onde ele veio.
                const idParts = [];
                if (serviceOrderCol && row[serviceOrderCol] != null && row[serviceOrderCol] !== "") {
                    idParts.push(osLabel(row[serviceOrderCol]));
                }
                if (entityCol && row[entityCol]) idParts.push(String(row[entityCol]));
                const idLabel = idParts.length ? idParts.join(" — ") : `Registro sem identificação`;
                adjustmentSamples.push({ label: idLabel, value: target });
            }
        }

        const parts = componentCols.map((c, i) => ({
            label: prettify(c),
            sum: componentSums[i],
            kind: "component"
        }));

        if (adjustmentCount > 0) {
            adjustmentSamples.sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
            parts.push({
                label: `Outros Lançamentos (${adjustmentCount} registro${adjustmentCount > 1 ? "s" : ""})`,
                sum: adjustmentSum,
                kind: "adjustment",
                samples: adjustmentSamples.slice(0, 12)
            });
        }

        return parts;
    }

    /** Descobre quais dimensões fazem sentido pra agrupar nesta aba (cliente/categoria/mês). */
    function findGroupingDimensions() {
        const dims = [];

        const entityCol = currentSheet.resolveColumn("entityName");
        if (entityCol) dims.push({ key: "entity", label: prettify(entityCol), column: entityCol, isDate: false });

        const statusCol = currentSheet.resolveColumn("status");
        if (statusCol) dims.push({ key: "status", label: prettify(statusCol), column: statusCol, isDate: false });

        // Qualquer outra coluna categórica de baixa cardinalidade (mesmo
        // critério usado pelos filtros automáticos), como uma segunda opção
        // de categoria além de status — útil quando a aba não tem "status"
        // mas tem, por exemplo, "TIPO DE MANUTENÇÃO".
        if (!statusCol) {
            for (const colInfo of currentSheet.getColumnRoles()) {
                const col = colInfo.column;
                // Antes só excluía colunas de valor: contagens pequenas
                // (ex.: "QDT SINISTRO", 0 a 5) viravam "categoria" de agrupamento.
                if (NON_CATEGORY_ROLES.has(colInfo.role)) continue;
                if (BLANK_HEADER_RX.test(col)) continue;
                if (dims.some(d => d.column === col)) continue;
                const uniq = currentSheet.unique(col);
                if (uniq.length >= 2 && uniq.length <= 30) {
                    dims.push({ key: "category", label: prettify(col), column: col, isDate: false });
                    break;
                }
            }
        }

        const dateCol = currentSheet.resolveColumn("date");
        if (dateCol) dims.push({ key: "month", label: "Mês", column: dateCol, isDate: true });

        return dims;
    }

    function openKpiBreakdown(column, label) {
        const dims = findGroupingDimensions();
        kpiModalState = {
            column,
            label,
            rows: lastKpiRows,
            groupDims: dims,
            activeDim: dims.length ? 0 : -1
        };
        renderKpiModal();
    }

    function closeKpiBreakdown() {
        kpiModalState = null;
        const el = document.getElementById("kpiModalOverlay");
        if (el) el.remove();
    }

    function renderKpiModal() {
        if (!kpiModalState) return;
        const { column, label, rows } = kpiModalState;

        const total = Statistics.sum(rows, column);

        // --- Seção 1: composição real (linha a linha) quando existem
        // colunas de componente conhecidas (M.O/Peças); senão, cai pra
        // uma comparação simples com outras colunas de valor da aba.
        const componentCols = findComponentColumns(column);

        let relatedRows, relatedNote;
        if (componentCols.length) {
            const parts = decomposeByComponents(column, componentCols, rows);
            relatedRows = [{ label, sum: total, isTotal: true }, ...parts.map(p => ({
                label: p.label, sum: p.sum, isAdjustment: p.kind === "adjustment", samples: p.samples
            }))];
            relatedNote = `<p class="kpi-breakdown-hint">As partes abaixo somam (a centavos de arredondamento) o total — é a decomposição real, linha a linha, não uma comparação solta.</p>`;
        } else {
            const relatedCols = currentSheet.getColumnRoles()
                .filter(c => MONEY_LIKE_ROLES.has(c.role) && c.column !== column && !BLANK_HEADER_RX.test(c.column));

            relatedRows = [{ label, sum: total, isTotal: true }];
            for (const c of relatedCols) {
                const s = Statistics.sum(rows, c.column);
                const hasData = rows.some(r => r[c.column] !== null && r[c.column] !== undefined);
                if (hasData) relatedRows.push({ label: prettify(c.column), sum: s });
            }
            relatedNote = relatedRows.length > 1
                ? `<p class="kpi-breakdown-hint">Esta aba não tem colunas de componente conhecidas para este total, então isto é uma comparação com outras colunas de valor (não somam necessariamente ao total).</p>`
                : `<p class="kpi-breakdown-hint">Não há outras colunas de valor nesta aba para comparar.</p>`;
        }

        const maxRelated = Math.max(1, ...relatedRows.map(r => Math.abs(r.sum)));

        /**
         * Monta uma linha do breakdown com um tooltip customizado no
         * mesmo estilo escuro usado nos tooltips do Chart.js — em vez do
         * tooltip nativo do navegador (que corta texto e não dá pra
         * estilizar). Mostra sempre o nome completo (útil quando o rótulo
         * é cortado com "…" na tela) e, se houver amostras (linhas que
         * caíram em "Outros Lançamentos"), lista os maiores valores.
         */
        function buildBreakdownRow(r, maxScale, extraBarClass) {
            const pct = Math.min(100, Math.abs(r.sum) / maxScale * 100);

            // "Outros Lançamentos" fica sem tooltip — só a barra e o valor.
            if (r.isAdjustment) {
                return `
            <div class="kpi-breakdown-row">
                <span class="kpi-breakdown-label">${escapeHtml(r.label)}</span>
                <div class="kpi-breakdown-bar-track">
                    <div class="kpi-breakdown-bar ${extraBarClass || ""}" style="width:${pct}%"></div>
                </div>
                <span class="kpi-breakdown-value">${Utils.formatMoney(r.sum)}</span>
            </div>
        `;
            }

            const sampleLines = (r.samples || [])
                .map(s => `<div class="kpi-tooltip-line"><span>${escapeHtml(s.label)}</span><span>${Utils.formatMoney(s.value)}</span></div>`)
                .join("");

            return `
            <div class="kpi-breakdown-row kpi-tooltip-wrap">
                <span class="kpi-breakdown-label">${escapeHtml(r.label)}</span>
                <div class="kpi-breakdown-bar-track">
                    <div class="kpi-breakdown-bar ${extraBarClass || ""}" style="width:${pct}%"></div>
                </div>
                <span class="kpi-breakdown-value">${Utils.formatMoney(r.sum)}</span>
                <div class="kpi-tooltip-box">
                    <div class="kpi-tooltip-title">${escapeHtml(r.label)}</div>
                    <div class="kpi-tooltip-line"><span>Valor</span><span>${Utils.formatMoney(r.sum)}</span></div>
                    ${sampleLines ? `<div class="kpi-tooltip-divider"></div>${sampleLines}` : ""}
                </div>
            </div>
        `;
        }

        const relatedHtml = relatedRows.map(r => buildBreakdownRow(
            r, maxRelated, `${r.isTotal ? "kpi-breakdown-bar-total" : ""} ${r.isAdjustment ? "kpi-breakdown-bar-adjustment" : ""}`
        )).join("");

        // --- Seção 2: agrupamento por categoria ---
        const { groupDims, activeDim } = kpiModalState;
        const tabsHtml = groupDims.map((d, i) => `
            <button type="button" class="kpi-modal-tab ${i === activeDim ? "active" : ""}" data-dim-index="${i}">
                ${escapeHtml(d.label)}
            </button>
        `).join("");

        let groupHtml = `<p class="kpi-breakdown-hint">Esta aba não tem uma coluna categórica para agrupar.</p>`;
        if (activeDim >= 0) {
            const dim = groupDims[activeDim];
            const grouped = bucketTop(groupSumBy(rows, column, dim.column, dim.isDate), 8);
            const maxGroup = Math.max(1, ...grouped.map(g => Math.abs(g.sum)));
            groupHtml = grouped.map(g => buildBreakdownRow(g, maxGroup)).join("");
        }

        let overlay = document.getElementById("kpiModalOverlay");
        if (!overlay) {
            overlay = document.createElement("div");
            overlay.id = "kpiModalOverlay";
            overlay.className = "kpi-modal-overlay";
            document.body.appendChild(overlay);
            overlay.addEventListener("click", e => {
                if (e.target === overlay) closeKpiBreakdown();
            });
        }

        overlay.innerHTML = `
            <div class="kpi-modal" role="dialog" aria-modal="true" aria-label="Composição de ${escapeHtml(label)}">
                <div class="kpi-modal-header">
                    <div>
                        <h3>${escapeHtml(label)}</h3>
                        <span class="kpi-modal-total">${Utils.formatMoney(total)}</span>
                    </div>
                    <button type="button" class="kpi-modal-close" aria-label="Fechar">&times;</button>
                </div>

                <div class="kpi-modal-section">
                    <h4>Composição</h4>
                    ${relatedHtml}
                    ${relatedNote}
                </div>

                <div class="kpi-modal-section">
                    <h4>Agrupamento</h4>
                    ${groupDims.length ? `<div class="kpi-modal-tabs">${tabsHtml}</div>` : ""}
                    ${groupHtml}
                </div>
            </div>
        `;

        overlay.querySelector(".kpi-modal-close").addEventListener("click", closeKpiBreakdown);
        overlay.querySelectorAll(".kpi-modal-tab").forEach(btn => {
            btn.addEventListener("click", () => {
                kpiModalState.activeDim = Number(btn.dataset.dimIndex);
                renderKpiModal();
            });
        });
    }

    /*==================== GRÁFICOS AUTOMÁTICOS ====================*/

    function renderCharts(rows) {
        if (!els.chartsGrid) return;

        // limpa (destrói antes de remover os canvases — ver Charts.destroyAll)
        Charts.destroyAll();
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
                    labels: trend.map(t => formatMonthLabel(t.label)),
                    values: trend.map(t => t.value)
                })
            );
            chartCount++;
        }

        // 1b) OUTROS LANÇAMENTOS — usa a MESMA lógica de reconciliação do
        // modal de composição do KPI "Faturamento Total" (decomposeByComponents):
        // para cada linha, se Serviço + Peças não bater com o Faturamento
        // daquela linha (tolerância de 1% ou R$1), o valor inteiro da linha
        // cai no balde "Outros Lançamentos" (taxa/markup aplicada fora do
        // padrão, franquias, ajustes manuais etc.). Mantém o número deste
        // gráfico sempre igual ao que aparece ao clicar no KPI.
        if (moneyCol && dateCol && (serviceCostCol || partsCostCol)) {
            const componentCols = [serviceCostCol, partsCostCol].filter(Boolean);
            addChartCanvas("chartOtherEntries", "Outros Lançamentos (Evolução Mensal)", { wide: true, detailsButtonLabel: "Ver detalhes" });
            const trendOthers = groupByMonthAdjustments(rows, dateCol, moneyCol, componentCols);
            requestAnimationFrame(() =>
                Charts.bar("chartOtherEntries", {
                    label: "Outros Lançamentos",
                    labels: trendOthers.map(t => formatMonthLabel(t.label)),
                    values: trendOthers.map(t => t.value)
                })
            );
            chartCount++;

            const otherEntriesBtn = document.getElementById("chartOtherEntriesDetailsBtn");
            if (otherEntriesBtn) {
                otherEntriesBtn.addEventListener("click", () => openOtherEntriesModal(rows, dateCol, moneyCol, componentCols));
            }
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
                        labels: allLabels.map(formatMonthLabel),
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

        // O título pode conter nome de coluna da planilha ("Top 10 ...").
        const headerHtml = opts.detailsButtonLabel
            ? `<div class="chart-card-header"><h3>${escapeHtml(title)}</h3><button type="button" class="chart-card-details-btn" id="${id}DetailsBtn">${escapeHtml(opts.detailsButtonLabel)}</button></div>`
            : `<h3>${escapeHtml(title)}</h3>`;

        card.innerHTML = `${headerHtml}<div class="chart-wrap"><canvas id="${id}"></canvas></div>`;
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

    /**
     * Igual a groupByMonth, mas em vez de somar uma coluna fixa, aplica
     * por LINHA a mesma reconciliação usada em decomposeByComponents:
     * soma os componentes (ex.: M.O Total + Peças Total) e compara com o
     * valor alvo (ex.: Valor a Faturar) daquela linha. Quando a diferença
     * ultrapassa a tolerância (1% ou R$1, o que for maior), o valor
     * INTEIRO da linha (não só a diferença) entra no mês correspondente —
     * exatamente o critério de "Outros Lançamentos" do modal de KPI.
     */
    function groupByMonthAdjustments(rows, dateCol, targetCol, componentCols) {
        const map = new Map();
        rows.forEach(r => {
            const d = Utils.parseDateSmart(r[dateCol]);
            if (!d) return;

            const target = Utils.parseNumberSmart(r[targetCol]) || 0;
            const compSum = componentCols.reduce((acc, c) => acc + (Utils.parseNumberSmart(r[c]) || 0), 0);
            const tolerance = Math.max(1, Math.abs(target) * 0.01);
            if (Math.abs(compSum - target) <= tolerance) return; // bate com Serviço+Peças, não é "outro lançamento"

            const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
            map.set(key, (map.get(key) || 0) + target);
        });
        return [...map.entries()]
            .sort((a, b) => a[0].localeCompare(b[0]))
            .map(([label, value]) => ({ label, value }));
    }

    /*==================== MODAL: DETALHAMENTO DE OUTROS LANÇAMENTOS ====================
      Botão "Ver detalhes" no card do gráfico. Lista TODAS as linhas que
      caíram no critério de "Outros Lançamentos" (mesma reconciliação de
      groupByMonthAdjustments/decomposeByComponents), sem limite de
      amostras — com busca e exportação CSV.
    ======================================================================*/

    let otherEntriesModalState = null; // { allRows, search }

    /** Lista (não agregada) de todas as linhas que caem em "Outros Lançamentos". */
    function getAdjustmentRows(rows, dateCol, targetCol, componentCols) {
        const serviceOrderCol = currentSheet.resolveColumn("serviceOrder");
        const entityCol = currentSheet.resolveColumn("entityName");
        const list = [];

        rows.forEach(r => {
            const d = Utils.parseDateSmart(r[dateCol]);
            if (!d) return;

            const target = Utils.parseNumberSmart(r[targetCol]) || 0;
            const compSum = componentCols.reduce((acc, c) => acc + (Utils.parseNumberSmart(r[c]) || 0), 0);
            const tolerance = Math.max(1, Math.abs(target) * 0.01);
            if (Math.abs(compSum - target) <= tolerance) return;

            list.push({
                monthKey: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`,
                monthLabel: monthBucketLabel(d),
                os: (serviceOrderCol && r[serviceOrderCol] != null && r[serviceOrderCol] !== "") ? String(r[serviceOrderCol]) : "-",
                cliente: (entityCol && r[entityCol]) ? String(r[entityCol]) : "-",
                valor: target
            });
        });

        return list.sort((a, b) => a.monthKey.localeCompare(b.monthKey) || Math.abs(b.valor) - Math.abs(a.valor));
    }

    function openOtherEntriesModal(rows, dateCol, moneyCol, componentCols) {
        otherEntriesModalState = {
            allRows: getAdjustmentRows(rows, dateCol, moneyCol, componentCols),
            search: ""
        };
        renderOtherEntriesModal();
    }

    function closeOtherEntriesModal() {
        otherEntriesModalState = null;
        const el = document.getElementById("otherEntriesModalOverlay");
        if (el) el.remove();
    }

    function renderOtherEntriesModal() {
        if (!otherEntriesModalState) return;
        const { allRows, search } = otherEntriesModalState;

        const term = search.trim().toLowerCase();
        const filtered = term
            ? allRows.filter(r =>
                r.os.toLowerCase().includes(term) ||
                r.cliente.toLowerCase().includes(term) ||
                r.monthLabel.toLowerCase().includes(term))
            : allRows;

        const total = filtered.reduce((s, r) => s + r.valor, 0);

        const rowsHtml = filtered.length
            ? filtered.map(r => `
                <tr>
                    <td>${escapeHtml(r.monthLabel)}</td>
                    <td>${escapeHtml(r.os)}</td>
                    <td>${escapeHtml(r.cliente)}</td>
                    <td class="num">${Utils.formatMoney(r.valor)}</td>
                </tr>
            `).join("")
            : `<tr><td colspan="4" class="kpi-modal-table-empty">Nenhum lançamento encontrado.</td></tr>`;

        let overlay = document.getElementById("otherEntriesModalOverlay");
        if (!overlay) {
            overlay = document.createElement("div");
            overlay.id = "otherEntriesModalOverlay";
            overlay.className = "kpi-modal-overlay";
            document.body.appendChild(overlay);
            overlay.addEventListener("click", e => {
                if (e.target === overlay) closeOtherEntriesModal();
            });
        }

        overlay.innerHTML = `
            <div class="kpi-modal kpi-modal-wide" role="dialog" aria-modal="true" aria-label="Detalhamento de Outros Lançamentos">
                <div class="kpi-modal-header">
                    <div>
                        <h3>Outros Lançamentos — Detalhamento</h3>
                        <span class="kpi-modal-total">${Utils.formatMoney(total)}</span>
                    </div>
                    <button type="button" class="kpi-modal-close" aria-label="Fechar">&times;</button>
                </div>
                <div class="kpi-modal-section">
                    <input type="text" class="kpi-modal-search" id="otherEntriesSearch"
                           placeholder="Buscar por O.S, cliente ou mês..." value="${escapeHtml(search)}">
                    <div class="kpi-modal-table-scroll">
                        <table>
                            <thead><tr><th>Mês</th><th>O.S</th><th>Cliente</th><th>Valor</th></tr></thead>
                            <tbody>${rowsHtml}</tbody>
                        </table>
                    </div>
                    <p class="kpi-breakdown-hint">
                        ${filtered.length} de ${allRows.length} registro${allRows.length !== 1 ? "s" : ""} —
                        mesmo critério usado no gráfico e na composição do Faturamento Total.
                    </p>
                    <button type="button" class="btn-secondary" id="otherEntriesExportBtn" style="margin-top:12px;">
                        Exportar CSV
                    </button>
                </div>
            </div>
        `;

        overlay.querySelector(".kpi-modal-close").addEventListener("click", closeOtherEntriesModal);

        const searchInput = overlay.querySelector("#otherEntriesSearch");
        searchInput.addEventListener("input", () => {
            const cursorPos = searchInput.selectionStart;
            otherEntriesModalState.search = searchInput.value;
            renderOtherEntriesModal();
            const newInput = document.getElementById("otherEntriesSearch");
            if (newInput) {
                newInput.focus();
                newInput.setSelectionRange(cursorPos, cursorPos);
            }
        });

        overlay.querySelector("#otherEntriesExportBtn").addEventListener("click", () => {
            exportCSV(
                "outros_lancamentos.csv",
                ["Mês", "O.S", "Cliente", "Valor"],
                filtered.map(r => [r.monthLabel, r.os, r.cliente, csvNumber(r.valor)])
            );
        });
    }

    document.addEventListener("keydown", e => {
        if (e.key === "Escape" && otherEntriesModalState) closeOtherEntriesModal();
    });

    /*==================== TABELA AUTOMÁTICA ====================*/

    function renderTable(rows) {
        if (!els.dataTable || !currentSheet) return;

        const cols = (visibleColumns && visibleColumns.length)
            ? visibleColumns.filter(c => currentSheet.columns.includes(c))
            : currentSheet.columns.slice(0, 10); // padrão: primeiras 10, até o usuário configurar
        const visibleRows = rows.slice(0, 200);

        const thead = `<thead><tr>${cols.map(c => `<th>${escapeHtml(prettify(c))}</th>`).join("")}</tr></thead>`;
        const tbody = `<tbody>${visibleRows.map(r => `
            <tr>${cols.map(c => `<td>${formatCell(r[c], c)}</td>`).join("")}</tr>
        `).join("")}</tbody>`;

        els.dataTable.innerHTML = thead + tbody;
    }

    function formatCell(value, colName) {
        if (value === null || value === undefined) return "-";
        const role = currentSheet.analysis.columns.find(c => c.column === colName)?.role;

        // Todos os papéis de valor em R$ — antes só "money" era formatado e
        // M.O/Peças apareciam como número cru (ex.: 1234.5).
        if (MONEY_LIKE_ROLES.has(role)) {
            const n = Utils.parseNumberSmart(value);
            return n !== null ? escapeHtml(Utils.formatMoney(n)) : escapeHtml(String(value));
        }
        if (role === "percentage") {
            const n = Utils.parseNumberSmart(value);
            if (n === null) return escapeHtml(String(value));
            const pct = isFractionPercent(colName) ? n * 100 : n;
            return escapeHtml(`${Utils.formatNumber(pct, 1)}%`);
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
                const r = [formatMonthLabel(m.label), csvNumber(m.value)];
                if (monthlyService) r.push(csvNumber(monthlyService.get(m.label) || 0));
                if (monthlyParts) r.push(csvNumber(monthlyParts.get(m.label) || 0));
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
                const r = [String(g.key), csvNumber(g.value)];
                if (osCountMap) {
                    const count = osCountMap.get(g.key) || 0;
                    r.push(String(count), csvNumber(count ? g.value / count : 0));
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
                csvNumber(g.value),
                csvNumber(total ? (g.value / total) * 100 : 0, 1),
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
                if (moneyMap) r.push(csvNumber(moneyMap.get(k) || 0));
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
    /**
     * Número para CSV com vírgula decimal. O arquivo usa ";" como
     * separador (padrão do Excel em português), e nesse Excel o ponto é
     * separador de MILHAR: "1234.50" não era lido como número.
     */
    function csvNumber(n, decimals = 2) {
        return (Number(n) || 0).toFixed(decimals).replace(".", ",");
    }

    function exportCSV(filename, headers, rows) {
        const escapeCSV = v => {
            const s = String(v ?? "");
            return /[;"\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
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

    /**
     * Única definição de escapeHtml do arquivo (havia uma segunda cópia
     * mais acima que esta sobrescrevia silenciosamente por hoisting).
     * Coage para String antes de escapar, para aceitar números/null.
     */
    function escapeHtml(s) {
        return String(s ?? "").replace(/[&<>"']/g, c => ({
            "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
        }[c]));
    }

    // Um caminho OU o outro: com o script carregado como "defer", o estado
    // já é "interactive" ANTES do DOMContentLoaded disparar, e o padrão
    // anterior (registrar o evento e também chamar direto) rodava o boot
    // duas vezes, duplicando todos os event listeners.
    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", boot);
    } else {
        boot();
    }

})();