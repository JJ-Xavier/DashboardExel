// Variável global para segurar o arquivo selecionado pelo usuário
let arquivoSelecionado = null;

// Aguarda os elementos do HTML carregarem na tela
document.addEventListener('DOMContentLoaded', () => {
  const dropZone = document.getElementById('dropZone');
  const fileInput = document.getElementById('fileInput');
  const filePreview = document.getElementById('filePreview');
  const mappingSection = document.getElementById('mappingSection');
  const divider = document.getElementById('divider');
  const removeBtn = document.getElementById('removeFile');

  if (fileInput) {
    fileInput.addEventListener('change', e => { if (e.target.files[0]) showFile(e.target.files[0]); });
  }

  if (dropZone) {
    dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('dragover'); });
    dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
    dropZone.addEventListener('drop', e => {
      e.preventDefault();
      dropZone.classList.remove('dragover');
      if (e.dataTransfer.files[0]) showFile(e.dataTransfer.files[0]);
    });
  }

  if (removeBtn) {
    removeBtn.addEventListener('click', () => {
      if (filePreview) filePreview.classList.remove('visible');
      if (mappingSection) mappingSection.classList.remove('visible');
      if (divider) divider.style.display = 'flex';
      if (fileInput) fileInput.value = '';
      arquivoSelecionado = null;
    });
  }
});

// Exibe o arquivo selecionado na tela e faz a contagem REAL de linhas
function showFile(file) {
  arquivoSelecionado = file;
  const filePreview = document.getElementById('filePreview');
  const mappingSection = document.getElementById('mappingSection');
  const divider = document.getElementById('divider');
  
  if (document.getElementById('fileName')) {
    document.getElementById('fileName').textContent = file.name;
  }
  
  const kb = file.size / 1024;
  const size = kb > 1024 ? (kb/1024).toFixed(1) + ' MB' : kb.toFixed(0) + ' KB';
  
  if (document.getElementById('fileSize')) {
    document.getElementById('fileSize').textContent = size + ' • Analisando colunas...';
  }
  
  if (filePreview) filePreview.classList.add('visible');
  if (mappingSection) mappingSection.classList.add('visible');
  if (divider) divider.style.display = 'none';
  
  // LEITURA REAL E DINÂMICA DO TOTAL DE LINHAS
  const reader = new FileReader();
  reader.onload = function(e) {
    const linhas = e.target.result.split(/\r?\n/).filter(l => l.trim().length > 0);
    const totalLinhas = linhas.length > 1 ? linhas.length - 1 : 0;
    if (document.getElementById('fileSize')) {
      document.getElementById('fileSize').textContent = size + ` • ${totalLinhas.toLocaleString('pt-BR')} linhas reais detectadas`;
    }
  };
  reader.readAsText(file);
}

// Executada quando o usuário clica no botão "Gerar Dashboard"
function startUpload() {
  if (!arquivoSelecionado) {
    alert("Por favor, selecione ou arraste um arquivo de planilha primeiro!");
    return;
  }

  const overlay = document.getElementById('progressOverlay');
  const bar = document.getElementById('progressBar');
  const msg = document.getElementById('progressMsg');
  const pct = document.getElementById('progressPct');
  
  if (overlay) overlay.classList.add('visible');

  // LER E MAPEAR OS DADOS DO CSV DE VERDADE
  const reader = new FileReader();
  reader.onload = function(e) {
    const texto = e.target.result;
    const linhas = texto.split(/\r?\n/);
    
    if (linhas.length < 2) {
      alert("O arquivo selecionado parece estar vazio!");
      if (overlay) overlay.classList.remove('visible');
      return;
    }

    // Pega a primeira linha da tabela (Cabeçalhos) e padroniza em maiúsculas
    const cabecalho = linhas[0].split(',').map(c => c.trim().toUpperCase());
    
    // Mapeamento Dinâmico Inteligente: acha os índices ideais para qualquer padrão de planilha (Naira ou Eduardo)
    let idxOs = cabecalho.findIndex(c => c.includes('OS') || c.includes('O.S.') || c.includes('CONTRATO') || c.includes('Nº'));
    let idxCliente = cabecalho.findIndex(c => c.includes('CLIENTE') || c.includes('NOME'));
    let idxVeiculo = cabecalho.findIndex(c => c.includes('MODELO') || c.includes('VEICULO') || c.includes('VEÍCULO') || c.includes('PLACA'));
    let idxTipo = cabecalho.findIndex(c => c.includes('TIPO'));
    let idxReceita = cabecalho.findIndex(c => c.includes('FATURAR') || c.includes('ADIC') || c.includes('VALOR'));
    let idxCusto = cabecalho.findIndex(c => c.includes('DESPESA') || c.includes('CUSTO') || c.includes('PEÇAS') || c.includes('MÃO DE OBRA'));
    let idxData = cabecalho.findIndex(c => c.includes('ABERTURA') || c.includes('VENCIMENTO') || c.includes('DATA'));

    const dadosMapeados = [];

    // Percorre cada linha de dados (pulando o cabeçalho)
    for (let i = 1; i < linhas.length; i++) {
      const linhaTexto = linhas[i].trim();
      if (!linhaTexto) continue; // Ignora linhas em branco no fim do arquivo
      
      // Divide as colunas removendo possíveis aspas de texto
      const colunas = linhaTexto.split(',').map(c => c.trim().replace(/^"|"$/g, ''));
      if (colunas.length < 3) continue;

      // Extração dos dados baseando-se nas colunas mapeadas
      const os = idxOs !== -1 && colunas[idxOs] ? colunas[idxOs] : '#' + (1750 + i);
      const cliente = idxCliente !== -1 && colunas[idxCliente] ? colunas[idxCliente] : 'Cliente Geral';
      const veiculo = idxVeiculo !== -1 && colunas[idxVeiculo] ? colunas[idxVeiculo] : '-';
      const tipo = idxTipo !== -1 && colunas[idxTipo] ? colunas[idxTipo] : 'Outros';
      
      // Função interna para limpar formatações de moedas e converter em número real
      const limparNumero = (val) => {
        if (!val) return 0;
        let n = val.replace('R$', '').replace(/\s/g, '').trim();
        return parseFloat(n) || 0;
      };

      const receita = idxReceita !== -1 ? limparNumero(colunas[idxReceita]) : 0;
      const custo = idxCusto !== -1 ? limparNumero(colunas[idxCusto]) : 0;
      const data = idxData !== -1 && colunas[idxData] ? colunas[idxData] : '2026-01-05'; 

      dadosMapeados.push({ os, cliente, veiculo, tipo, receita, custo, data });
    }

    // A MÁGICA ACONTECE AQUI: Salva os dados estruturados de verdade na memória local!
    localStorage.setItem('findash_real_data', JSON.stringify(dadosMapeados));

    // Faz a animação visual da barra progredir com base na finalização do processo
    let progresso = 0;
    const passos = [
      [25, 'Decodificando colunas da planilha...'],
      [55, 'Processando registros de faturamento...'],
      [80, 'Salvando dados no banco local...'],
      [100, 'Tudo pronto! Construindo gráficos...']
    ];

    const intervalo = setInterval(() => {
      progresso += 5;
      if (bar) bar.style.width = progresso + '%';
      if (pct) pct.textContent = progresso + '%';

      const passoAtual = passos.find(p => progresso <= p[0]);
      if (passoAtual && msg) msg.textContent = passoAtual[1];

      if (progresso >= 100) {
        clearInterval(intervalo);
        // Agora sim, redireciona tendo os dados prontos esperando no Dashboard!
        window.location.href = 'Dashboard.html';
      }
    }, 40);
  };

  reader.readAsText(arquivoSelecionado);
}