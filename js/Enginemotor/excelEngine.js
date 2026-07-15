/*============================================================
  excelEngine.js
  Engine de leitura e normalização de planilhas (XLSX/XLS/CSV).

  Fluxo:
    new ExcelEngine()
      .import(file)  -> lê TODAS as abas, TODAS as colunas,
                         TODAS as linhas, detecta cabeçalho,
                         classifica colunas (Analyzer), gera
                         estatísticas (Statistics), normaliza
                         valores, e produz um objeto "Database"
                         pronto para uso.

  Depende de: SheetJS (XLSX global, via CDN), Utils, Analyzer,
  Statistics.

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
        try {
            if (ext === "csv") {
                const text = this.decodeCsvBuffer(buffer);
                workbook = XLSX.read(text, { type: "string", raw: false });
            } else {
                workbook = XLSX.read(buffer, { type: "array", cellDates: true });
            }
        } catch (err) {
            throw this.translateReadError(err, file.name);
        }

        if (!workbook || !workbook.SheetNames || !workbook.SheetNames.length) {
            throw new Error(`O arquivo "${file.name}" não contém nenhuma aba legível.`);
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
     * Decodifica o buffer de um CSV tentando UTF-8 primeiro; se o
     * arquivo não for UTF-8 válido (caso comum de exports do Excel/
     * sistemas corporativos brasileiros, que costumam sair em
     * Windows-1252/Latin1), cai para Windows-1252. Sem isso, acentos
     * (ç, ã, é...) viram caracteres quebrados silenciosamente, sem
     * nenhum erro visível.
     */
    decodeCsvBuffer(buffer) {
        const bytes = new Uint8Array(buffer);

        // BOM UTF-8 explícito: sem ambiguidade, decodifica direto.
        if (bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) {
            return new TextDecoder("utf-8").decode(buffer);
        }

        try {
            // "fatal: true" faz o decoder lançar erro se encontrar uma
            // sequência de bytes que não é UTF-8 válido, em vez de
            // silenciosamente substituir por "�".
            return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
        } catch (e) {
            return new TextDecoder("windows-1252").decode(buffer);
        }
    }

    /**
     * Traduz erros crus do SheetJS/parser em mensagens que fazem
     * sentido pra quem está importando o arquivo, em vez de deixar
     * vazar mensagens técnicas em inglês.
     */
    translateReadError(err, fileName) {
        const msg = (err && err.message) || "";

        if (/password|encrypt/i.test(msg)) {
            return new Error(
                `O arquivo "${fileName}" está protegido por senha. Remova a proteção no Excel ` +
                `(Arquivo > Informações > Proteger Pasta de Trabalho > Remover Senha) e importe novamente.`
            );
        }

        if (/central directory|corrupt|not a zip|invalid signature|end of data|unexpected end/i.test(msg)) {
            return new Error(
                `O arquivo "${fileName}" parece estar corrompido ou incompleto (o download pode ter ` +
                `falhado). Tente baixar/exportar o arquivo novamente.`
            );
        }

        return new Error(
            `Não foi possível ler o arquivo "${fileName}"${msg ? `: ${msg}` : " (formato inválido)"}.`
        );
    }

    /**
     * Converte uma worksheet do SheetJS em uma estrutura normalizada:
     * { name, columns, rows, analysis, statistics }
     */
    parseSheet(ws, name) {
        const matrix = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null });
        if (!matrix || !matrix.length) return null;

        const headerInfo = this.detectHeader(matrix);
        if (!headerInfo) return null;

        const { headerRowIndex, headers: rawHeaders } = headerInfo;

        const dataRows = matrix.slice(headerRowIndex + 1)
            .filter(r => r && r.some(cell => cell !== null && cell !== undefined && cell !== ""));

        let rows = dataRows.map(r => {
            const obj = {};
            rawHeaders.forEach((h, i) => {
                obj[h] = this.normalizeValue(r[i]);
            });
            return obj;
        });

        if (!rows.length) return null;

        // Remove colunas "fantasma" no final: planilhas com formatação
        // vazada (bordas/estilos arrastados muito além da tabela real)
        // geram colunas extras sem cabeçalho real (Coluna_N) e sem
        // nenhum dado em nenhuma linha. Sem isso, uma planilha pequena
        // pode virar centenas de colunas processadas à toa.
        const trimmed = this.trimGhostColumns(rawHeaders, rows);
        const headers = trimmed.headers;
        rows = trimmed.rows;

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

        // NOTA: os índices por papel (Indexer.buildIndexes) foram removidos
        // do pipeline: eram construídos e persistidos no IndexedDB em toda
        // importação (custo real de CPU/memória em abas de ~100 mil linhas)
        // mas nenhum caminho de código consultava Indexer.lookup — filtros
        // e busca sempre usaram scan linear via SheetAPI. Se um dia a
        // filtragem precisar de lookup O(1), reintroduzir aqui.

        return {
            name,
            columns: headers,
            rowCount: cleanRows.length,
            rows: cleanRows,
            analysis,
            statistics
        };
    }

    /**
     * Remove colunas no final da tabela que não têm nome real (viraram
     * "Coluna_N" no detectHeader) E não têm nenhum valor em nenhuma
     * linha. Verifica só uma amostra das linhas (não a planilha
     * inteira) para não pesar em planilhas com muitas linhas.
     */
    trimGhostColumns(headers, rows) {
        const sample = rows.length > 500 ? rows.slice(0, 500) : rows;

        let cut = headers.length;
        for (let i = headers.length - 1; i >= 0; i--) {
            const h = headers[i];
            if (!/^Coluna_\d+$/.test(h)) break;

            const hasAnyValue = sample.some(r => r[h] !== null && r[h] !== undefined);
            if (hasAnyValue) break;

            cut = i;
        }

        if (cut === headers.length) return { headers, rows };

        const keptHeaders = headers.slice(0, cut);
        const keptRows = rows.map(r => {
            const obj = {};
            keptHeaders.forEach(h => { obj[h] = r[h]; });
            return obj;
        });
        return { headers: keptHeaders, rows: keptRows };
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
        if (v instanceof Date) return isNaN(v.getTime()) ? null : v;

        if (typeof v === "number") {
            // Fórmulas quebradas (ex: divisão por zero, referência
            // circular) podem chegar aqui como NaN/Infinity. Sem esse
            // filtro, viram "NaN" ou "Infinity" nos KPIs e gráficos.
            return isFinite(v) ? v : null;
        }

        if (typeof v === "string") {
            const trimmed = v.trim();
            if (trimmed === "") return null;
            // Erros de fórmula do Excel que sobrevivem como texto
            // (#DIV/0!, #REF!, #N/A etc.) não são um valor de negócio.
            if (/^#(DIV\/0!|N\/A|NAME\?|NULL!|NUM!|REF!|VALUE!|GETTING_DATA)$/i.test(trimmed)) {
                return null;
            }
            return trimmed;
        }
        return v;
    }
}

if (typeof module !== "undefined" && module.exports) module.exports = ExcelEngine;