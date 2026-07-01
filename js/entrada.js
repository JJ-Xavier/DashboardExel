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

    const engine = new ExcelEngine();

    engine.on("progress", ({ stage, percent, message }) => {
        if (progressWrap) progressWrap.style.display = "block";
        if (progressBar) progressBar.style.width = `${percent}%`;
        if (progressLabel) progressLabel.textContent = message;
    });

    async function handleFile(file) {
        if (!file) return;

        errorBox && (errorBox.style.display = "none");

        const validExt = ["xlsx", "xls", "csv"];
        const ext = file.name.split(".").pop().toLowerCase();

        if (!validExt.includes(ext)) {
            showError("Formato não suportado. Envie um arquivo .xlsx, .xls ou .csv.");
            return;
        }

        try {
            const rawDatabase = await engine.import(file);

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
            showError("Não foi possível processar o arquivo. Verifique se ele não está corrompido.");
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
            const file = e.dataTransfer.files[0];
            handleFile(file);
        });

        dropZone.addEventListener("click", () => fileInput.click());
    }

})();