/*============================================================
  charts.js
  Única camada autorizada a criar gráficos. Usa Chart.js.
  Dashboard nunca chama `new Chart(...)` diretamente — sempre
  passa por aqui, recebendo dados já agregados do Database.
==============================================================*/

const Charts = (() => {

    const PALETTE = [
        "#4F7CFF", "#8B6CF2", "#36C7E0", "#2ED9A3",
        "#F2A93B", "#F25C5C", "#5FA8FF", "#C792EA",
        "#5FE0C7", "#FFD166"
    ];

    const instances = new Map();

    /**
     * Verifica se a biblioteca Chart.js (carregada via CDN no HTML) está
     * disponível. Se o CDN falhar (bloqueio de rede, firewall corporativo,
     * ad-blocker), a classe global `Chart` não existe e qualquer chamada
     * `new Chart(...)` lançaria "Chart is not defined". Em vez de falhar
     * silenciosamente (canvas em branco sem explicação), mostra um aviso
     * visível dentro do próprio card do gráfico.
     */
    function ensureChartLib(canvasId) {
        if (typeof Chart !== "undefined") return true;

        const canvas = document.getElementById(canvasId);
        const container = canvas ? canvas.closest(".chart-wrap") : null;
        if (container) {
            container.innerHTML =
                '<div style="display:flex;align-items:center;justify-content:center;height:100%;' +
                'color:#F25C5C;font-size:13px;text-align:center;padding:0 16px;">' +
                'Não foi possível carregar a biblioteca de gráficos (Chart.js). ' +
                'Verifique sua conexão com a internet ou se algum firewall/bloqueador ' +
                'está impedindo o carregamento de scripts externos.</div>';
        }
        console.error("Charts: a biblioteca Chart.js não está disponível (verifique o <script> do CDN em dashboard.html).");
        return false;
    }

    function destroy(canvasId) {
        if (instances.has(canvasId)) {
            instances.get(canvasId).destroy();
            instances.delete(canvasId);
        }
    }

    function baseOptions(extra = {}) {
        return Object.assign({
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { labels: { font: { family: "Inter, sans-serif" }, color: "#8B96B3" } },
                tooltip: { backgroundColor: "#0B1220", padding: 10, cornerRadius: 8, borderColor: "#232E4A", borderWidth: 1 }
            }
        }, extra);
    }

    function bar(canvasId, { labels, values, label = "Total" }) {
        destroy(canvasId);
        if (!ensureChartLib(canvasId)) return null;
        const ctx = document.getElementById(canvasId);
        if (!ctx) return null;

        const chart = new Chart(ctx, {
            type: "bar",
            data: {
                labels,
                datasets: [{
                    label,
                    data: values,
                    backgroundColor: PALETTE[0],
                    borderRadius: 6,
                    maxBarThickness: 42
                }]
            },
            options: baseOptions({
                scales: {
                    y: { beginAtZero: true, grid: { color: "#1B2540" }, ticks: { color: "#5C6786" } },
                    x: { grid: { display: false }, ticks: { color: "#5C6786" } }
                },
                plugins: { legend: { display: false } }
            })
        });

        instances.set(canvasId, chart);
        return chart;
    }

    function line(canvasId, { labels, values, label = "Tendência" }) {
        destroy(canvasId);
        if (!ensureChartLib(canvasId)) return null;
        const ctx = document.getElementById(canvasId);
        if (!ctx) return null;

        const chart = new Chart(ctx, {
            type: "line",
            data: {
                labels,
                datasets: [{
                    label,
                    data: values,
                    borderColor: PALETTE[0],
                    backgroundColor: "rgba(79,124,255,0.14)",
                    tension: 0.35,
                    fill: true,
                    pointRadius: 3
                }]
            },
            options: baseOptions({
                scales: {
                    y: { beginAtZero: true, grid: { color: "#1B2540" }, ticks: { color: "#5C6786" } },
                    x: { grid: { display: false }, ticks: { color: "#5C6786" } }
                },
                plugins: { legend: { display: false } }
            })
        });

        instances.set(canvasId, chart);
        return chart;
    }

    function multiLine(canvasId, { labels, series }) {
        destroy(canvasId);
        if (!ensureChartLib(canvasId)) return null;
        const ctx = document.getElementById(canvasId);
        if (!ctx) return null;

        const chart = new Chart(ctx, {
            type: "line",
            data: {
                labels,
                datasets: series.map((s, i) => ({
                    label: s.label,
                    data: s.data,
                    borderColor: PALETTE[i % PALETTE.length],
                    backgroundColor: "transparent",
                    tension: 0.35,
                    pointRadius: 3
                }))
            },
            options: baseOptions({
                scales: {
                    y: { beginAtZero: true, grid: { color: "#1B2540" }, ticks: { color: "#5C6786" } },
                    x: { grid: { display: false }, ticks: { color: "#5C6786" } }
                }
            })
        });

        instances.set(canvasId, chart);
        return chart;
    }

    function donut(canvasId, { labels, values }) {
        destroy(canvasId);
        if (!ensureChartLib(canvasId)) return null;
        const ctx = document.getElementById(canvasId);
        if (!ctx) return null;

        const chart = new Chart(ctx, {
            type: "doughnut",
            data: {
                labels,
                datasets: [{
                    data: values,
                    backgroundColor: labels.map((_, i) => PALETTE[i % PALETTE.length]),
                    borderWidth: 2,
                    borderColor: "#161F35"
                }]
            },
            options: baseOptions({
                cutout: "65%",
                plugins: { legend: { position: "right" } }
            })
        });

        instances.set(canvasId, chart);
        return chart;
    }

    function horizontalBar(canvasId, { labels, values, label = "Total" }) {
        destroy(canvasId);
        if (!ensureChartLib(canvasId)) return null;
        const ctx = document.getElementById(canvasId);
        if (!ctx) return null;

        const chart = new Chart(ctx, {
            type: "bar",
            data: {
                labels,
                datasets: [{
                    label,
                    data: values,
                    backgroundColor: PALETTE[2],
                    borderRadius: 6
                }]
            },
            options: baseOptions({
                indexAxis: "y",
                scales: {
                    x: { beginAtZero: true, grid: { color: "#1B2540" }, ticks: { color: "#5C6786" } },
                    y: { grid: { display: false }, ticks: { color: "#5C6786" } }
                },
                plugins: { legend: { display: false } }
            })
        });

        instances.set(canvasId, chart);
        return chart;
    }

    return { bar, line, multiLine, donut, horizontalBar, destroy, PALETTE };
})();

if (typeof module !== "undefined" && module.exports) module.exports = Charts;