/*============================================================
  entrada.js
  Tela de entrada: única responsabilidade é pegar o arquivo do
  usuário, mandar para o ExcelEngine, salvar o Database e
  redirecionar para o Dashboard. Nenhuma lógica de negócio aqui.
==============================================================*/

(function () {

    const fileInput = document.getElementById("fileInput");
    const dropZone = document.getElementById("dropZone");
    const progressBar = document.getElementById("progressBar");
    const progressLabel = document.getElementById("progressLabel");
    const progressWrap = document.getElementById("progressWrap");
    const errorBox = document.getElementById("errorBox");

    if (!fileInput) return; // página atual não é a de entrada

    // Limites de tamanho de arquivo: acima do "hard" a importação é
    // bloqueada (risco real de travar a aba/estourar memória); entre
    // o "warn" e o "hard" só avisamos e deixamos o usuário decidir.
    const MAX_FILE_SIZE_HARD = 200 * 1024 * 1024; // 200MB
    const MAX_FILE_SIZE_WARN = 50 * 1024 * 1024;  // 50MB

    function formatMB(bytes) {
        return (bytes / (1024 * 1024)).toFixed(0);
    }

    function reportProgress({ percent, message }) {
        if (progressWrap) progressWrap.style.display = "block";
        if (progressBar) progressBar.style.width = `${percent}%`;
        if (progressLabel) progressLabel.textContent = message;
    }

    /*--------------------------------------------------------
      Importação via Web Worker (caminho principal).
      Todo o trabalho pesado (leitura do XLSX, parse de abas,
      análise semântica, estatísticas, índices) roda fora da
      thread principal, então a UI nunca "trava" e o Chrome
      nunca mostra o aviso de página lenta, independente do
      tamanho do arquivo.
    --------------------------------------------------------*/
    function importViaWorker(file, onProgress) {
        return new Promise((resolve, reject) => {
            let worker;
            try {
                worker = new Worker("js/Enginemotor/excelWorker.js");
            } catch (err) {
                reject(err);
                return;
            }

            worker.onmessage = (event) => {
                const msg = event.data || {};
                if (msg.type === "progress") {
                    onProgress({ percent: msg.percent, message: msg.message });
                } else if (msg.type === "done") {
                    worker.terminate();
                    resolve(msg.rawDatabase);
                } else if (msg.type === "error") {
                    worker.terminate();
                    reject(new Error(msg.message));
                }
            };

            worker.onerror = (err) => {
                worker.terminate();
                reject((err && err.message) ? err : new Error("Erro na Worker de importação."));
            };

            worker.postMessage({ type: "import", file });
        });
    }

    /*--------------------------------------------------------
      Fallback: caminho antigo, síncrono, na própria thread
      principal. Só é usado se a Worker não puder ser criada
      ou falhar por algum motivo (ex: navegador muito antigo,
      ambiente que bloqueie importScripts). Nesse caso o
      comportamento é exatamente o mesmo de antes desta mudança
      — nunca pior, só sem a garantia extra da Worker.
      As dependências (XLSX, Analyzer, ExcelEngine) só
      são carregadas aqui, sob demanda, porque no caminho normal
      (via Worker) elas não precisam estar na thread principal.
    --------------------------------------------------------*/
    let fallbackDepsPromise = null;

    function loadScript(src) {
        return new Promise((resolve, reject) => {
            const el = document.createElement("script");
            el.src = src;
            el.onload = () => resolve();
            el.onerror = () => reject(new Error(`Falha ao carregar ${src}`));
            document.head.appendChild(el);
        });
    }

    function ensureFallbackDeps() {
        if (typeof ExcelEngine !== "undefined") return Promise.resolve();
        if (!fallbackDepsPromise) {
            fallbackDepsPromise = loadScript("https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js")
                .then(() => loadScript("js/Enginemotor/analyzer.js"))
                .then(() => loadScript("js/Enginemotor/excelEngine.js"));
        }
        return fallbackDepsPromise;
    }

    async function importViaMainThread(file, onProgress) {
        await ensureFallbackDeps();
        const engine = new ExcelEngine();
        engine.on("progress", ({ percent, message }) => onProgress({ percent, message }));
        return engine.import(file);
    }

    async function importSpreadsheet(file, onProgress) {
        if (typeof Worker !== "undefined") {
            try {
                return await importViaWorker(file, onProgress);
            } catch (err) {
                console.warn(
                    "entrada.js: importação via Worker falhou, usando fallback na thread principal.",
                    err
                );
            }
        }
        return importViaMainThread(file, onProgress);
    }

    async function handleFile(file) {
        if (!file) return;

        errorBox && (errorBox.style.display = "none");

        const validExt = ["xlsx", "xls", "csv"];
        const ext = file.name.split(".").pop().toLowerCase();

        if (!validExt.includes(ext)) {
            showError("Formato não suportado. Envie um arquivo .xlsx, .xls ou .csv.");
            return;
        }

        if (file.size === 0) {
            showError("O arquivo está vazio (0 bytes).");
            return;
        }

        if (file.size > MAX_FILE_SIZE_HARD) {
            showError(
                `Arquivo muito grande (${formatMB(file.size)}MB). O limite é ${formatMB(MAX_FILE_SIZE_HARD)}MB ` +
                `— acima disso o navegador pode travar. Tente dividir os dados em arquivos menores.`
            );
            return;
        }

        if (file.size > MAX_FILE_SIZE_WARN) {
            const proceed = window.confirm(
                `Este arquivo tem ${formatMB(file.size)}MB e pode demorar bastante ou consumir muita ` +
                `memória do navegador. Deseja continuar mesmo assim?`
            );
            if (!proceed) return;
        }

        try {
            const rawDatabase = await importSpreadsheet(file, reportProgress);

            if (!rawDatabase.metadata.sheetCount) {
                showError("Nenhuma aba com dados válidos foi encontrada no arquivo.");
                return;
            }

            const db = Database.load(rawDatabase);
            const saved = await db.save();

            if (!saved) {
                showError(
                    "Não foi possível salvar os dados importados neste navegador. Verifique se o " +
                    "IndexedDB está habilitado (modo de navegação anônima/privada costuma bloquear) " +
                    "e tente novamente."
                );
                return;
            }

            // valida que o que foi salvo realmente pode ser recarregado
            const check = await Database.loadFromStorage();
            if (!check || !check.getSheets().length) {
                console.error("entrada.js: save() retornou true mas loadFromStorage() veio vazio.", {
                    sheets: rawDatabase.metadata
                });
                showError(
                    "Houve um problema ao salvar os dados importados. Abra o console do navegador (F12) " +
                    "para mais detalhes e tente novamente."
                );
                return;
            }

            progressLabel && (progressLabel.textContent = "Concluído! Abrindo dashboard...");

            setTimeout(() => {
                window.location.href = "dashboard.html";
            }, 600);

        } catch (err) {
            console.error(err);
            // translateReadError (excelEngine.js) já produz mensagens amigáveis
            // pros casos conhecidos (senha, corrompido); usa ela quando existe,
            // com um fallback genérico só pro que não foi previsto.
            showError(
                (err && err.message) ||
                "Não foi possível processar o arquivo. Verifique se ele não está corrompido."
            );
        }
    }

    function showError(msg) {
        if (!errorBox) { alert(msg); return; }
        errorBox.textContent = msg;
        errorBox.style.display = "block";
        if (progressWrap) progressWrap.style.display = "none";
    }

    fileInput.addEventListener("change", e => handleFile(e.target.files[0]));

    if (dropZone) {
        ["dragover", "dragenter"].forEach(evt =>
            dropZone.addEventListener(evt, e => {
                e.preventDefault();
                dropZone.classList.add("dragging");
            })
        );

        ["dragleave", "drop"].forEach(evt =>
            dropZone.addEventListener(evt, e => {
                e.preventDefault();
                dropZone.classList.remove("dragging");
            })
        );

        dropZone.addEventListener("drop", e => {
            const files = e.dataTransfer && e.dataTransfer.files;

            if (!files || !files.length) {
                showError("Não foi possível identificar um arquivo válido no item arrastado.");
                return;
            }

            if (files.length > 1) {
                // alert() em vez de showError: handleFile() limpa o errorBox
                // assim que começa, então um showError aqui seria apagado
                // antes do usuário conseguir ler.
                alert(`Envie apenas um arquivo por vez. Foi usado somente "${files[0].name}".`);
            }

            handleFile(files[0]);
        });

        dropZone.addEventListener("click", () => fileInput.click());
    }

    const clearCacheBtn = document.getElementById("clearCacheBtn");
    if (clearCacheBtn) {
        clearCacheBtn.addEventListener("click", async () => {
            const confirmed = window.confirm(
                "Isso vai apagar os dados importados salvos neste navegador. Continuar?"
            );
            if (!confirmed) return;

            try {
                await Database.clear();
                clearCacheBtn.textContent = "Dados limpos ✓";
                setTimeout(() => { clearCacheBtn.textContent = "Limpar dados salvos deste navegador"; }, 2000);
            } catch (err) {
                console.error("Falha ao limpar cache:", err);
                alert("Não foi possível limpar o cache. Veja o console (F12) para detalhes.");
            }
        });
    }

})();