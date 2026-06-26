// Aguarda a página carregar para não dar conflito com o HTML
document.addEventListener('DOMContentLoaded', () => {
  const dadosSalvos = localStorage.getItem('findash_real_data');
  const dashboardData = document.getElementById('dashboardData');
  const emptyState = document.getElementById('emptyState');

  let dadosFaturamento = [];

  // Tenta ler os dados do cache do navegador
  if (dadosSalvos) {
    try {
      dadosFaturamento = JSON.parse(dadosSalvos);
    } catch (err) {
      console.error("Erro ao ler os dados:", err);
    }
  }

  // A GRANDE CORREÇÃO DE VISIBILIDADE ESTÁ AQUI:
  // 1. Se não houver dados ou a lista estiver vazia (Usuário acabou de excluir)
  if (!dadosFaturamento || dadosFaturamento.length === 0) {
    if (dashboardData) dashboardData.style.display = 'none'; // Esconde os gráficos
    if (emptyState) emptyState.style.display = 'flex';       // Mostra a mensagem de "Nenhum Dado"
    return; // Para o script aqui, não tenta desenhar gráficos
  } 
  
  // 2. Se houver dados reais importados (Usuário subiu o arquivo)
  if (dashboardData) dashboardData.style.display = 'block';  // Mostra os gráficos
  if (emptyState) emptyState.style.display = 'none';         // Esconde a mensagem de "Nenhum Dado"

  // INÍCIO DA RENDERIZAÇÃO DOS DADOS REAIS
  const metricas = processarMetricasDinamicas(dadosFaturamento);

  // Alimentação dos KPIs Superiores
  try {
    const kpisGerais = document.querySelectorAll('.card-value, .kpi-value, .stat-value, .card-number');
    if (kpisGerais.length >= 2) {
      kpisGerais[0].textContent = 'R$ ' + metricas.totalReceita.toLocaleString('pt-BR', {minimumFractionDigits: 2, maximumFractionDigits: 2});
      kpisGerais[1].textContent = 'R$ ' + metricas.totalCusto.toLocaleString('pt-BR', {minimumFractionDigits: 2, maximumFractionDigits: 2});
      if (kpisGerais[2]) {
        const margemGeral = metricas.totalReceita > 0 ? ((metricas.totalReceita - metricas.totalCusto) / metricas.totalReceita * 100) : 0;
        kpisGerais[2].textContent = margemGeral.toFixed(1) + '%';
      }
    }
  } catch (e) {
    console.log("Aviso: Texto dos KPIs não encontrado no HTML.");
  }

  // Alimentação da Tabela de Últimos Lançamentos
  const tabelaCorpo = document.querySelector('.data-table tbody');
  if (tabelaCorpo) {
    tabelaCorpo.innerHTML = '';
    const ultimosLancamentos = dadosFaturamento.slice(0, 6);
    
    ultimosLancamentos.forEach(item => {
      const tr = document.createElement('tr');
      let statusClass = 'status-ok';
      const t = (item.tipo || '').toLowerCase();
      if (t.includes('corr')) statusClass = 'status-warn';
      if (t.includes('sinis')) statusClass = 'status-over';

      tr.innerHTML = `
        <td>${item.os || '#'}</td>
        <td>${item.cliente || 'Não informado'}</td>
        <td>${item.veiculo || '-'}</td>
        <td><span class="status-pill ${statusClass}">${item.tipo || 'Outro'}</span></td>
        <td>R$ ${(item.receita || 0).toLocaleString('pt-BR', {minimumFractionDigits: 2, maximumFractionDigits: 2})}</td>
      `;
      tabelaCorpo.appendChild(tr);
    });
  }

  // Desenha os Gráficos do Chart.js
  const lineCanvas = document.getElementById('lineChart');
  if (lineCanvas) {
    new Chart(lineCanvas, {
      type: 'bar',
      data: {
        labels: metricas.mesesLabels,
        datasets: [
          { label: 'Receita', data: metricas.receitasPorMes, backgroundColor: 'rgba(24, 95, 165, 0.85)', borderRadius: 4, order: 2 },
          { label: 'Custo', data: metricas.custosPorMes, backgroundColor: 'rgba(226, 75, 74, 0.75)', borderRadius: 4, order: 2 },
          { label: 'Margem %', data: metricas.margensPorMes, type: 'line', borderColor: '#639922', backgroundColor: '#639922', yAxisID: 'y1', order: 1 }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          y: { beginAtZero: true },
          y1: { position: 'right', grid: { display: false }, ticks: { callback: v => v + '%' } }
        }
      }
    });
  }

  const donutCanvas = document.getElementById('donutChart');
  if (donutCanvas) {
    new Chart(donutCanvas, {
      type: 'doughnut',
      data: {
        labels: ['Corretiva', 'Preventiva', 'Sinistro', 'Outros'],
        datasets: [{
          data: [
            metricas.tiposContador['CORRETIVA'],
            metricas.tiposContador['PREVENTIVA'],
            metricas.tiposContador['SINISTRO'],
            metricas.tiposContador['OUTROS']
          ],
          backgroundColor: ['#E24B4A', '#639922', '#185FA5', '#BA7517'],
          borderWidth: 0
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: '68%',
        plugins: { legend: { display: false } }
      }
    });
  }
});


// ==========================================
// FUNÇÕES GLOBAIS (Fora do evento de load)
// ==========================================

function processarMetricasDinamicas(dados) {
  const mesesLabels = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];
  const receitasPorMes = Array(12).fill(0);
  const custosPorMes = Array(12).fill(0);
  let totalReceita = 0;
  let totalCusto = 0;
  const tiposContador = { 'CORRETIVA': 0, 'PREVENTIVA': 0, 'SINISTRO': 0, 'OUTROS': 0 };

  dados.forEach(item => {
    if (item.data) {
      const partes = item.data.split(/[-/]/);
      if (partes.length >= 2) {
        const mesItem = parseInt(partes[1]) - 1; 
        if (mesItem >= 0 && mesItem < 12) {
          receitasPorMes[mesItem] += (item.receita || 0);
          custosPorMes[mesItem] += (item.custo || 0);
        }
      }
    }
    
    totalReceita += (item.receita || 0);
    totalCusto += (item.custo || 0);

    const t = item.tipo ? item.tipo.toUpperCase() : '';
    if (t.includes('CORRETIV')) tiposContador['CORRETIVA'] += (item.receita || 0);
    else if (t.includes('PREVENTIV')) tiposContador['PREVENTIVA'] += (item.receita || 0);
    else if (t.includes('SINISTRO')) tiposContador['SINISTRO'] += (item.receita || 0);
    else tiposContador['OUTROS'] += (item.receita || 0);
  });

  const margensPorMes = receitasPorMes.map((r, i) => {
    if (r === 0) return 0;
    return Math.round(((r - custosPorMes[i]) / r) * 100);
  });

  return { mesesLabels, receitasPorMes, custosPorMes, margensPorMes, totalReceita, totalCusto, tiposContador };
}

function updatePeriod(val) {
  const labels = { '1': 'Este mês', '3': 'Últimos 3 meses', '6': 'Últimos 6 meses', '12': 'Último ano' };
  const topbarPeriod = document.querySelector('.topbar-period');
  if (topbarPeriod) topbarPeriod.textContent = labels[val] || 'Período selecionado';
}

function toggleUserArea() {
  const btn = document.querySelector('.user-btn');
  const dropdown = document.getElementById('userDropdown');
  if (btn && dropdown) {
    btn.classList.toggle('active');
    dropdown.classList.toggle('show');
  }
}

function limparDados() {
  if (confirm("Deseja mesmo limpar as informações atuais? Será necessário importar um novo arquivo de planilha.")) {
    localStorage.removeItem('findash_real_data');
    window.location.reload();
  }
}

function exportPDF() {
  const btn = event ? event.target.closest('button') : null;
  if (btn) {
    btn.textContent = '✓ Pronto para impressão';
    btn.style.background = 'var(--green-500)';
    setTimeout(() => {
      btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> Exportar PDF`;
      btn.style.background = '';
    }, 2000);
  }
  window.print();
}