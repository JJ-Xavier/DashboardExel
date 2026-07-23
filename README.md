# Kapo Analytics

![HTML5](https://img.shields.io/badge/HTML5-E34F26?style=for-the-badge&logo=html5&logoColor=white)
![CSS3](https://img.shields.io/badge/CSS3-1572B6?style=for-the-badge&logo=css3&logoColor=white)
![JavaScript](https://img.shields.io/badge/JavaScript-F7DF1E?style=for-the-badge&logo=javascript&logoColor=black)
![Chart.js](https://img.shields.io/badge/Chart.js-FF6384?style=for-the-badge&logo=chartdotjs&logoColor=white)
![IndexedDB](https://img.shields.io/badge/IndexedDB-4285F4?style=for-the-badge&logo=googlechrome&logoColor=white)
![No Backend](https://img.shields.io/badge/Backend-none-lightgrey?style=for-the-badge)

Dashboard de análise de dados 100% client-side: você importa uma planilha
Excel/CSV e o sistema detecta sozinho abas, colunas, tipos de dado e gera
KPIs, gráficos e filtros interativos — **sem backend, sem servidor, sem
upload para lugar nenhum**. Tudo roda no navegador.

> Também referenciado como **DashboardExel** internamente.

---

## ✨ Principais recursos

- **Importação inteligente de planilhas** (`.xlsx`, `.xls`, `.csv`)
  - Detecção automática da linha de cabeçalho, mesmo em planilhas com
    títulos/linhas em branco antes da tabela real.
  - Classificação semântica de colunas (dinheiro, contagem, percentual,
    data, identificador, status etc.) sem precisar configurar nada.
  - Suporte a múltiplas abas por arquivo, cada uma tratada de forma
    independente.
  - Detecção e correção automática de encoding de CSV (UTF-8 / Windows-1252).
  - Filtro de linhas e colunas "fantasma" geradas por formatação vazada do
    Excel.
- **Processamento fora da thread principal**
  - O parsing pesado (SheetJS, análise, estatísticas, indexação) roda em
    um **Web Worker**, então a UI nunca trava — mesmo em planilhas com
    dezenas de milhares de linhas. Há um fallback síncrono automático caso
    o navegador não suporte Workers.
- **Dashboard interativo**
  - Cards de KPI que se adaptam às colunas disponíveis em cada aba,
    agrupados e priorizados por categoria (financeiro, contagem, percentual).
  - Gráficos (via Chart.js) com rótulos que se ajustam automaticamente para
    não cortar texto.
  - Filtros multi-select com chips removíveis, contador de filtros ativos e
    filtros de intervalo numérico/data.
  - Busca global em todos os campos.
  - Tabela de detalhamento com seletor de colunas visíveis.
  - Gerenciador de abas visíveis (ocultar abas que não interessam).
- **Persistência local**
  - Os dados importados ficam salvos no **IndexedDB** do navegador, então
    ao reabrir o dashboard não é preciso importar de novo.
- **Sem backend**
  - Nenhum dado sai do navegador do usuário. Não há servidor, API ou
    banco de dados externo envolvido.

---

## 🧱 Stack

- HTML, CSS e **JavaScript puro** (sem framework/bundler)
- [SheetJS (xlsx)](https://sheetjs.com/) — leitura de planilhas
- [Chart.js](https://www.chartjs.org/) — gráficos
- Web Workers — processamento assíncrono
- IndexedDB — persistência local

---

## 📁 Estrutura do projeto

```
DashboardExel/
├── HTML/
│   ├── index.html              # Tela de importação
│   └── dashboard.html          # Tela do dashboard
├── css/
│   └── style.css
├── build/
│   └── icon.ico
├── main.js                     # Processo principal do Electron
├── package.json
└── js/
    ├── vendor/                 # Chart.js e SheetJS locais
    └── Enginemotor/
        ├── entrada.js         # Fluxo de upload/importação (tela index.html)
        ├── excelEngine.js     # Leitura e normalização de planilhas
        ├── excelWorker.js     # Web Worker que roda o pipeline de import
        ├── analyzer.js        # Classificação semântica de colunas
        ├── statistics.js      # Estatísticas por coluna
        ├── indexer.js         # Índices para busca/filtro rápidos
        ├── database.js        # Camada de acesso a dados + IndexedDB
        ├── filters.js         # Motor de filtros (multi-select, range, etc.)
        ├── charts.js          # Geração dos gráficos (Chart.js)
        ├── dashboard.js       # Orquestração da tela de dashboard
        └── utils.js           # Funções utilitárias puras
```

**Arquitetura em camadas**, do arquivo bruto até a tela:

```
Arquivo (.xlsx/.xls/.csv)
        │
        ▼
  ExcelEngine  ──► roda dentro do Web Worker
        │           (parse, detecção de cabeçalho, normalização)
        ▼
  Analyzer + Statistics + Indexer
        │           (papel semântico de cada coluna, estatísticas, índices)
        ▼
     Database        (API única de acesso; salva/lê do IndexedDB)
        │
        ▼
  Filters + Charts    (consomem a Database)
        │
        ▼
    dashboard.js       (orquestra tudo na tela)
```

`dashboard.js` é o único arquivo que conhece a UI; todo o resto é
desacoplado e reutilizável.

---

## 🚀 Como rodar localmente

Como o projeto usa **Web Workers**, ele precisa ser servido via HTTP —
abrir `HTML/index.html` direto como arquivo (`file://`) não funciona em todos
os navegadores.

Qualquer servidor estático simples resolve, por exemplo:

```bash
# Python 3
python3 -m http.server 8080

# ou Node
npx serve .
```

Depois acesse `http://localhost:8080/HTML/index.html`.

---

## 📥 Formatos suportados

| Formato | Extensão | Observações |
|---|---|---|
| Excel   | `.xlsx`, `.xls` | Múltiplas abas, datas, fórmulas |
| CSV     | `.csv` | Detecção automática de encoding (UTF-8/Windows-1252) |

**Limites atuais:**
- Arquivos acima de 200MB são bloqueados (risco de travar o navegador).
- Acima de 50MB, o usuário recebe um aviso antes de prosseguir.
- Arquivos protegidos por senha não são suportados — é preciso remover a
  proteção antes de importar.

---

## 🔒 Privacidade

Nenhum dado da planilha é enviado para qualquer servidor. Todo o
processamento (leitura, análise, cálculo de KPIs) acontece localmente no
navegador, e o armazenamento entre sessões usa o IndexedDB do próprio
navegador do usuário.

---

## 🗺️ Roadmap / ideias futuras

- Exportação de gráficos/tabelas filtradas (PDF/Excel)
- Comparativos e análises de tendência entre períodos
- Modo escuro
- Melhor responsividade para telas menores

---

## 📄 Licença

Projeto privado / uso interno. Ajuste esta seção conforme a licença que
você quiser aplicar (MIT, proprietária, etc.).