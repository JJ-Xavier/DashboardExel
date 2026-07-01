/*============================================================
  analyzer.js
  Núcleo de inferência semântica.

  Responsabilidade: dado um conjunto de colunas (nome + amostra
  de valores), descobrir o PAPEL CANÔNICO de cada coluna
  (money, entityName, date, document_cpf, document_cnpj, plate,
  phone, email, percentage, id, serviceOrder, status, text,
  number) SEM depender de nomes fixos.

  Estratégia (heurística híbrida):
    1) Normaliza o nome da coluna e compara contra dicionários
       de sinônimos por papel (similaridade textual/token).
    2) Valida/objetiva por CONTEÚDO: roda testadores (regex /
       parsers) sobre uma amostra dos valores e mede o % de
       acerto (matchRatio).
    3) Combina os dois sinais com pesos -> maior pontuação vence.
       O conteúdo pesa mais que o nome, então colunas com nomes
       nunca vistos antes ainda são classificadas corretamente
       se os valores baterem com o padrão.
    4) Roles concorrentes (ex: "id" vs "serviceOrder") são
       desempatados por especificidade do testador.
==============================================================*/

const Analyzer = (() => {

    /*==================== DICIONÁRIOS DE SINÔNIMOS ====================*/
    // Cada papel tem uma lista de termos/tokens típicos. Usado apenas
    // como SINAL auxiliar - nunca como única fonte de verdade.

    const SYNONYMS = {
        money: [
            "valor", "valor total", "valor a faturar", "total", "preco", "preço",
            "vlr", "montante", "faturamento", "receita", "custo", "despesa",
            "preco unitario", "valor unitario", "valor pago", "valor liquido",
            "valor bruto", "subtotal", "amount", "price", "total geral"
        ],
        serviceCost: [
            "valor servico", "valor do servico", "custo servico", "custo do servico",
            "valor mao de obra", "custo mao de obra", "mao de obra", "valor mo",
            "custo mo", "vlr servico", "vlr mao de obra", "servicos", "mao obra",
            "valor da mao de obra", "total servico", "total mao de obra"
        ],
        partsCost: [
            "valor peca", "valor pecas", "custo peca", "custo pecas",
            "valor material", "custo material", "vlr peca", "vlr pecas",
            "pecas", "materiais", "total peca", "total pecas",
            "valor das pecas", "custo das pecas"
        ],
        entityName: [
            "cliente", "razao social", "razão social", "nome", "fornecedor",
            "nome fantasia", "contratante", "empresa", "nome cliente",
            "responsavel", "responsável", "comprador", "vendedor", "nome completo"
        ],
        date: [
            "data", "dt", "data emissao", "data emissão", "data pagamento",
            "data vencimento", "data criacao", "data criação", "data abertura",
            "data fechamento", "periodo", "período", "data cadastro"
        ],
        document_cpf: ["cpf", "documento", "doc cliente"],
        document_cnpj: ["cnpj", "documento empresa", "doc fornecedor"],
        plate: ["placa", "placa veiculo", "placa do veiculo", "plate"],
        phone: ["telefone", "celular", "contato", "fone", "whatsapp", "tel"],
        email: ["email", "e-mail", "correio eletronico"],
        percentage: ["percentual", "perc", "taxa", "desconto", "margem", "comissao", "comissão"],
        id: ["id", "codigo", "código", "cod", "identificador", "chave", "sequencial"],
        serviceOrder: ["os", "ordem de servico", "ordem de serviço", "numero os", "nr os", "n os"],
        status: ["status", "situacao", "situação", "estado", "fase"],
        modelName: ["modelo", "veiculo", "veículo", "marca modelo", "descricao item", "descrição item"],
        text: []
    };

    /*==================== TESTADORES DE CONTEÚDO ====================*/

    const TESTERS = {
        money: v => {
            const n = Utils.parseNumberSmart(v);
            if (n === null) return false;
            // strings que parecem moeda OU número decimal "normal"
            return /[r$]\$?|,\d{2}\b/i.test(String(v)) || (typeof v === "number");
        },
        date: v => Utils.parseDateSmart(v) !== null && /\d/.test(String(v)),
        document_cpf: v => /^\d{3}\.?\d{3}\.?\d{3}-?\d{2}$/.test(String(v).replace(/\s/g, "")),
        document_cnpj: v => /^\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}$/.test(String(v).replace(/\s/g, "")),
        plate: v => /^[A-Za-z]{3}-?\d[A-Za-z0-9]\d{2}$/.test(String(v).replace(/\s/g, "")),
        phone: v => /^(\+?55)?\s?\(?\d{2}\)?\s?\d{4,5}-?\d{4}$/.test(String(v).replace(/\s/g, "")),
        email: v => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v).trim()),
        percentage: v => /%\s*$/.test(String(v).trim()) || (typeof v === "number" && v >= 0 && v <= 1),
        id: v => /^[A-Za-z0-9\-_.]{1,20}$/.test(String(v).trim()) && String(v).trim() !== "",
        serviceOrder: v => /^(OS)?[\-\s]?\d{2,10}$/i.test(String(v).trim()),
        number: v => Utils.parseNumberSmart(v) !== null
    };

    // serviceCost e partsCost têm conteúdo igual a money (são valores
    // monetários); o que os diferencia é o NOME da coluna, então
    // reaproveitamos o testador de conteúdo.
    TESTERS.serviceCost = TESTERS.money;
    TESTERS.partsCost = TESTERS.money;

    /** pesos relativos de cada papel quando o conteúdo confirma fortemente */
    const SPECIFICITY = {
        document_cpf: 1.0,
        document_cnpj: 1.0,
        plate: 0.95,
        email: 1.0,
        phone: 0.85,
        serviceOrder: 0.8,
        percentage: 0.75,
        // serviceCost/partsCost são mais específicos que "money" genérico:
        // se o nome da coluna sinalizar claramente serviço ou peça, eles
        // devem vencer o papel genérico mesmo com conteúdo idêntico.
        serviceCost: 0.88,
        partsCost: 0.88,
        money: 0.7,
        date: 0.8,
        id: 0.4,        // muito genérico, fica por último no desempate
        number: 0.3,
        entityName: 0.5,
        modelName: 0.5,
        status: 0.5,
        text: 0.1
    };

    /**
     * Pontua o quanto uma coluna (nome + amostra) combina com um papel.
     */
    function scoreColumnForRole(colName, samples, role) {
        const nameNorm = Utils.normalizeText(colName);

        // sinal 1: nome
        let nameScore = 0;
        const dict = SYNONYMS[role] || [];
        for (const syn of dict) {
            const s = Utils.similarity(nameNorm, syn);
            if (s > nameScore) nameScore = s;
            // bônus se o nome inteiro contém o sinônimo como substring
            if (syn && nameNorm.includes(syn)) nameScore = Math.max(nameScore, 0.9);
        }

        // sinal 2: conteúdo
        let contentScore = 0;
        const tester = TESTERS[role];
        const hasTester = !!tester;
        if (hasTester) {
            contentScore = Utils.matchRatio(samples, tester);
        }

        const specificity = SPECIFICITY[role] !== undefined ? SPECIFICITY[role] : 0.5;

        // combinação ponderada: conteúdo pesa mais (0.65) que nome (0.35)
        // quando existe um testador de conteúdo. Papéis sem testador
        // (ex: entityName, modelName, status) dependem só do nome, então
        // usam o nameScore integralmente em vez de diluí-lo por 0.35.
        const combined = hasTester
            ? (nameScore * 0.35 + contentScore * 0.65) * (0.5 + 0.5 * specificity)
            : nameScore * (0.5 + 0.5 * specificity);

        return { role, nameScore, contentScore, combined };
    }

    /**
     * Classifica uma única coluna entre todos os papéis conhecidos
     * e retorna o melhor.
     */
    function classifyColumn(colName, samples) {
        const roles = Object.keys(SYNONYMS).concat(["number"]);
        const uniqueRoles = [...new Set(roles)];

        const scored = uniqueRoles
            .map(role => scoreColumnForRole(colName, samples, role))
            .sort((a, b) => b.combined - a.combined);

        const best = scored[0];

        // limiar mínimo de confiança; abaixo disso cai em "text"
        const role = best && best.combined >= 0.28 ? best.role : "text";

        return {
            column: colName,
            role,
            confidence: best ? Number(best.combined.toFixed(3)) : 0,
            candidates: scored.slice(0, 3)
        };
    }

    /**
     * Classifica todas as colunas de uma planilha (array de linhas-objeto).
     * Usa amostragem para performance em planilhas grandes.
     */
    function analyzeSheet(rows, sampleSize = 200) {
        if (!rows || !rows.length) return { columns: [], roleMap: {} };

        const columns = Object.keys(rows[0]);
        const step = Math.max(1, Math.floor(rows.length / sampleSize));
        const sample = [];
        for (let i = 0; i < rows.length && sample.length < sampleSize; i += step) {
            sample.push(rows[i]);
        }

        const columns_analysis = columns.map(col => {
            const samples = sample.map(r => r[col]);
            return classifyColumn(col, samples);
        });

        // resolve conflitos: se duas colunas competem fortemente pelo
        // mesmo papel "único" (ex: email, cpf), mantém a de maior confiança
        // e rebaixa as demais ao segundo melhor candidato.
        const uniqueRoles = new Set(["document_cpf", "document_cnpj", "email", "plate"]);
        const takenRoles = new Map();

        for (const c of columns_analysis.sort((a, b) => b.confidence - a.confidence)) {
            if (uniqueRoles.has(c.role)) {
                if (takenRoles.has(c.role)) {
                    const alt = c.candidates.find(cand => cand.role !== c.role);
                    c.role = alt ? alt.role : "text";
                } else {
                    takenRoles.set(c.role, c.column);
                }
            }
        }

        const roleMap = {};
        columns_analysis.forEach(c => {
            roleMap[c.role] = roleMap[c.role] || [];
            roleMap[c.role].push(c.column);
        });

        return { columns: columns_analysis, roleMap };
    }

    /**
     * Dado um "papel semântico" desejado (ex: "money"), retorna o(s)
     * nome(s) reais de coluna na planilha que correspondem.
     */
    function resolveRole(analysis, role) {
        return (analysis.roleMap[role] || []).slice();
    }

    return {
        SYNONYMS,
        TESTERS,
        classifyColumn,
        analyzeSheet,
        resolveRole
    };
})();

if (typeof module !== "undefined" && module.exports) module.exports = Analyzer;