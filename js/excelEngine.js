/*============================================================
  excelEngine.js
  Engine de leitura e normalização de planilhas (XLSX/XLS/CSV).

  Fluxo:
    new ExcelEngine()
      .import(file)  -> lê TODAS as abas, TODAS as colunas,
                         TODAS as linhas, detecta cabeçalho,
                         classifica colunas (Analyzer), gera
                         estatísticas (Statistics), cria índices
                         (Indexer), normaliza valores, e produz
                         um objeto "Database" pronto para uso.

  Depende de: SheetJS (XLSX global, via CDN), Utils, Analyzer,
  Statistics, Indexer.

  Não conhece nada sobre Dashboard. É uma biblioteca pura.
==============================================================*/

class ExcelEngine {

    /**
     * @param {Object} config
     * @param {number} config.headerSearchRows - quantas linhas iniciais
     *        varrer procurando o cabeçalho real (planilhas corporativas
     *        costumam ter títulos/linhas em branco antes do cabeçalho).
     * @param {number} config.sampleSize - tamanho de amostra para o Analyzer.
     */
    constructor(config = {}) {
        this.version = "3.0.0";

        this.config = {
            headerSearchRows: 20,
            sampleSize: 300,
            ...config
        };

        this.events = new Utils.EventBus();
    }

    on(evt, cb) { this.events.on(evt, cb); return this; }

    emitProgress(stage, percent, message) {
        this.events.emit("progress", { stage, percent, message });
    }

    /**
     * Ponto de entrada principal. Recebe um File (input[type=file])
     * e retorna um objeto Database pronto: { metadata, sheets }.
     */
    async import(file) {
        this.emitProgress("read", 0, `Lendo arquivo ${file.name}...`);

        const buffer = await file.arrayBuffer();
        const ext = (file.name.split(".").pop() || "").toLowerCase();

        let workbook;
        if (ext === "csv") {
            const text = new TextDecoder("utf-8").decode(buffer);
            workbook = XLSX.read(text, { type: "string", raw: false });
        } else {
            workbook = XLSX.read(buffer, { type: "array", cellDates: true });
        }

        this.emitProgress("parse", 20, "Lendo abas...");

        const sheets = {};
        const sheetNames = workbook.SheetNames;

        for (let i = 0; i < sheetNames.length; i++) {
            const name = sheetNames[i];
            const ws = workbook.Sheets[name];

            const parsed = this.parseSheet(ws, name);
            if (parsed) sheets[name] = parsed;

            const pct = 20 + Math.round(((i + 1) / sheetNames.length) * 70);
            this.emitProgress("parse", pct, `Processando aba "${name}"...`);
        }

        this.emitProgress("finish", 100, "Importação concluída.");

        return {
            metadata: {
                fileName: file.name,
                importedAt: new Date().toISOString(),
                sheetCount: Object.keys(sheets).length,
                engineVersion: this.version
            },
            sheets
        };
    }

    /**
     * Converte uma worksheet do SheetJS em uma estrutura normalizada:
     * { name, columns, rows, analysis, indexes, statistics }
     */
    parseSheet(ws, name) {
        const matrix = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null });
        if (!matrix || !matrix.length) return null;

        const headerInfo = this.detectHeader(matrix);
        if (!headerInfo) return null;

        const { headerRowIndex, headers } = headerInfo;

        const dataRows = matrix.slice(headerRowIndex + 1)
            .filter(r => r && r.some(cell => cell !== null && cell !== undefined && cell !== ""));

        const rows = dataRows.map(r => {
            const obj = {};
            headers.forEach((h, i) => {
                obj[h] = this.normalizeValue(r[i]);
            });
            return obj;
        });

        if (!rows.length) return null;

        const analysis = Analyzer.analyzeSheet(rows, this.config.sampleSize);

        // FILTRO DE LINHAS "FANTASMA": planilhas financeiras costumam ter
        // fórmulas arrastadas muito além dos dados reais. Essas linhas
        // sobrevivem ao filtro inicial (têm ALGUMA célula não-vazia, ex:
        // uma fórmula de imposto resultando em 0) mas não representam um
        // registro de negócio de verdade — todas as colunas que IDENTIFICAM
        // o registro (O.S, cliente, id) ficam vazias. Usa o papel semântico
        // mais confiável disponível como "âncora" e descarta linhas sem
        // valor nela. Se a planilha não tiver nenhuma coluna desse tipo
        // (ex: um resumo agregado por data), não filtra nada.
        const anchorRole = ["serviceOrder", "entityName", "id"]
            .find(role => (analysis.roleMap[role] || []).length > 0);

        let cleanRows = rows;
        if (anchorRole) {
            const anchorCol = analysis.roleMap[anchorRole][0];
            cleanRows = rows.filter(r => {
                const v = r[anchorCol];
                return v !== null && v !== undefined && String(v).trim() !== "";
            });
        }

        if (!cleanRows.length) cleanRows = rows; // segurança: nunca zera a planilha inteira

        const statistics = {};
        analysis.columns.forEach(c => {
            statistics[c.column] = Statistics.summarizeColumn(cleanRows, c.column, c.role);
        });
        const indexes = Indexer.buildIndexes(cleanRows, analysis.roleMap);

        return {
            name,
            columns: headers,
            rowCount: cleanRows.length,
            rows: cleanRows,
            analysis,
            statistics,
            indexes
        };
    }

    /**
     * Detecta a linha de cabeçalho real dentro das primeiras N linhas.
     * Heurística: a linha do cabeçalho é a que tem maior número de
     * células de texto não vazias e não repetidas (nomes de coluna),
     * imediatamente seguida por linhas com mais variação de tipos
     * (dados reais).
     */
    detectHeader(matrix) {
        const limit = Math.min(this.config.headerSearchRows, matrix.length);
        let bestIndex = 0;
        let bestScore = -1;

        for (let i = 0; i < limit; i++) {
            const row = matrix[i] || [];
            const nonEmpty = row.filter(c => c !== null && c !== undefined && String(c).trim() !== "");
            if (!nonEmpty.length) continue;

            const textCells = nonEmpty.filter(c => typeof c === "string" && isNaN(Number(c)));
            const uniqueRatio = new Set(nonEmpty.map(String)).size / nonEmpty.length;

            // próxima linha deve parecer "dados" (boa indicação de que esta é cabeçalho)
            const nextRow = matrix[i + 1] || [];
            const nextNonEmpty = nextRow.filter(c => c !== null && c !== undefined && String(c).trim() !== "");

            const score = (textCells.length * 2) + (uniqueRatio * 3) + (nextNonEmpty.length > 0 ? 2 : 0)
                + (nonEmpty.length >= 2 ? 1 : 0);

            if (score > bestScore) {
                bestScore = score;
                bestIndex = i;
            }
        }

        const headerRow = matrix[bestIndex] || [];
        if (!headerRow.some(c => c !== null && c !== undefined && String(c).trim() !== "")) {
            return null;
        }

        const seen = new Map();
        const headers = headerRow.map((c, idx) => {
            let label = (c === null || c === undefined || String(c).trim() === "")
                ? `Coluna_${idx + 1}`
                : String(c).trim();

            if (seen.has(label)) {
                const n = seen.get(label) + 1;
                seen.set(label, n);
                label = `${label}_${n}`;
            } else {
                seen.set(label, 0);
            }
            return label;
        });

        return { headerRowIndex: bestIndex, headers };
    }

    /**
     * Normaliza um valor de célula bruto: trata datas (objeto Date do
     * SheetJS com cellDates:true), números, strings com espaços etc.
     * Mantém o valor "cru" utilizável; a tipagem fina por papel
     * semântico acontece no Analyzer/Statistics sob demanda.
     */
    normalizeValue(v) {
        if (v === undefined) return null;
        if (v instanceof Date) return v;
        if (typeof v === "string") {
            const trimmed = v.trim();
            return trimmed === "" ? null : trimmed;
        }
        return v;
    }
}

if (typeof module !== "undefined" && module.exports) module.exports = ExcelEngine;