/*============================================================
  database.js
  Camada Database: API única de acesso aos dados normalizados
  pelo ExcelEngine. O Dashboard SÓ pode falar com este arquivo.

  Uso:
    const db = Database.load(rawDatabaseFromEngine);
    db.getSheets();                 -> ["BASE CARROS", ...]
    const sheet = db.sheet("BASE CARROS");
    sheet.sum("money");             -> soma por PAPEL semântico
    sheet.sum("VALOR TOTAL");       -> também aceita nome literal
    sheet.groupBy("status");
    sheet.filter([{ role:"status", op:"=", value:"Aberto" }]);
    sheet.search("joão");
    sheet.unique("entityName");
    sheet.statistics("money");
==============================================================*/

class SheetAPI {

    constructor(rawSheet) {
        this.raw = rawSheet;
        this.name = rawSheet.name;
        this.rows = rawSheet.rows;
        this.columns = rawSheet.columns;
        this.analysis = rawSheet.analysis;
        this.statistics = rawSheet.statistics;

        this._filterCache = new Map();
    }

    /** Resolve um "role ou nome literal" para o nome real de coluna. */
    resolveColumn(roleOrColumn) {
        if (this.columns.includes(roleOrColumn)) return roleOrColumn;

        const fromRole = this.analysis.roleMap[roleOrColumn];
        if (fromRole && fromRole.length) return fromRole[0];

        let best = null, bestScore = 0;
        for (const c of this.columns) {
            const s = Utils.similarity(c, roleOrColumn);
            if (s > bestScore) { bestScore = s; best = c; }
        }
        return bestScore >= 0.6 ? best : null;
    }

    resolveColumns(roleOrColumn) {
        if (this.columns.includes(roleOrColumn)) return [roleOrColumn];
        return this.analysis.roleMap[roleOrColumn] || [];
    }

    getRows() { return this.rows; }
    getColumns() { return this.columns; }
    getColumnRoles() { return this.analysis.columns; }

    sum(roleOrColumn) {
        const col = this.resolveColumn(roleOrColumn);
        return col ? Statistics.sum(this.rows, col) : 0;
    }

    average(roleOrColumn) {
        const col = this.resolveColumn(roleOrColumn);
        return col ? Statistics.average(this.rows, col) : 0;
    }

    min(roleOrColumn) {
        const col = this.resolveColumn(roleOrColumn);
        return col ? Statistics.min(this.rows, col) : null;
    }

    max(roleOrColumn) {
        const col = this.resolveColumn(roleOrColumn);
        return col ? Statistics.max(this.rows, col) : null;
    }

    median(roleOrColumn) {
        const col = this.resolveColumn(roleOrColumn);
        return col ? Statistics.median(this.rows, col) : null;
    }

    unique(roleOrColumn) {
        const col = this.resolveColumn(roleOrColumn);
        return col ? Statistics.uniqueValues(this.rows, col) : [];
    }

    statisticsFor(roleOrColumn) {
        const col = this.resolveColumn(roleOrColumn);
        return col ? this.statistics[col] : null;
    }

    groupBy(roleOrColumn) {
        const col = this.resolveColumn(roleOrColumn);
        if (!col) return [];

        const moneyCol = this.resolveColumn("money");

        const groups = new Map();
        for (const row of this.rows) {
            const key = row[col] ?? "(vazio)";
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(row);
        }

        return [...groups.entries()].map(([key, rows]) => {
            const obj = { group: key, count: rows.length };
            if (moneyCol) {
                obj.sum = Statistics.sum(rows, moneyCol);
                obj.average = Statistics.average(rows, moneyCol);
            }
            return obj;
        }).sort((a, b) => b.count - a.count);
    }

    filter(conditions = []) {
        if (!conditions.length) return this.rows;

        const cacheKey = JSON.stringify(conditions);
        if (this._filterCache.has(cacheKey)) return this._filterCache.get(cacheKey);

        let rows = this.rows;

        for (const cond of conditions) {
            const col = this.resolveColumn(cond.role || cond.column);
            if (!col) continue;

            rows = rows.filter(r => {
                const v = r[col];

                switch (cond.op) {
                    case "=": return String(v) === String(cond.value);
                    case "!=": return String(v) !== String(cond.value);
                    case "in":
                        return Array.isArray(cond.value) &&
                            cond.value.some(val => String(val) === String(v));
                    // parseNumberSmart devolve null para célula vazia, e
                    // `null < 5` é true em JS (null vira 0) — sem o teste de
                    // null, "<"/"<=" incluíam todas as linhas vazias.
                    case ">": { const n = Utils.parseNumberSmart(v); return n !== null && n > cond.value; }
                    case "<": { const n = Utils.parseNumberSmart(v); return n !== null && n < cond.value; }
                    case ">=": { const n = Utils.parseNumberSmart(v); return n !== null && n >= cond.value; }
                    case "<=": { const n = Utils.parseNumberSmart(v); return n !== null && n <= cond.value; }
                    case "contains":
                        return Utils.normalizeText(v).includes(Utils.normalizeText(cond.value));
                    case "between": {
                        const n = Utils.parseNumberSmart(v);
                        return n !== null && n >= cond.value[0] && n <= cond.value[1];
                    }
                    case "dateBetween": {
                        const d = Utils.parseDateSmart(v);
                        if (!d) return false;
                        const t = d.getTime();
                        return t >= cond.value[0] && t <= cond.value[1];
                    }
                    default: return true;
                }
            });
        }

        // O cache cresce a cada combinação nova de filtros; numa sessão
        // longa filtrando uma aba grande (ex.: ~100 mil linhas), isso
        // acumula arrays de referência sem limite. Um teto simples com
        // limpeza total é suficiente aqui: o custo de recomputar um
        // filtro é baixo perto do custo de segurar dezenas de resultados.
        if (this._filterCache.size >= 50) this._filterCache.clear();
        this._filterCache.set(cacheKey, rows);
        return rows;
    }

    search(term, opts = {}) {
        const rows = opts.rows || this.rows;
        const limit = opts.limit || 500;

        if (!term || !term.trim()) return rows.slice(0, limit);

        const needle = Utils.normalizeText(term);
        const result = [];

        for (const row of rows) {
            for (const col of this.columns) {
                const v = row[col];
                if (v === null || v === undefined) continue;
                if (Utils.normalizeText(String(v)).includes(needle)) {
                    result.push(row);
                    break;
                }
            }
            if (result.length >= limit) break;
        }

        return result;
    }

    clearCache() { this._filterCache.clear(); }
}

/*============================================================
  Persistência via IndexedDB.

  Substitui localStorage (limite ~5-10MB por origem) por
  IndexedDB (limite tipicamente centenas de MB / vários GB,
  dependendo do navegador e do espaço em disco). Planilhas com
  dezenas de milhares de linhas exigem essa capacidade.

  Bônus: o algoritmo de clonagem estruturada do IndexedDB
  serializa Date e Map nativamente, então os valores tipados
  sobrevivem ao save/load sem precisar de JSON.stringify/parse.
==============================================================*/

const IDB_NAME = "kapo_analytics";
const IDB_STORE = "databases";
const IDB_VERSION = 1;

function openIDB() {
    return new Promise((resolve, reject) => {
        if (!window.indexedDB) {
            reject(new Error("IndexedDB não disponível neste navegador."));
            return;
        }
        const req = indexedDB.open(IDB_NAME, IDB_VERSION);

        req.onupgradeneeded = () => {
            const idb = req.result;
            if (!idb.objectStoreNames.contains(IDB_STORE)) {
                idb.createObjectStore(IDB_STORE);
            }
        };

        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

/**
 * Roda UMA operação numa transação e fecha a conexão ao final. Antes
 * cada save/load/clear abria uma conexão nova e nunca a fechava; além
 * disso, o delete não tratava abort (a Promise podia ficar pendurada).
 */
async function idbRequest(mode, run) {
    const idb = await openIDB();
    return new Promise((resolve, reject) => {
        let tx;
        try {
            tx = idb.transaction(IDB_STORE, mode);
        } catch (e) {
            idb.close();
            reject(e);
            return;
        }
        const req = run(tx.objectStore(IDB_STORE));
        let result;
        req.onsuccess = () => { result = req.result; };
        tx.oncomplete = () => { idb.close(); resolve(result); };
        tx.onerror = tx.onabort = () => { idb.close(); reject(tx.error || req.error); };
    });
}

const idbPut = (key, value) => idbRequest("readwrite", store => store.put(value, key)).then(() => true);
const idbGet = key => idbRequest("readonly", store => store.get(key)).then(r => r || null);
const idbDelete = key => idbRequest("readwrite", store => store.delete(key)).then(() => true);

class Database {

    constructor(raw) {
        this.metadata = raw.metadata;
        this._sheets = {};
        for (const [name, rawSheet] of Object.entries(raw.sheets)) {
            this._sheets[name] = new SheetAPI(rawSheet);
        }
    }

    static load(raw) {
        return new Database(raw);
    }

    /**
     * Salva o database completo no IndexedDB.
     * @returns {Promise<boolean>} true se salvou com sucesso.
     */
    async save(key) {
        key = key || "kapo_database";
        const serializable = { metadata: this.metadata, sheets: {} };
        for (const [name, api] of Object.entries(this._sheets)) {
            serializable.sheets[name] = api.raw;
        }
        try {
            await idbPut(key, serializable);
            return true;
        } catch (e) {
            console.error("Database.save (IndexedDB) falhou:", e);
            return false;
        }
    }

    /**
     * Carrega o database do IndexedDB.
     * @returns {Promise<Database|null>}
     */
    static async loadFromStorage(key) {
        key = key || "kapo_database";
        try {
            const raw = await idbGet(key);
            if (!raw) return null;
            return Database.load(raw);
        } catch (e) {
            console.error("Database.loadFromStorage (IndexedDB) falhou:", e);
            return null;
        }
    }

    static async clear(key) {
        try {
            await idbDelete(key || "kapo_database");
            return true;
        } catch (e) {
            console.error("Database.clear (IndexedDB) falhou:", e);
            return false;
        }
    }

    getSheets() { return Object.keys(this._sheets); }

    sheet(name) { return this._sheets[name] || null; }

    firstSheet() {
        const names = this.getSheets();
        return names.length ? this._sheets[names[0]] : null;
    }
}

if (typeof module !== "undefined" && module.exports) module.exports = { Database, SheetAPI };