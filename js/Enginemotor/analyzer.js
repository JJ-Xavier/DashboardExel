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
        // Datas em Excel são armazenadas como serial numérico (dias desde
        // 1899-12-30). QUALQUER número parseia "com sucesso" nesse esquema
        // — inclusive contagens pequenas (0, 1, 2...) e percentuais (0.65,
        // 1.3), que originalmente passavam neste teste e faziam colunas
        // como "QDT SINISTRO" ou "% Faturado" serem confundidas com data.
        // Um serial de data real de uso comum (anos ~1950–2100) fica
        // sempre acima de ~18000; abaixo disso é quase certamente uma
        // contagem/percentual, não uma data.
        date: v => {
            if (typeof v === "number") return v >= 18000 && v <= 80000;
            return Utils.parseDateSmart(v) !== null && /\d/.test(String(v));
        },
        document_cpf: v => /^\d{3}\.?\d{3}\.?\d{3}-?\d{2}$/.test(String(v).replace(/\s/g, "")),
        document_cnpj: v => /^\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}$/.test(String(v).replace(/\s/g, "")),
        plate: v => /^[A-Za-z]{3}-?\d[A-Za-z0-9]\d{2}$/.test(String(v).replace(/\s/g, "")),
        phone: v => /^(\+?55)?\s?\(?\d{2}\)?\s?\d{4,5}-?\d{4}$/.test(String(v).replace(/\s/g, "")),
        email: v => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v).trim()),
        // Percentuais armazenados como fração podem legitimamente passar de
        // 100% (ex.: "% Faturado Sinistro" = faturado/despesa do dia, que
        // fica acima de 1.0 quando o faturado supera a despesa). O teto de
        // 1 rejeitava metade dos valores reais dessas colunas e derrubava
        // o contentScore de percentual; teto 2 cobre esses casos sem abrir
        // demais para contagens grandes.
        percentage: v => /%\s*$/.test(String(v).trim()) || (typeof v === "number" && v >= 0 && v <= 2),
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

    // Tokens de nome que indicam CONTAGEM ou MEDIDA FÍSICA — nunca um
    // valor em R$. Sem essa lista, colunas como "QTD MANUT PREVENTIVA E
    // CORRETIVA" (contagem de manutenções) ou "KM" (odômetro) acabavam
    // classificadas como custo/dinheiro só porque o conteúdo é numérico,
    // e apareciam no dashboard formatadas como "R$ 29.730,00".
    const NON_MONETARY_NAME_TOKENS = new Set([
        "qtd", "qtde", "qde", "qdt", "quantidade", "contagem",
        "km", "quilometragem", "odometro", "hodometro"
    ]);

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
            // bônus se o nome inteiro contém o sinônimo como PALAVRA
            // (fronteira de espaço), não como substring cru — sinônimos
            // curtos como "dt" (data) ou "os" (ordem de serviço) batiam
            // dentro de qualquer palavra que os contivesse por acidente
            // (ex.: "QDT SINISTRO" contém "dt", "CUSTOS" contém "os"),
            // classificando colunas erradas com o papel.
            if (syn && new RegExp(`(^| )${syn.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}( |$)`).test(nameNorm)) {
                nameScore = Math.max(nameScore, 0.9);
            }
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

            // O símbolo "%" no próprio nome da coluna ("% Faturado manut")
            // é a evidência mais direta possível de percentual — mais
            // forte que qualquer sinônimo. Sem isso, essas colunas
            // dependiam de similaridade fuzzy com "percentual"/"taxa",
            // que quase nunca bate, e perdiam para papéis monetários.
            if (/%/.test(nameNorm)) nameScore = Math.max(nameScore, 0.95);
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

            // "%" no nome indica percentual, não dinheiro ("% Faturado
            // manut" estava vencendo como money porque contém "faturado").
            if (/%/.test(nameNorm)) {
                nameScore = Math.max(0, nameScore - 0.5);
            }
        }

        // Nomes com token de contagem/medida física ("QTD ...", "QDT
        // SINISTRO", "KM") nunca são dinheiro, ordem de serviço nem
        // identificador — são contagens/medidas. A penalidade derruba o
        // nameScore abaixo dos guards de evidência de nome logo abaixo.
        // Vale para serviceOrder e id também (e não só papéis monetários)
        // porque ambos são papéis-ÂNCORA do filtro de linhas fantasma do
        // ExcelEngine e papéis indexáveis: uma contagem classificada como
        // serviceOrder faria linhas legítimas com contagem vazia serem
        // descartadas da planilha silenciosamente.
        if (MONEY_ROLES.has(role) || role === "serviceOrder" || role === "id") {
            const nameTokens = nameNorm.split(" ");
            if (nameTokens.some(t => NON_MONETARY_NAME_TOKENS.has(t))) {
                nameScore = Math.max(0, nameScore - 0.6);
            }
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

        // O testador de conteúdo de "money" aceita qualquer número finito —
        // ou seja, para colunas de números "puros" (KM, contagens, seriais)
        // o conteúdo NÃO diferencia dinheiro de outra coisa. Nesses casos,
        // só marcadores explícitos nas células ("R$", decimal com vírgula
        // no fim: "1.234,56") tornam o conteúdo informativo; sem eles,
        // exige um mínimo de evidência de NOME antes de aceitar o papel.
        // Foi isso que fazia "KM" (odômetro) virar money e aparecer como
        // "R$ 29.730,00" na tabela de detalhamento.
        if (role === "money") {
            const hasMoneyMarkers = samples.some(v =>
                typeof v === "string" && /r\$|\d,\d{2}\s*$/i.test(String(v).trim())
            );
            if (!hasMoneyMarkers && nameScore < 0.25) {
                return { role, nameScore, contentScore: 0, combined: 0 };
            }
        }

        // Mesmo raciocínio para serviceOrder: o testador aceita qualquer
        // sequência de 2-10 dígitos, então números genéricos (KM, códigos)
        // "passam". Só o prefixo "OS" explícito nos valores torna o
        // conteúdo informativo por si só; caso contrário exige nome.
        if (role === "serviceOrder" && nameScore < 0.15) {
            const hasOsPrefix = samples.some(v => /^os[\-\s]?\d/i.test(String(v).trim()));
            if (!hasOsPrefix) {
                return { role, nameScore, contentScore: 0, combined: 0 };
            }
        }

        // E para percentage: números entre 0 e 2 são também o formato de
        // contagens pequenas (0, 1, 2 sinistros no dia...). Sem "%"
        // explícito nas células, exige evidência forte de nome ("%" no
        // nome, ou sinônimo como "taxa"/"percentual" com match de palavra).
        if (role === "percentage" && nameScore < 0.4) {
            const hasPercentMarkers = samples.some(v => /%\s*$/.test(String(v).trim()));
            if (!hasPercentMarkers) {
                return { role, nameScore, contentScore: 0, combined: 0 };
            }
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

        // Desempate para o papel "money": o dashboard usa a PRIMEIRA
        // coluna money do roleMap como "Faturamento Total", então a ordem
        // importa. Nomes com "fatur*" (faturar, faturado, faturamento) são
        // semanticamente RECEITA e ganham um incremento pequeno; nomes com
        // "despesa"/"custo" são o lado oposto e perdem o mesmo tanto.
        // Sem isso, "VALOR DESPESA TOTAL NO DIA" e "VALOR TOTAL FATURADO
        // NO DIA" empatavam exatamente (0.85) e quem vencia era a ordem
        // física das colunas na planilha — e o card "Faturamento Total"
        // das abas de resumo diário somava DESPESA em vez de faturamento.
        // Incrementos aplicados após o cap de nameScore, de propósito,
        // para desempatar empates exatos.
        let finalCombined = combined;
        if (role === "money") {
            if (/fatur/.test(nameNorm)) finalCombined += 0.02;
            if (/\bdespesa\b|\bcusto/.test(nameNorm)) finalCombined -= 0.02;
        }

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