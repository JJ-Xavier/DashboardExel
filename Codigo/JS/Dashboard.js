// Verifica se existem dados reais salvos no localStorage do navegador
const dadosProjeto = localStorage.getItem('findash_real_data');

document.addEventListener('DOMContentLoaded', () => {
  if (!dadosProjeto) {
    // Caso não encontre planilhas processadas, exibe o Estado Vazio mantendo a estrutura intacta
    document.getElementById('dashboardData').style.display = 'none';
    document.getElementById('emptyState').style.display = 'flex';
  } else {
    // Encontrou dados reais! Oculta a mensagem e monta as informações estruturadas
    document.getElementById('dashboardData').style.display = 'block';
    document.getElementById('emptyState').style.display = 'none';

    const dadosConvertidos = JSON.parse(dadosProjeto);
    inicializarDashboard(dadosConvertidos);
  }
});

// Inicialização dinâmica baseada nos dados importados
function inicializarDashboard(dados) {
  
  // Atualiza o período no topo da tela
  document.getElementById('topbarPeriod').textContent = dados.periodo || 'Período Geral';

  // Alimenta os blocos indicadores de KPIs
  document.getElementById('kpiReceita').textContent = dados.kpis.receitaTotal;
  document.getElementById('kpiCusto').textContent = dados.kpis.custoTotal;
  document.getElementById('kpiMargem').textContent = dados.kpis.margemLiquida;
  document.getElementById('kpiBudget').textContent = dados.kpis.budgetUtilizado;

  // Montagem do Gráfico Combinado (Evolução de Receita e Custos)
  const lineCtx = document.getElementById('lineChart').getContext('2d');
  new Chart(lineCtx, {
    type: 'bar',
    data: {
      labels: dados.graficoEvolucao.meses,
      datasets: [
        {
          label: 'Receita',
          data: dados.graficoEvolucao.receitas,
          backgroundColor: 'rgba(24, 95, 165, 0.85)',
          borderRadius: 4,
          order: 2
        },
        {
          label: 'Custo',
          data: dados.graficoEvolucao.custos,
          backgroundColor: 'rgba(226, 75, 74, 0.75)',
          borderRadius: 4,
          order: 2
        },
        {
          label: 'Margem %',
          data: dados.graficoEvolucao.margens,
          type: 'line',
          borderColor: '#639922',
          backgroundColor: 'rgba(99,153,34,0.08)',
          fill: true,
          tension: 0.4,
          pointRadius: 4,
          yAxisID: 'y2',
          order: 1
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { grid: { display: false }, ticks: { font: { family: 'Inter', size: 11 }, color: '#ADB5BD' } },
        y: { grid: { color: '#F1F3F5' }, ticks: { font: { family: 'Inter', size: 11 }, color: '#ADB5BD' } },
        y2: { position: 'right', grid: { display: false }, ticks: { font: { family: 'Inter', size: 11 }, color: '#ADB5BD', callback: v => v + '%' } }
      }
    }
  });

  // Montagem do Gráfico de Rosca (Distribuição de Custos por Categoria)
  const donutCtx = document.getElementById('donutChart').getContext('2d');
  new Chart(donutCtx, {
    type: 'doughnut',
    data: {
      labels: dados.graficoDonut.categorias,
      datasets: [{
        data: dados.graficoDonut.valores,
        backgroundColor: ['#185FA5', '#E24B4A', '#BA7517', '#639922'],
        borderWidth: 0
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      cutout: '68%'
    }
  });

  // Renderização da tabela de departamentos
  const tableBody = document.getElementById('tableDepartamentosBody');
  tableBody.innerHTML = '';
  dados.departamentos.forEach(dept => {
    tableBody.innerHTML += `
      <tr>
        <td>${dept.nome}</td>
        <td>${dept.realizado}</td>
        <td>${dept.orcado}</td>
        <td><span class="status-pill ${dept.classeStatus}">${dept.status}</span></td>
      </tr>
    `;
  });

  // Renderização do painel de metas
  const metaContainer = document.getElementById('metaListContainer');
  metaContainer.innerHTML = '';
  dados.metas.forEach(meta => {
    metaContainer.innerHTML += `
      <div class="meta-item">
        <div class="meta-header">
          <span class="meta-name">${meta.titulo}</span>
          <span class="meta-pct">${meta.porcentagem}%</span>
        </div>
        <div class="meta-bar-bg">
          <div class="meta-bar" style="width: ${meta.porcentagem}%; background: ${meta.cor};"></div>
        </div>
        <div class="meta-values">
          <span>${meta.atual}</span>
          <span>Meta: ${meta.alvo}</span>
        </div>
      </div>
    `;
  });
}

function updatePeriod(val) {
  const labels = { '1': 'Este mês', '3': 'Últimos 3 meses', '6': 'Últimos 6 meses', '12': 'Último ano' };
  document.getElementById('topbarPeriod').textContent = labels[val] || 'Período selecionado';
}

function exportPDF() {
  window.print();
}