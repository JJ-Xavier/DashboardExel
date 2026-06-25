const dropZone = document.getElementById('dropZone');
const fileInput = document.getElementById('fileInput');
const filePreview = document.getElementById('filePreview');
const mappingSection = document.getElementById('mappingSection');
const divider = document.getElementById('divider');
const removeBtn = document.getElementById('removeFile');

let arquivoAtual = null; // Variável para armazenar o arquivo selecionado

// Eventos de seleção e Drag and Drop
fileInput.addEventListener('change', e => { 
  if (e.target.files[0]) processFileSelection(e.target.files[0]); 
});

dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('dragover'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
dropZone.addEventListener('drop', e => {
  e.preventDefault();
  dropZone.classList.remove('dragover');
  if (e.dataTransfer.files[0]) processFileSelection(e.dataTransfer.files[0]);
});

function processFileSelection(file) {
  arquivoAtual = file;
  document.getElementById('fileName').textContent = file.name;
  
  const kb = file.size / 1024;
  const size = kb > 1024 ? (kb/1024).toFixed(1) + ' MB' : kb.toFixed(0) + ' KB';
  document.getElementById('fileSize').textContent = size + ' • Aguardando leitura...';
  
  filePreview.classList.add('visible');
  mappingSection.classList.add('visible');
  divider.style.display = 'none';
}

removeBtn.addEventListener('click', () => {
  arquivoAtual = null;
  filePreview.classList.remove('visible');
  mappingSection.classList.remove('visible');
  divider.style.display = 'flex';
  fileInput.value = '';
});

// FUNÇÃO PRINCIPAL QUE LÊ A PLANILHA E GERA O DASHBOARD
function startUpload() {
  if (!arquivoAtual) return alert("Por favor, selecione um arquivo primeiro.");

  // Mostra a tela de carregamento (você já tinha criado essa interface visual no HTML)
  const overlay = document.getElementById('progressOverlay');
  if (overlay) overlay.classList.add('visible');

  // Inicia o leitor de arquivos do HTML5
  const reader = new FileReader();

  reader.onload = function(e) {
    try {
      // 1. Converte o arquivo binário para um Workbook do Excel
      const data = new Uint8Array(e.target.result);
      const workbook = XLSX.read(data, { type: 'array' });

      // 2. Pega a primeira aba da planilha
      const primeiraAbaNome = workbook.SheetNames[0];
      const primeiraAba = workbook.Sheets[primeiraAbaNome];

      // 3. Converte a aba do Excel para um Array de Objetos JSON
      const dadosPlanilha = XLSX.utils.sheet_to_json(primeiraAba);
      
      console.log("DADOS REAIS EXTRAÍDOS DA PLANILHA:", dadosPlanilha);

      // 4. Converte os dados brutos da planilha na estrutura que o Dashboard entende
      const dadosDashboard = estruturarDadosParaDashboard(dadosPlanilha, arquivoAtual.name);

      // 5. Salva no localStorage para o Dashboard.js resgatar
      localStorage.setItem('findash_real_data', JSON.stringify(dadosDashboard));

      // 6. Simula um tempinho de processamento para a barra de progresso (visual) e redireciona
      setTimeout(() => {
        window.location.href = 'Dashboard.html';
      }, 1500);

    } catch (error) {
      console.error("Erro ao ler arquivo:", error);
      alert("Ocorreu um erro ao processar o arquivo. Certifique-se de que é um Excel ou CSV válido.");
      if (overlay) overlay.classList.remove('visible');
    }
  };

  // Executa a leitura como ArrayBuffer (melhor para Excel)
  reader.readAsArrayBuffer(arquivoAtual);
}

// FUNÇÃO ADAPTADORA (Traduz a Planilha para o Dashboard)
function estruturarDadosParaDashboard(dadosPlanilha, nomeArquivo) {
  // NOTA: Como ainda não sabemos quais são as colunas exatas da sua planilha, 
  // estou gerando dados baseados na quantidade de linhas da planilha lida 
  // para provar que a integração de ponta a ponta está funcionando!
  
  const totalLinhas = dadosPlanilha.length;
  const valorFicticioReceita = (totalLinhas * 1.5).toFixed(0);
  const valorFicticioCusto = (totalLinhas * 0.8).toFixed(0);

  return {
    periodo: "Arquivo processado: " + nomeArquivo,
    kpis: {
      receitaTotal: `R$ ${valorFicticioReceita}K`,
      custoTotal: `R$ ${valorFicticioCusto}K`,
      margemLiquida: "34,5%",
      budgetUtilizado: "82%"
    },
    graficoEvolucao: {
      meses: ['Mês 1', 'Mês 2', 'Mês 3', 'Mês 4', 'Mês 5', 'Mês 6'],
      receitas: [30, 45, 60, 50, 70, valorFicticioReceita / 2],
      custos: [20, 30, 40, 35, 45, valorFicticioCusto / 2],
      margens: [33, 33, 33, 30, 35, 40]
    },
    graficoDonut: {
      categorias: ['Operacional', 'Marketing', 'RH', 'Infraestrutura'],
      valores: [40, 25, 20, 15]
    },
    departamentos: [
      { nome: "Vendas", realizado: "R$ 40K", orcado: "R$ 45K", status: "No Orçamento", classeStatus: "status-ok" },
      { nome: "Marketing", realizado: "R$ 35K", orcado: "R$ 30K", status: "Estourado", classeStatus: "status-over" }
    ],
    metas: [
      { titulo: "Redução de custos", porcentagem: 62, cor: "var(--green-500)", atual: "R$ 186K", alvo: "R$ 300K" }
    ]
  };
}