/*============================================================
  charts.js
  Única camada autorizada a criar gráficos. Usa Chart.js.
  Dashboard nunca chama `new Chart(...)` diretamente — sempre
  passa por aqui, recebendo dados já agregados do Database.
==============================================================*/

const Charts = (() => {

    const PALETTE = [
        "#0E7C66", "#13A085", "#1FBF9F", "#5FD8C2",
        "#0B5A4B", "#F2A93B", "#E2574C", "#3B7DD8",
        "#8D6FE0", "#2EA0A0"
    ];

    const instances = new Map();

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
                legend: { labels: { font: { family: "Inter, sans-serif" }, color: "#3a3f47" } },
                tooltip: { backgroundColor: "#1f2329", padding: 10, cornerRadius: 8 }
            }
        }, extra);
    }

    function bar(canvasId, { labels, values, label = "Total" }) {
        destroy(canvasId);
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
                    y: { beginAtZero: true, grid: { color: "#eef0f2" } },
                    x: { grid: { display: false } }
                },
                plugins: { legend: { display: false } }
            })
        });

        instances.set(canvasId, chart);
        return chart;
    }

    function line(canvasId, { labels, values, label = "Tendência" }) {
        destroy(canvasId);
        const ctx = document.getElementById(canvasId);
        if (!ctx) return null;

        const chart = new Chart(ctx, {
            type: "line",
            data: {
                labels,
                datasets: [{
                    label,
                    data: values,
                    borderColor: PALETTE[1],
                    backgroundColor: "rgba(19,160,133,0.12)",
                    tension: 0.35,
                    fill: true,
                    pointRadius: 3
                }]
            },
            options: baseOptions({
                scales: {
                    y: { beginAtZero: true, grid: { color: "#eef0f2" } },
                    x: { grid: { display: false } }
                },
                plugins: { legend: { display: false } }
            })
        });

        instances.set(canvasId, chart);
        return chart;
    }

    function multiLine(canvasId, { labels, series }) {
        destroy(canvasId);
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
                    y: { beginAtZero: true, grid: { color: "#eef0f2" } },
                    x: { grid: { display: false } }
                }
            })
        });

        instances.set(canvasId, chart);
        return chart;
    }

    function donut(canvasId, { labels, values }) {
        destroy(canvasId);
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
                    borderColor: "#ffffff"
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
                    x: { beginAtZero: true, grid: { color: "#eef0f2" } },
                    y: { grid: { display: false } }
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