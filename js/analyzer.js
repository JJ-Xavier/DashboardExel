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
        maintenanceType: [
            "tipo de manutencao", "tipo de manutenção", "tipo de os", "tipo os",
            "tipo de o.s", "categoria de servico", "categoria de serviço",
            "natureza do atendimento", "natureza atendimento", "classificacao da os",
            "classificação da os", "tipo de atendimento", "tipo atendimento"
        ],
        modelName: ["modelo", "veiculo", "veículo", "marca modelo", "descricao item", "descrição item"],
        text: []
    };

    /*==================== TESTADORES DE CONTEÚDO ====================*/

    const TESTERS = {
        date: v => Utils.parseDateSmart(v) !== null && /\d/.test(String(v)),
        document_cpf: v => /^\d{3}\.?\d{3}\.?\d{3}-?\d{2}$/.test(String(v).replace(/\s/g, "")),
        document_cnpj: v => /^\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}$/.test(String(v).replace(/\s/g, "")),
        plate: v => /^[A-Za-z]{3}-?\d[A-Za-z0-9]\d{2}$/.test(String(v).replace(/\s/g, "")),
        phone: v => /^(\+?55)?\s?\(?\d{2}\)?\s?\d{4,5}-?\d{4}$/.test(String(v).replace(/\s/g, "")),
        email: v => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v).trim()),
        percentage: v => /%\s*$/.test(String(v).trim()) || (typeof v === "number" && v >= 0 && v <= 1),
        // "id" é um papel MUITO genérico via conteúdo (qualquer texto
        // alfanumérico curto bate). Sem essa restrição de comprimento e
        // sem exigir evidência de nome (ver guarda mais abaixo), colunas
        // categóricas como "TIPO DE MANUTENÇÃO" (valores: CORRETIVA,
        // PREVENTIVA...) acabavam classificadas como "id" por acidente.
        id: v => /^[A-Za-z0-9\-_.]{1,20}$/.test(String(v).trim()) && String(v).trim() !== "",
        serviceOrder: v => /^(OS)?[\-\s]?\d{2,10}$/i.test(String(v).trim()),
        number: v => Utils.parseNumberSmart(v) !== null,
        // Vocabulário de domínio (oficina/frota): reconhece o CONTEÚDO
        // típico de uma coluna de tipo de manutenção/O.S, independente
        // do nome da coluna usado na planilha.
        maintenanceType: v => {
            const s = Utils.normalizeText(v);
            return [
                "corretiva", "preventiva", "sinistro", "preditiva", "revisao",
                "emergencial", "garantia", "recall", "instalacao", "corretivo",
                "preventivo", "manutencao programada", "revisao programada"
            ].includes(s);
        }
    };

    /**
     * Testador RÍGIDO para valores monetários: a célula inteira (após
     * remover símbolo de moeda e espaços) precisa ser um número puro.
     * `parseNumberSmart` sozinho é permissivo demais para uso como
     * testador de conteúdo — ele extrai dígitos de QUALQUER string,
     * então um texto descritivo como "MOTOCICLETA ... 0149 CC" também
     * "parseava" como número e contaminava colunas de texto/categóricas
     * com o papel de custo. Este testador exige que a célula, do início
     * ao fim, pareça um valor numérico/monetário — nunca um trecho
     * embutido em texto livre.
     */
    const STRICT_MONEY_PATTERN =
        /^-?\s*r?\$?\s*-?\s*\d{1,3}(\.\d{3})*(,\d{1,2})?$|^-?\s*r?\$?\s*-?\s*\d+([.,]\d{1,2})?$/i;

    function strictMoneyTester(v) {
        if (typeof v === "number") return isFinite(v);
        const s = String(v).trim();
        if (s === "-" || s === "—" || s === "") return true; // célula "vazia" representando zero
        return STRICT_MONEY_PATTERN.test(s);
    }

    TESTERS.money = strictMoneyTester;

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
        maintenanceType: 0.6,
        text: 0.1
    };

    const MONEY_ROLES = new Set(["money", "serviceCost", "partsCost"]);

    /**
     * Pontua o quanto uma coluna (nome + amostra) combina com um papel.
     *
     * Para papéis monetários, aplica dois ajustes importantes em
     * planilhas com colunas "componentes" (comum em bases financeiras):
     *   - Bônus para nomes com "total" (valor final, já consolidado).
     *   - Penalidade para nomes com "taxa" sem "total" (é o COMPONENTE
     *     de imposto/taxa, não o valor final — ex: "VALOR TAXA PEÇAS"
     *     não deve competir com "PEÇAS TOTAL" pelo papel partsCost).
     * Isso evita que colunas de imposto/subtotal empatem com a coluna
     * de total real e sejam escolhidas por sorte de ordem de coluna.
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

        // O papel "percentage" tem "taxa" como sinônimo (para pegar colunas
        // de alíquota, ex: "TAXA" = 30%). Porém "taxa" também aparece em
        // nomes de colunas monetárias que representam o IMPOSTO EM R$, não
        // a alíquota em si (ex: "M.O SEM TAXA", "VALOR TAXA M.O"). Nomes
        // com "valor" ou "sem" combinados com "taxa" indicam claramente um
        // valor monetário, não uma taxa percentual — penaliza fortemente
        // para essas colunas não roubarem o papel de colunas de custo.
        if (role === "percentage") {
            const looksMonetary = /\bvalor\b/.test(nameNorm) || /\bsem\b/.test(nameNorm);
            if (looksMonetary) nameScore = Math.max(0, nameScore - 0.7);
        }

        if (MONEY_ROLES.has(role)) {
            // abreviação comum em oficinas: "M.O" = Mão de Obra.
            // Detectado por TOKEN exato (não substring), para não
            // confundir com palavras como "MODELO" (que também contém "mo").
            // Aplicado ANTES dos modificadores de total/taxa abaixo, para
            // servir apenas como sinal de "família" (é uma coluna de M.O.)
            // sem apagar a diferenciação entre a variante total, a variante
            // sem-taxa e a variante de imposto dessa mesma família.
            if (role === "serviceCost") {
                const tokens = nameNorm.split(" ");
                const hasMOToken = tokens.includes("mo") ||
                    tokens.some((t, i) => t === "m" && tokens[i + 1] === "o");
                if (hasMOToken) nameScore = Math.max(nameScore, 0.65);
            }

            const hasTotal = /\btotal\b/.test(nameNorm);
            const hasTaxa = /\btaxa\b/.test(nameNorm);

            if (hasTotal) nameScore = Math.min(1, nameScore + 0.15);
            if (hasTaxa && !hasTotal) nameScore = Math.max(0, nameScore - 0.35);
        }

        // serviceCost, partsCost e id são papéis MUITO específicos (custo
        // de mão de obra / custo de peças / identificador). Não é
        // razoável atribuí-los a uma coluna só porque o CONTEÚDO parece
        // compatível — isso faria colunas genéricas como "KM" (odômetro)
        // ou qualquer texto curto (ex: "CORRETIVA") vencer esse papel por
        // acidente, já que o testador de "id" aceita qualquer alfanumérico
        // curto. Exige um mínimo de evidência de NOME antes de permitir
        // que o conteúdo decida sozinho.
        if ((role === "serviceCost" || role === "partsCost" || role === "id") && nameScore < 0.15) {
            return { role, nameScore, contentScore: 0, combined: 0 };
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

        // Desempate: "VALOR A FATURAR" é semanticamente o total final da
        // fatura (mais autoritativo que qualquer outra coluna chamada só
        // de "TOTAL"). Aplicado como incremento pequeno e NÃO limitado
        // pelo cap de nameScore, para garantir que sempre vença empates
        // exatos contra colunas concorrentes do papel "money".
        const finalCombined = (role === "money" && /faturar/.test(nameNorm))
            ? combined + 0.02
            : combined;

        return { role, nameScore, contentScore, combined: finalCombined };
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