# Kapo Analytics (DashboardExel) — Documentação Técnica

> Última revisão: Jul/2026. Este documento descreve o sistema COMO ELE É
> implementado hoje — arquitetura, pipeline, modelo de dados, regras de
> negócio e validações. Ele não substitui o `README.md` (que é a porta de
> entrada rápida do projeto); este arquivo é a referência de profundidade
> para quem vai manter ou estender o código.

---

## Sumário

1. [Visão geral](#1-visão-geral)
2. [Arquitetura e fluxo de dados](#2-arquitetura-e-fluxo-de-dados)
3. [Pipeline de importação](#3-pipeline-de-importação)
4. [Modelo de dados](#4-modelo-de-dados)
5. [Papéis semânticos (catálogo)](#5-papéis-semânticos-catálogo)
6. [Regras de negócio](#6-regras-de-negócio)
7. [Regras de validação](#7-regras-de-validação)
8. [API pública (Database / SheetAPI)](#8-api-pública-database--sheetapi)
9. [Persistência](#9-persistência)
10.[Convenções de código](#10-convenções-de-código)
11.[Limitações conhecidas e decisões de design](#11-limitações-conhecidas-e-decisões-de-design)
12.[Guia de extensão](#12-guia-de-extensão)
13.[Histórico de correções relevantes](#13-histórico-de-correções-relevantes)

---

## 1. Visão geral

Kapo Analytics é um dashboard de análise de dados **100% client-side**:
o usuário importa uma planilha (Excel ou CSV), o sistema **detecta
sozinho** abas, cabeçalho, colunas e o papel de negócio de cada coluna
(dinheiro, data, cliente, status...), e gera KPIs, gráficos, filtros e
relatórios automaticamente — sem backend, sem servidor, sem upload para
lugar nenhum.

**Princípio central do projeto:** nenhum módulo de lógica de negócio
conhece nomes fixos de coluna ou de aba. Tudo é descoberto em tempo de
importação por **papel semântico** (ex.: "esta coluna é `money`", não
"esta coluna se chama VALOR_TOTAL"). Isso é o que permite o mesmo
dashboard funcionar com qualquer planilha de faturamento de oficina/frota,
mesmo que os nomes de coluna mudem entre exportações.

Toda vez que um trecho de código depende de um nome literal de coluna ou
aba (ex.: comparar `sheetApi.name === "X"`), isso é uma **exceção ao
princípio central** e deve ser tratado como tal — documentado e, sempre
que possível, substituído por uma regra estrutural (ver
[§11](#11-limitações-conhecidas-e-decisões-de-design)).

### Stack

- HTML, CSS e JavaScript puro (sem framework, sem bundler, sem build step)
- [SheetJS (xlsx)](https://sheetjs.com/) — leitura de planilhas, via CDN
- [Chart.js](https://www.chartjs.org/) — gráficos, via CDN
- Web Workers — parsing/análise fora da thread principal
- IndexedDB — persistência da base importada entre sessões
- localStorage — apenas preferências leves de UI (ver [§9](#9-persistência))

### Estrutura de arquivos

```
DashboardExel/
├── index.html                 # Tela de importação
├── dashboard.html             # Tela do dashboard
├── css/style.css
├── docs/                      # Esta documentação
└── js/Enginemotor/
    ├── entrada.js              # Fluxo de upload (tela index.html)
    ├── excelEngine.js          # Leitura e normalização de planilhas
    ├── excelWorker.js          # Web Worker que roda o pipeline de import
    ├── analyzer.js             # Classificação semântica de colunas
    ├── statistics.js           # Estatísticas por coluna
    ├── database.js             # Camada de acesso a dados + IndexedDB
    ├── filters.js              # Motor de filtros
    ├── charts.js               # Geração de gráficos (Chart.js)
    ├── dashboard.js            # Orquestração da tela de dashboard
    └── utils.js                # Funções utilitárias puras
```

---

## 2. Arquitetura e fluxo de dados

```
Arquivo (.xlsx/.xls/.csv)
        │
        ▼
  ExcelEngine  ──► roda dentro do Web Worker
        │           (parse, detecção de cabeçalho, normalização)
        ▼
  Analyzer + Statistics
        │           (papel semântico de cada coluna, estatísticas)
        ▼
     Database        (API única de acesso; salva/lê do IndexedDB)
        │
        ▼
  Filters + Charts    (consomem a Database)
        │
        ▼
    dashboard.js       (orquestra tudo na tela; único arquivo que
                         conhece o DOM)
```

Regras de dependência entre camadas:

- **`utils.js`** não depende de nada. Pode ser usado por qualquer módulo.
- **`analyzer.js`** e **`statistics.js`** dependem só de `utils.js`. Não
  conhecem Excel, DOM nem Database — recebem arrays de linhas-objeto puro.
- **`excelEngine.js`** depende de `utils.js`, `analyzer.js`,
  `statistics.js` e da global `XLSX` (SheetJS). É uma biblioteca pura —
  não conhece `Dashboard` nem `Database`.
- **`database.js`** depende de `utils.js` e `statistics.js`. É a **única**
  camada autorizada a falar com IndexedDB. `dashboard.js` só pode acessar
  dados através dela.
- **`filters.js`** depende de `utils.js` e opera sobre `SheetAPI`
  (exportado por `database.js`), nunca sobre dados crus.
- **`charts.js`** depende só de `Chart.js` (global via CDN). É a **única**
  camada autorizada a chamar `new Chart(...)`.
- **`dashboard.js`** é o único arquivo que conhece o DOM/`document`. Tudo
  o mais é reutilizável fora do navegador (testável em Node, por exemplo).

---

## 3. Pipeline de importação

Ponto de entrada: `ExcelEngine.import(file)` (`excelEngine.js`), executado
dentro de um Web Worker (`excelWorker.js`) por padrão, com fallback
síncrono na thread principal se `Worker` não estiver disponível
(`entrada.js`).

Passo a passo:

1. **Leitura do arquivo** — `file.arrayBuffer()`. Para CSV, decodifica
   tentando UTF-8 primeiro (com BOM explícito quando presente) e cai para
   Windows-1252 se a decodificação UTF-8 falhar (comum em exports de
   sistemas corporativos brasileiros).
2. **Parse via SheetJS** — `XLSX.read(...)`. Erros aqui são traduzidos
   para mensagens amigáveis (`translateReadError`): senha/proteção,
   arquivo corrompido, ou erro genérico.
3. **Para cada aba** (`parseSheet`):
   a. `sheet_to_json({ header: 1 })` → matriz bruta linha × coluna.
   b. **Detecção de cabeçalho** (`detectHeader`) — varre até
      `headerSearchRows` (20) linhas iniciais procurando a que mais
      parece um cabeçalho real (mais células de texto não vazias e não
      repetidas, seguida de uma linha que parece "dados"). Cobre
      planilhas corporativas com títulos/linhas em branco antes da
      tabela real.
   c. Linhas totalmente vazias após o cabeçalho são descartadas.
   d. Cada linha é convertida em objeto `{ coluna: valor }`, com os
      valores passando por `normalizeValue` (ver abaixo).
   e. **Remoção de colunas fantasma** (`trimGhostColumns`) — colunas
      finais sem nome real (`Coluna_N`) e sem nenhum valor em nenhuma
      linha da amostra são cortadas. Evita que formatação vazada do
      Excel (bordas/estilos arrastados) vire centenas de colunas
      processadas à toa.
   f. **Classificação semântica** — `Analyzer.analyzeSheet` (ver
      [§5](#5-papéis-semânticos-catálogo)).
   g. **Remoção de linhas fantasma** — usa o papel mais confiável entre
      `serviceOrder` / `entityName` / `id` (nessa ordem de prioridade)
      como "âncora": linhas onde a coluna-âncora está vazia são
      descartadas. Cobre fórmulas arrastadas além dos dados reais em
      planilhas financeiras (ex.: uma fórmula de imposto resultando em
      0, que sobrevive ao filtro de linha vazia mas não é um registro de
      negócio de verdade). Se a aba não tiver nenhuma coluna desses
      papéis (ex.: um resumo agregado por dia), não filtra nada — e
      nunca zera a planilha inteira mesmo que o filtro elimine tudo
      (segurança).
   h. **Estatísticas por coluna** — `Statistics.summarizeColumn` (ver
      [§4](#4-modelo-de-dados)).
4. Resultado final: `{ metadata, sheets }` — o `rawDatabase` — é enviado
   de volta pra thread principal (`postMessage`) e passado para
   `Database.load()`.

### `normalizeValue` — normalização de célula

| Valor bruto | Resultado |
|---|---|
| `undefined` | `null` |
| `Date` inválido (`NaN`) | `null` |
| `Date` válido | mantido como `Date` |
| `number` não finito (`NaN`/`Infinity`, de fórmula quebrada) | `null` |
| `number` finito | mantido |
| string vazia após `trim()` | `null` |
| erro de fórmula do Excel como texto (`#DIV/0!`, `#REF!`, `#N/A`...) | `null` |
| string não vazia | `trim()` aplicado |

---

## 4. Modelo de dados

### `rawDatabase` (saída de `ExcelEngine.import`)

```ts
{
  metadata: {
    fileName: string,
    importedAt: string,      // ISO 8601
    sheetCount: number,
    engineVersion: string
  },
  sheets: {
    [sheetName: string]: RawSheet
  }
}
```

### `RawSheet`

```ts
{
  name: string,
  columns: string[],          // nomes finais de coluna (após trim de fantasmas)
  rowCount: number,
  rows: Array<{ [coluna: string]: any }>,
  analysis: {
    columns: ColumnClassification[],
    roleMap: { [role: string]: string[] }   // papel -> colunas, ordenado por confiança desc.
  },
  statistics: { [coluna: string]: ColumnSummary }
}
```

### `ColumnClassification` (saída de `Analyzer.classifyColumn`)

```ts
{
  column: string,
  role: string,               // ver catálogo em §5; "text" é o fallback
  confidence: number,         // 0–1, arredondado a 3 casas
  candidates: Array<{ role, nameScore, contentScore, combined }> // top 3
}
```

### `ColumnSummary` (saída de `Statistics.summarizeColumn`)

Campos comuns a qualquer coluna: `column`, `role`, `count`, `nulls`,
`unique`.

- Se o papel é numérico (`money`, `number`, `percentage`): + `sum`,
  `average`, `median`, `mode`, `min`, `max`, `stddev`.
- Se o papel é `date`: + `minDate`, `maxDate`.
- Caso contrário (categórico/texto): + `mode`, `distribution` (top 12
  valores mais frequentes + bucket `"Outros"` para o resto).

### `Database` / `SheetAPI` (em memória, ver [§8](#8-api-pública-database--sheetapi))

`Database.load(rawDatabase)` envolve cada `RawSheet` numa instância de
`SheetAPI`, que é a única forma pela qual `dashboard.js` deve acessar
dados.

---

## 5. Papéis semânticos (catálogo)

Cada coluna recebe **um único papel** (`role`), escolhido por
`Analyzer.classifyColumn` combinando dois sinais:

- **Nome da coluna** (`nameScore`, 0–1) — similaridade com um dicionário
  de sinônimos por papel (`SYNONYMS`), com bônus para correspondência de
  palavra inteira.
- **Conteúdo da coluna** (`contentScore`, 0–1) — % de uma amostra que
  passa num testador de regex/parser específico do papel (`TESTERS`).

Combinação: `combined = (nameScore*0.35 + contentScore*0.65) * (0.5 + 0.5*specificity)`
para papéis com testador de conteúdo; `nameScore * (0.5 + 0.5*specificity)`
para papéis sem testador (dependem só do nome). Abaixo de
`combined = 0.28`, a coluna cai no papel `"text"` (genérico).

| Papel | O que representa | Nunca filtrável? | Indexável? |
|---|---|:-:|:-:|
| `money` | Valor monetário genérico (faturamento, total) | ✓ | — |
| `serviceCost` | Custo/valor de mão de obra ("M.O", "serviço") | ✓ | — |
| `partsCost` | Custo/valor de peças/material | ✓ | — |
| `entityName` | Nome de cliente/fornecedor/responsável | | — |
| `date` | Data (qualquer formato: BR, ISO, serial Excel) | ✓ | — |
| `document_cpf` | CPF | ✓ | — |
| `document_cnpj` | CNPJ | ✓ | — |
| `plate` | Placa de veículo | ✓ | — |
| `phone` | Telefone/celular | ✓ | — |
| `email` | E-mail | ✓ | — |
| `percentage` | Percentual/taxa/margem | ✓ | — |
| `id` | Identificador genérico curto | ✓ | — |
| `serviceOrder` | Número de O.S. | | — |
| `status` | Situação/fase do registro | | — |
| `maintenanceType` | Tipo de manutenção (Corretiva/Preventiva/Sinistro...) | | — |
| `modelName` | Modelo/descrição de veículo ou item | | — |
| `number` | Numérico genérico sem papel mais específico | ✓ | — |
| `text` | Fallback — nenhum papel bateu com confiança suficiente | | — |

> Coluna "Indexável" refere-se ao módulo `indexer.js`, que foi
> **removido do pipeline** (ver [§13](#13-histórico-de-correções-relevantes)) por não ter
> nenhum consumidor. Se uma futura necessidade de performance de filtro
> justificar reintroduzi-lo, os papéis candidatos a índice eram:
> `entityName`, `serviceOrder`, `plate`, `modelName`, `status`, `date`,
> `document_cpf`, `document_cnpj`, `id`.

### Papéis "família dinheiro" (`MONEY_ROLES`)

`money`, `serviceCost` e `partsCost` compartilham o mesmo testador de
conteúdo (`strictMoneyTester`) e recebem os mesmos ajustes de nome:

- Nome contendo `total` → bônus de nameScore (+0.15, capado em 1).
- Nome contendo `taxa` sem `total` → penalidade (−0.35) — é o componente
  de imposto/taxa, não o valor final (ex.: `VALOR TAXA PEÇAS` não deve
  competir com `PEÇAS TOTAL` pelo papel `partsCost`).
- Nome com token `mo`/`m.o` (mão de obra) → piso de 0.65 no nameScore
  para `serviceCost`, detectado por token exato (não substring — evita
  confundir com "MODELO").
- **Guard de evidência de nome:** como o testador de conteúdo aceita
  qualquer número finito (não há como distinguir "parece dinheiro" de
  "é só um número" olhando só o valor), colunas sem marcador explícito de
  moeda nas células (`R$`, ou decimal com vírgula tipo `1.234,56`) só
  recebem o papel monetário se o nome tiver evidência mínima
  (`nameScore ≥ 0.25`). Sem isso, qualquer coluna puramente numérica
  (KM, contagens, seriais) tende a "parecer dinheiro" por eliminação.
- **Tokens de contagem/medida física nunca são dinheiro:** nomes contendo
  `qtd`, `qtde`, `qde`, `qdt`, `quantidade`, `contagem`, `km`,
  `quilometragem`, `odometro`, `hodometro` (como token isolado) recebem
  penalidade forte (−0.6) nos papéis `money`/`serviceCost`/`partsCost`/
  `serviceOrder`/`id`.
- **Desempate `money` entre colunas de confiança igual:** nomes com
  `fatur*` (faturar/faturado/faturamento) recebem +0.02; nomes com
  `despesa` ou `custo` recebem −0.02. Isso decide qual coluna vira "a"
  coluna `money` da aba (`resolveColumn("money")` pega sempre a primeira
  do `roleMap`, ordenado por confiança) quando duas colunas têm nome
  igualmente forte mas significados opostos (ex.: `VALOR DESPESA TOTAL
  NO DIA` vs. `VALOR TOTAL FATURADO NO DIA`).

### `percentage`

- Conteúdo aceito: string terminando em `%`, ou número entre 0 e 2
  (não 0–1 — percentuais compostos como "faturado/despesa" podem
  legitimamente passar de 100%).
- `%` literal no nome da coluna é a evidência mais forte possível de
  percentual (nameScore = 0.95), mais forte que qualquer sinônimo textual.
- Nome contendo `valor` ou `sem` é sinal de que é um valor monetário
  disfarçado de "taxa" (ex.: `VALOR TAXA PEÇAS`), não um percentual —
  penalidade de −0.7.
- Sem marcador `%` explícito nas células, exige `nameScore ≥ 0.4` para
  evitar que contagens pequenas (0, 1, 2...) sejam confundidas com
  percentual pelo teste de faixa numérica.

### `serviceOrder`

Regex `^(OS)?[\-\s]?\d{2,10}$` — aceita qualquer sequência de 2 a 10
dígitos, com ou sem prefixo "OS". Como isso também aceita números
genéricos (ex.: KM), exige `nameScore ≥ 0.15` **ou** prefixo `"OS"`
explícito nas células como evidência de conteúdo.

### `id`

Testador muito genérico (`^[A-Za-z0-9\-_.]{1,20}$`) — qualquer
alfanumérico curto passa. Por isso é o papel de menor especificidade
(`0.4`) e só é aceito com `nameScore ≥ 0.15`.

### Desempate entre colunas concorrentes ao mesmo papel

Papéis "únicos por natureza" (`document_cpf`, `document_cnpj`, `email`,
`plate`) — se duas colunas competem fortemente pelo mesmo papel, a de
maior confiança fica com o papel; a(s) outra(s) caem pro segundo melhor
candidato (`candidates[1]`) ou `"text"`.

Papéis monetários **não** têm essa restrição — uma aba pode
legitimamente ter várias colunas `money` (ex.: `VALOR DESPESA TOTAL NO
DIA`, `VALOR TOTAL FATURADO NO DIA`, `VALOR MANUTENÇÃO FATURADO`...).
`resolveColumn("money")` sempre retorna a primeira do `roleMap.money`
(maior confiança); as demais ficam disponíveis via `resolveColumns(...)`
para uso em comparações/relatórios.

---

## 6. Regras de negócio

### 6.1 KPI "Faturamento Total" e resolução da coluna `money`

`SheetAPI.resolveColumn("money")` retorna a primeira entrada de
`roleMap.money`, que é ordenado por confiança de classificação
(descendente). Ver [§5](#5-papéis-semânticos-catálogo) para os
critérios de desempate quando duas colunas empatam.

### 6.2 Decomposição de um total em componentes (modal "Ver composição")

Ao clicar num KPI monetário clicável (hoje: só o KPI raiz `money`, os
componentes `serviceCost`/`partsCost` não são clicáveis — não faria
sentido decompor um componente em "algo abaixo dele"), `findComponentColumns`
descobre as colunas-componente (`serviceCost` + `partsCost`) e
`decomposeByComponents` reconcilia **linha a linha**:

```
para cada linha:
  target   = valor da coluna alvo (ex.: VALOR A FATURAR)
  compSum  = soma dos componentes (ex.: M.O TOTAL + PEÇAS TOTAL)
  tolerância = max(1, |target| * 1%)

  se |compSum - target| <= tolerância:
      cada componente soma normalmente na sua própria categoria
  senão:
      o valor INTEIRO da linha (não a diferença) cai no balde
      "Outros Lançamentos" — junto com O.S/cliente para contexto
```

Isso garante que as partes exibidas **sempre somam** (a centavos de
arredondamento) o total clicado — não é uma comparação solta de colunas
parecidas.

**Consumidores desta mesma regra** (têm que ficar sempre consistentes
entre si — qualquer mudança na tolerância ou no critério precisa ser
replicada nos três lugares):
1. `decomposeByComponents` — modal de composição do KPI.
2. `groupByMonthAdjustments` — gráfico "Outros Lançamentos (Evolução
   Mensal)".
3. `getAdjustmentRows` — modal de detalhamento "Ver detalhes" (lista
   linha a linha, com busca e exportação CSV).

Se a aba não tiver colunas de componente conhecidas, o modal cai num
modo de **comparação simples** com outras colunas monetárias da aba
(`MONEY_LIKE_ROLES`), deixando claro na UI que essa comparação **não**
necessariamente soma ao total.

### 6.3 Filtros automáticos por coluna categórica

Qualquer coluna categórica de baixa cardinalidade vira filtro de
seleção automaticamente, **independente do papel semântico ou nome**,
exceto papéis que nunca fazem sentido como filtro de igualdade
(`NEVER_FILTERABLE_ROLES` — ver tabela em [§5](#5-papéis-semânticos-catálogo))
e colunas com cabeçalho sintético (`Coluna_N`, geradas por célula de
cabeçalho vazia).

O teto de cardinalidade "ainda é um filtro útil" se adapta ao tamanho da
aba: `min(150, max(60, round(totalRows * 0.02)))`. Evita que a mesma
coluna categórica vire filtro numa aba pequena e suma numa aba grande.

### 6.4 Filtros de faixa numérica ("Filtros avançados")

Abas de **resumo agregado** (uma linha = um dia, por exemplo) tendem a
não ter nenhuma coluna categórica sobrando para filtro de igualdade — só
colunas numéricas. A regra é **estrutural**: se a aba não gerou nenhum
filtro de seleção categórico, todas as colunas numéricas relevantes
(`NUMERIC_RANGE_ROLES`: `money`, `serviceCost`, `partsCost`, `number`,
`percentage`) recebem filtro de faixa mín/máx, agrupados atrás do botão
"Filtros avançados". **Não depende do nome da aba.**

### 6.5 Aba padrão ao abrir o dashboard

`pickDefaultSheet` evita abrir por padrão uma aba que pareça "legada"
(nome batendo com `/antiga?|legad|legacy|hist[oó]ric/i`), preferindo a
primeira aba visível cujo nome não sinalize isso. Se todas sinalizarem,
cai de volta pra primeira mesmo assim. Nunca escolhe uma aba oculta pelo
usuário.

### 6.6 KPIs de percentual

Para até 2 colunas de papel `percentage` da aba, mostra a **média** dos
valores no recorte filtrado atual. Se o máximo da amostra for ≤ 2,
assume que os valores estão em fração (0–1/2) e escala ×100 para
exibição; caso contrário assume que já estão em escala 0–100.

### 6.7 Relatórios (aba "Relatórios")

Diferente do Dashboard, os relatórios automáticos usam **a base
completa da aba** (`currentSheet.getRows()`), não o recorte filtrado —
decisão intencional documentada no código, para que o relatório reflita
sempre o total real, independente do que está sendo explorado no
Dashboard no momento.

---

## 7. Regras de validação

### 7.1 Na tela de importação (`entrada.js`)

| Validação | Regra |
|---|---|
| Extensão | Apenas `.xlsx`, `.xls`, `.csv` |
| Arquivo vazio | Bloqueia se `file.size === 0` |
| Tamanho — bloqueio | > 200MB — bloqueia (risco real de travar o navegador) |
| Tamanho — aviso | > 50MB — pede confirmação antes de prosseguir |
| Múltiplos arquivos arrastados | Usa só o primeiro, avisa via `alert()` |
| Base sem nenhuma aba válida | `metadata.sheetCount === 0` → erro |
| Falha ao salvar no IndexedDB | Erro explícito (ex.: modo anônimo bloqueia IndexedDB) |
| Round-trip de salvamento | Após salvar, tenta recarregar (`loadFromStorage`) para confirmar que persistiu de verdade antes de redirecionar |

### 7.2 Na detecção de cabeçalho (`excelEngine.js`)

Varre até 20 linhas iniciais; se nenhuma linha tiver conteúdo não vazio,
a aba é descartada (`parseSheet` retorna `null` e a aba não entra em
`sheets`).

### 7.3 Nos valores de célula

Ver `normalizeValue` em [§3](#3-pipeline-de-importação) — erros de
fórmula do Excel e números não finitos viram `null` em vez de vazar como
texto (`"#DIV/0!"`) ou quebrar contas (`NaN`/`Infinity`).

### 7.4 Na classificação semântica

Ver guards de evidência de nome em [§5](#5-papéis-semânticos-catálogo) —
critério geral: **um testador de conteúdo permissivo demais (aceita
"quase qualquer coisa") nunca pode, sozinho, decidir um papel de alto
impacto** (dinheiro, ordem de serviço, id). Nesses casos, exige-se
evidência mínima de nome OU um marcador inequívoco no próprio valor
(símbolo de moeda, prefixo "OS", símbolo `%`).

---

## 8. API pública (Database / SheetAPI)

```js
const db = Database.load(rawDatabaseFromEngine);
db.getSheets();                    // -> ["BASE CARROS", ...]
db.sheet("BASE CARROS");           // -> SheetAPI | null
db.firstSheet();

await db.save(key?);               // -> boolean
await Database.loadFromStorage(key?);  // -> Database | null
await Database.clear(key?);

const sheet = db.sheet("BASE CARROS");
sheet.getRows();
sheet.getColumns();
sheet.getColumnRoles();            // [{ column, role, confidence, candidates }]

sheet.resolveColumn("money");      // aceita papel OU nome literal
sheet.resolveColumns("percentage"); // todas as colunas desse papel

sheet.sum("money");
sheet.average("money");
sheet.min/max/median("money");
sheet.unique("entityName");
sheet.statisticsFor("money");      // -> ColumnSummary
sheet.groupBy("status");           // -> [{ group, count, sum?, average? }]

sheet.filter([{ role: "status", op: "=", value: "Aberto" }]);
// operadores: =, !=, in, >, <, >=, <=, contains, between, dateBetween
sheet.search("joão", { rows?, limit? });
```

---

## 9. Persistência

Dois mecanismos, propositalmente separados por escopo:

| Mecanismo | Guarda | Chave | Escopo |
|---|---|---|---|
| **IndexedDB** (`kapo_analytics` / store `databases`) | A base importada inteira (`rawDatabase`) | `kapo_database` | Grande volume — dezenas de milhares de linhas |
| **localStorage** (`kapo_column_prefs`) | Colunas visíveis escolhidas manualmente, por nome de aba | — | Preferência leve de UI |
| **localStorage** (`kapo_hidden_sheets`) | Abas ocultadas manualmente pelo usuário | — | Preferência leve de UI |

IndexedDB foi escolhido para os dados em vez de `localStorage` pelo
limite de tamanho (`localStorage` ~5-10MB por origem vs. centenas de
MB/GB do IndexedDB) — necessário para planilhas como `BASE CARROS`
(~103 mil linhas).

---

## 10. Convenções de código

- **Módulos:** IIFE com objeto de retorno (`const X = (() => {...; return
  {...} })()`) para os módulos "biblioteca" (`Utils`, `Analyzer`,
  `Statistics`, `Filters`, `Charts`). `class` para os que representam uma
  instância com estado (`ExcelEngine`, `Database`, `SheetAPI`).
  `dashboard.js` e `entrada.js` são IIFEs de efeito colateral (`(function
  () {...})()`), não módulos exportáveis.
- **Sem framework, sem build step.** Scripts carregados via `<script>` em
  ordem de dependência direta no HTML (ver ordem exata nos `<head>`/fim
  do `<body>` de cada página).
- **CommonJS opcional:** todo módulo termina com
  `if (typeof module !== "undefined" && module.exports) module.exports = X;`
  — permite `require(...)` em Node para testes/scripts, sem afetar o
  comportamento no navegador.
- **Progresso assíncrono:** `Utils.EventBus` (pub/sub simples) é o único
  mecanismo de eventos do projeto — usado pelo `ExcelEngine` para
  reportar progresso de importação.
- **Formatação de exibição:** sempre via `Utils.formatMoney`,
  `Utils.formatNumber`, `Utils.formatDate` (padrão `pt-BR`). Nunca
  formatar valores "na mão" fora de `utils.js`.
- **Escape de HTML:** toda interpolação de valor de planilha em HTML
  passa por `escapeHtml` (definida uma única vez em `dashboard.js`) antes
  de entrar em `innerHTML`.

---

## 11. Limitações conhecidas e decisões de design

Itens que são **compromissos conscientes**, não bugs — mas que merecem
ficar documentados para quem for mexer no código não reintroduzir o
problema que eles evitam, ou não confundir com um problema não resolvido:

- **O testador de conteúdo de `money` não consegue, sozinho, provar que
  um número é dinheiro.** Qualquer número finito "parece" dinheiro pelo
  testador; a diferenciação real depende do nome da coluna (guard de
  evidência — [§5](#5-papéis-semânticos-catálogo)). Se uma planilha
  nova tiver uma coluna monetária com nome muito genérico e sem nenhum
  componente de valor formatado como texto (`"R$ ..."`), ela pode cair
  como `number` em vez de `money`. **Mitigação ao encontrar esse caso:**
  adicionar o termo ao dicionário `SYNONYMS.money` em vez de afrouxar o
  guard globalmente.
- **`NUMERIC_RANGE_ROLES` e `NEVER_FILTERABLE_ROLES` (filters.js) são
  listas fixas de papéis**, não de nomes de aba/coluna — isso é
  aceitável porque papéis são um vocabulário fechado e estável definido
  pelo próprio `Analyzer`, diferente de nomes de aba/coluna que variam
  por planilha.
- **Tabela de detalhamento limita a 200 linhas renderizadas**
  (`renderTable`), independente do total filtrado — decisão de
  performance de DOM, não de dado (o contador `rowCountLabel` sempre
  mostra o total real filtrado, não as 200 exibidas).
- **`Filters` é um módulo com estado singleton** (não uma instância por
  aba). Trocar de aba exige chamar `Filters.clearAll()` explicitamente
  (feito em todos os pontos de troca de aba em `dashboard.js`) — se um
  novo ponto de troca de aba for adicionado no futuro, ele **precisa**
  fazer o mesmo, ou filtros de uma aba vazam pra outra.
- **Cache de filtro por `SheetAPI` (`_filterCache`) tem teto de 50
  entradas**, com limpeza total ao estourar (não LRU parcial) — trade-off
  simples de implementar; suficiente porque recomputar um filtro é
  barato comparado ao custo de manter o cache.
- **Detecção de aba "legada"** (`pickDefaultSheet`) e o corte de
  cardinalidade de filtro automático são heurísticas calibradas para o
  vocabulário em português do domínio (oficina/frota). Uma planilha em
  outro idioma ou domínio muito diferente pode exigir ajuste nos regexes/
  dicionários — não é um bug, é o limite esperado de uma heurística.

---

## 12. Guia de extensão

### Adicionar um novo papel semântico

1. `analyzer.js`: adicionar entrada em `SYNONYMS` (lista de termos/nome)
   e, se o papel precisar de validação de conteúdo, em `TESTERS`
   (função `valor -> boolean`).
2. Definir `SPECIFICITY` (0–1: quão exclusivo/confiável é esse papel
   quando o conteúdo bate).
3. Se o papel nunca deve ser filtro de igualdade (ex.: é numérico ou de
   alta cardinalidade), adicionar a `NEVER_FILTERABLE_ROLES` em
   `filters.js`.
4. Se for um papel monetário-like, adicionar a `MONEY_LIKE_ROLES` em
   `dashboard.js` para entrar nas comparações do modal de KPI.
5. Testar a classificação contra dados reais antes de mexer em produção
   (ver script de teste isolado em [§13](#13-histórico-de-correções-relevantes) como referência —
   `Analyzer.classifyColumn(nome, amostraDeValores)` roda em Node puro,
   sem DOM).

### Adicionar um novo gráfico/relatório automático

Seguir o padrão de `renderCharts`/`renderReports` em `dashboard.js`:
resolver as colunas necessárias via `resolveColumn(role)`, só desenhar
o card se as colunas existirem (`if (moneyCol && dateCol) {...}`), nunca
assumir nome de coluna.

---

## 13. Histórico de correções relevantes

**Jul/2026 — revisão completa do projeto**, aplicada e validada
rodando o `Analyzer` contra a planilha real de faturamento (9 abas,
incl. `BASE CARROS` com ~103 mil linhas):

- Corrigido: "Faturamento Total" somando a coluna de **despesa** em vez
  de faturamento nas abas `RESUMO POR DIA CARROS`/`MOTO` (empate de
  confiança entre `VALOR DESPESA TOTAL NO DIA` e `VALOR TOTAL FATURADO
  NO DIA`, desempatado por ordem de coluna em vez de significado).
- Corrigido: colunas de contagem (`QTD MANUT...`, `QDT SINISTRO`)
  classificadas como `serviceCost`/`partsCost`, aparecendo como cards de
  custo em R$.
- Corrigido: coluna `KM` (odômetro) classificada como `money`, exibida
  como moeda na tabela de detalhamento.
- Corrigido: percentuais acima de 100% (`% Faturado Sinistro`, ~45% dos
  valores reais da coluna) sendo rejeitados pelo testador de percentual
  e caindo em outro papel.
- Implementado: KPIs de percentual (existia um array `percentual`
  declarado e mesclado no resultado final, mas nunca preenchido).
- Removido do pipeline: `Indexer` (`indexer.js`) — construía índices por
  papel em toda importação, persistidos no IndexedDB, sem nenhum
  consumidor real (`Indexer.lookup` nunca era chamado — todo filtro
  sempre foi scan linear via `SheetAPI`).
- Substituído: `NUMERIC_RANGE_SHEETS` (lista fixa de nomes de aba) por
  detecção estrutural (aba sem filtro categórico → filtros de faixa
  numérica), removendo o acoplamento a nomes fixos de aba.
- Corrigido: função `escapeHtml` duplicada em `dashboard.js` (a segunda
  sobrescrevia a primeira silenciosamente).
- Padronizado: rótulos de mês nos gráficos (`"2026-01"` → `"Jan/2026"`,
  igual ao modal de KPI).
- Adicionado: teto de 50 entradas no cache de filtro por `SheetAPI`.
- Removido: link "Histórico" morto na sidebar (sem `data-view`/`href`).
- Adicionado: `.gitattributes` (`eol=lf`) para parar divergência de
  quebra de linha entre as duas máquinas de trabalho.