/*============================================================
  excelWorker.js
  Web Worker responsável por rodar TODO o pipeline pesado de
  importação (leitura do XLSX, parse de abas, análise semântica,
  e estatísticas) fora da thread principal.

  Motivo: em planilhas com milhares de linhas, esse pipeline
  inteiro rodando de forma síncrona na thread principal é o que
  faz o Chrome mostrar o aviso de "página lenta / aguardar ou
  fechar". Rodando aqui dentro, a thread principal fica livre
  pra desenhar a UI (barra de progresso, animações etc) o tempo
  todo, e o navegador nunca considera a aba travada.

  Nenhuma lógica de negócio foi alterada: este arquivo só importa
  as mesmas classes/módulos já usados antes (Utils, Analyzer,
  Statistics, ExcelEngine) e delega pra elas.

  Protocolo de mensagens:
    main -> worker: { type: "import", file: File }
    worker -> main: { type: "progress", stage, percent, message }
    worker -> main: { type: "done", rawDatabase }
    worker -> main: { type: "error", message }
==============================================================*/

// Dependências, na mesma ordem em que eram carregadas via <script>
// na thread principal antes desta mudança.
importScripts(
    "../vendor/xlsx.full.min.js",
    "utils.js",
    "analyzer.js",
    "statistics.js",
    "excelEngine.js"
);

self.onmessage = async (event) => {
    const { type, file } = event.data || {};
    if (type !== "import") return;

    try {
        const engine = new ExcelEngine();

        engine.on("progress", ({ stage, percent, message }) => {
            self.postMessage({ type: "progress", stage, percent, message });
        });

        const rawDatabase = await engine.import(file);

        self.postMessage({ type: "done", rawDatabase });
    } catch (err) {
        self.postMessage({
            type: "error",
            message: (err && err.message) || "Erro desconhecido ao processar o arquivo na Worker."
        });
    }
};