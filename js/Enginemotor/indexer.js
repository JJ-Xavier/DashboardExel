/*============================================================
  indexer.js
  Cria índices (Map de valor -> lista de índices de linha) para
  os papéis semânticos mais usados em filtros/buscas, permitindo
  lookup O(1) em vez de scan completo a cada filtro.

  Os índices são criados por PAPEL SEMÂNTICO (ex: "entityName",
  "status", "serviceOrder", "plate", "date"...) e não por nome
  fixo de coluna, então continuam funcionando mesmo que a
  planilha mude os nomes das colunas.
==============================================================*/

const Indexer = (() => {

    const INDEXABLE_ROLES = [
        "entityName", "serviceOrder", "plate", "modelName",
        "status", "date", "document_cpf", "document_cnpj", "id"
    ];

    /**
     * Constrói índices para um sheet já analisado.
     * @param {Array<Object>} rows
     * @param {Object} roleMap - { role: [colNames] } vindo do Analyzer
     * @returns {Object} indexes - { role: { colName: Map(value -> number[]) } }
     */
    function buildIndexes(rows, roleMap) {
        const indexes = {};

        for (const role of INDEXABLE_ROLES) {
            const cols = roleMap[role];
            if (!cols || !cols.length) continue;

            indexes[role] = {};

            for (const col of cols) {
                const map = new Map();
                // cache de parse de data por valor bruto: a mesma data (ex: um
                // dia inteiro de faturamento) costuma repetir em milhares de
                // linhas, então parseDateSmart só roda uma vez por valor único.
                const dateKeyCache = role === "date" ? new Map() : null;

                rows.forEach((row, i) => {
                    let key = row[col];
                    if (key === null || key === undefined || key === "") return;

                    if (role === "date") {
                        const cacheKey = key instanceof Date ? key.getTime() : key;
                        let resolved = dateKeyCache.get(cacheKey);
                        if (resolved === undefined) {
                            const d = Utils.parseDateSmart(key);
                            resolved = d ? d.toISOString().slice(0, 10) : null;
                            dateKeyCache.set(cacheKey, resolved);
                        }
                        key = resolved;
                        if (!key) return;
                    } else {
                        key = String(key).trim();
                    }

                    if (!map.has(key)) map.set(key, []);
                    map.get(key).push(i);
                });

                indexes[role][col] = map;
            }
        }

        return indexes;
    }

    /**
     * Busca rápida por igualdade usando índice, com fallback
     * para scan linear se o índice não existir.
     */
    function lookup(indexes, role, col, value) {
        const map = indexes?.[role]?.[col];
        if (!map) return null; // sinaliza "sem índice disponível"
        return map.get(String(value).trim()) || [];
    }

    return { INDEXABLE_ROLES, buildIndexes, lookup };
})();

if (typeof module !== "undefined" && module.exports) module.exports = Indexer;