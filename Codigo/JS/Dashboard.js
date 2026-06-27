// ============================================================
// DASHBOARD.JS — Dashboard de Faturamento e Reembolsáveis
// Baseado na planilha: BASE DE FATURAMENTO REEMBOLSAVEIS
// Campos: os, data, cliente, tipo, modelo, natureza,
//         moSem, pecSem, taxa, faturar, custo, status
// ============================================================

document.addEventListener('DOMContentLoaded', () => {
  const divDados  = document.getElementById('dashboardData');
  const divVazio  = document.getElementById('emptyState');

  let dados = [], meta = {};
  try { dados = JSON.parse(localStorage.getItem('findash_real_data') || '[]'); } catch(e) { dados = []; }
  try { meta  = JSON.parse(localStorage.getItem('findash_meta')      || '{}'); } catch(e) { meta  = {}; }

  if (!dados.length) {
    if (divDados) divDados.style.display = 'none';
    if (divVazio) divVazio.style.display = 'flex';
    return;
  }
  if (divDados) divDados.style.display = 'block';
  if (divVazio) divVazio.style.display = 'none';

  // ==========================================
  // 1. PROCESSAMENTO
  // ==========================================
  const mesesMap  = {};   // { 'YYYY-MM': { faturar, custo, osSet, sinistro, corretivo } }
  const tiposMap  = {};   // { tipo: count }
  const clientesMap = {}; // { cliente: faturar }
  const naturezaMap = {}; // { natureza: count }

  let totalFaturar = 0, totalCusto = 0;
  const osUnicas = new Set();

  dados.forEach(d => {
    const fat   = Number(d.faturar) || 0;
    const custo = Number(d.custo)   || 0;
    const tipo  = d.tipo  || 'Outros';
    const nat   = d.natureza && d.natureza !== '' ? d.natureza : 'Sem categoria';

    totalFaturar += fat;
    totalCusto   += custo;
    if (d.os && d.os !== '-') osUnicas.add(d.os);

    // Agrupamento por mês
    let anoMes = '';
    if (d.data && typeof d.data === 'string' && d.data.length >= 7) {
      anoMes = d.data.substring(0, 7);
    } else if (typeof d.data === 'number') {
      const dt = new Date(Math.round((d.data - 25569) * 86400000));
      if (!isNaN(dt)) anoMes = dt.toISOString().substring(0, 7);
    }

    if (anoMes) {
      if (!mesesMap[anoMes]) mesesMap[anoMes] = { faturar: 0, custo: 0, osSet: new Set(), sinistro: 0, corretivo: 0 };
      mesesMap[anoMes].faturar += fat;
      mesesMap[anoMes].custo   += custo;
      if (d.os && d.os !== '-') mesesMap[anoMes].osSet.add(d.os);
      if (tipo === 'SINISTRO')  mesesMap[anoMes].sinistro++;
      else if (tipo === 'CORRETIVO') mesesMap[anoMes].corretivo++;
    }

    tiposMap[tipo]         = (tiposMap[tipo]         || 0) + 1;
    naturezaMap[nat]       = (naturezaMap[nat]        || 0) + 1;
    if (d.cliente && d.cliente !== '-') {
      clientesMap[d.cliente] = (clientesMap[d.cliente] || 0) + fat;
    }
  });

  const mesesOrd = Object.keys(mesesMap).sort();
  const margem   = totalFaturar > 0 ? ((totalFaturar - totalCusto) / totalFaturar * 100) : 0;

  // ==========================================
  // 2. KPIs
  // ==========================================
  const fmt = v => 'R$ ' + v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const set = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };

  set('kpiReceita', fmt(totalFaturar));
  set('kpiCusto',   fmt(totalCusto));
  set('kpiMargem',  margem.toFixed(1) + '%');
  set('kpiBudget',  osUnicas.size.toString());

  // Variação: compara último mês com penúltimo
  if (mesesOrd.length >= 2) {
    const ult  = mesesMap[mesesOrd[mesesOrd.length - 1]];
    const penu = mesesMap[mesesOrd[mesesOrd.length - 2]];
    const varFat = penu.faturar > 0 ? ((ult.faturar - penu.faturar) / penu.faturar * 100) : 0;
    const varCus = penu.custo   > 0 ? ((ult.custo   - penu.custo)   / penu.custo   * 100) : 0;

    const elRV = document.getElementById('kpiReceitaVar');
    const elCV = document.getElementById('kpiCustoVar');
    if (elRV) { elRV.textContent = (varFat >= 0 ? '+' : '') + varFat.toFixed(1) + '%'; elRV.className = 'kpi-badge ' + (varFat >= 0 ? 'up' : 'down'); }
    if (elCV) { elCV.textContent = (varCus >= 0 ? '+' : '') + varCus.toFixed(1) + '%'; elCV.className = 'kpi-badge ' + (varCus <= 0 ? 'up' : 'down'); }
  }

  // Adapta o label do KPI de Budget para "OS Únicas"
  const kpiBLabel = document.querySelector('[style="--kpi-color: var(--amber-500)"] .kpi-label');
  if (kpiBLabel) kpiBLabel.innerHTML = `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M9 12l2 2 4-4"/></svg> OS únicas`;
  const elBStatus = document.getElementById('kpiBudgetStatus');
  const elBText   = document.getElementById('kpiBudgetText');
  if (elBStatus) { elBStatus.textContent = dados.length + ' linhas'; elBStatus.className = 'kpi-badge'; }
  if (elBText)   elBText.textContent = 'na base de dados';

  // Topbar period
  const topPeriod = document.getElementById('topbarPeriod');
  if (topPeriod && mesesOrd.length) {
    const labelMes = m => {
      const [y, mo] = m.split('-');
      return new Date(+y, +mo - 1, 1).toLocaleDateString('pt-BR', { month: 'short', year: 'numeric' });
    };
    const arq = meta.arquivo ? ` · ${meta.arquivo}` : '';
    topPeriod.textContent = `${labelMes(mesesOrd[0])} → ${labelMes(mesesOrd[mesesOrd.length - 1])} · ${osUnicas.size} OS${arq}`;
  }

  // ==========================================
  // 3. GRÁFICO 1 — Faturar vs Custo por mês
  // ==========================================
  const labFmt = mesesOrd.map(m => {
    const [y, mo] = m.split('-');
    return new Date(+y, +mo - 1, 1).toLocaleDateString('pt-BR', { month: 'short', year: '2-digit' }).replace('.', '');
  });
  const fatArr    = mesesOrd.map(m => mesesMap[m].faturar);
  const custoArr  = mesesOrd.map(m => mesesMap[m].custo);
  const margemArr = fatArr.map((f, i) => f > 0 ? Math.round(((f - custoArr[i]) / f) * 100) : 0);

  const lineCtx = document.getElementById('lineChart');
  if (lineCtx) {
    new Chart(lineCtx.getContext('2d'), {
      type: 'bar',
      data: {
        labels: labFmt,
        datasets: [
          { label: 'Faturamento', data: fatArr,   backgroundColor: 'rgba(24,95,165,0.85)', borderRadius: 5, order: 2 },
          { label: 'Custo base',  data: custoArr, backgroundColor: 'rgba(226,75,74,0.72)', borderRadius: 5, order: 2 },
          {
            label: 'Margem %', data: margemArr, type: 'line',
            borderColor: '#639922', backgroundColor: 'rgba(99,153,34,0.06)',
            borderWidth: 2.5, pointRadius: 4, pointBackgroundColor: '#639922',
            tension: 0.35, yAxisID: 'yMargem', order: 1,
          },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: ctx => {
                if (ctx.dataset.label === 'Margem %') return 'Margem: ' + ctx.parsed.y + '%';
                return ctx.dataset.label + ': R$ ' + ctx.parsed.y.toLocaleString('pt-BR', { minimumFractionDigits: 2 });
              }
            }
          }
        },
        scales: {
          x: { grid: { display: false }, ticks: { maxRotation: 0 } },
          y: {
            position: 'left',
            ticks: { callback: v => 'R$' + (v >= 1000 ? (v/1000).toFixed(0) + 'k' : v) }
          },
          yMargem: {
            position: 'right', grid: { drawOnChartArea: false },
            min: 0, max: 100,
            ticks: { callback: v => v + '%' }
          }
        }
      }
    });
  }

  // ==========================================
  // 4. GRÁFICO 2 — Donut: SINISTRO vs CORRETIVO
  // ==========================================
  const donutCtx = document.getElementById('donutChart');
  if (donutCtx) {
    const tiposLab  = Object.keys(tiposMap);
    const tiposVals = Object.values(tiposMap);
    const cores     = ['#185FA5','#E24B4A','#BA7517','#639922','#6C757D','#9C27B0'];

    new Chart(donutCtx.getContext('2d'), {
      type: 'doughnut',
      data: {
        labels: tiposLab,
        datasets: [{ data: tiposVals, backgroundColor: cores, borderWidth: 0, hoverOffset: 6 }]
      },
      options: {
        responsive: true, maintainAspectRatio: false, cutout: '68%',
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: ctx => ctx.label + ': ' + ctx.parsed + ' registros' } }
        }
      }
    });
  }

  // ==========================================
  // 5. TABELA — OS por mês (realizado vs custo)
  // ==========================================
  const tbody = document.getElementById('tableDepartamentosBody');
  if (tbody) {
    // Adapta o cabeçalho da tabela para o contexto real
    const thead = document.querySelector('table.data-table thead tr');
    if (thead) thead.innerHTML = '<th>Período</th><th>Faturamento</th><th>Custo base</th><th>Resultado</th>';

    tbody.innerHTML = mesesOrd.map(m => {
      const d   = mesesMap[m];
      const fat = d.faturar;
      const cst = d.custo;
      const mg  = fat > 0 ? ((fat - cst) / fat * 100) : 0;
      const [y, mo] = m.split('-');
      const label = new Date(+y, +mo - 1, 1).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
      const badge = mg >= 30
        ? `<span style="color:#639922">↑ ${mg.toFixed(1)}% margem</span>`
        : mg >= 0
          ? `<span style="color:#BA7517">→ ${mg.toFixed(1)}% margem</span>`
          : `<span style="color:#E24B4A">↓ ${mg.toFixed(1)}% margem</span>`;
      return `<tr>
        <td style="font-weight:500;text-transform:capitalize">${label}</td>
        <td>${fmt(fat)}</td>
        <td>${fmt(cst)}</td>
        <td>${badge}</td>
      </tr>`;
    }).join('');
  }

  // ==========================================
  // 6. METAS — Top clientes por faturamento
  // ==========================================
  const metaContainer = document.getElementById('metaListContainer');
  if (metaContainer) {
    const topClientes = Object.entries(clientesMap)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);

    const maxVal = topClientes[0]?.[1] || 1;

    // Adapta o título do card
    const cardTitle = document.querySelector('.bottom-row .card:last-child .card-title');
    if (cardTitle) cardTitle.textContent = 'Top clientes';
    const cardSub = document.querySelector('.bottom-row .card:last-child .card-subtitle');
    if (cardSub) cardSub.textContent = 'Por valor faturado';

    metaContainer.innerHTML = topClientes.map(([nome, val]) => {
      const pct = Math.round((val / maxVal) * 100);
      const nomeCurto = nome.length > 28 ? nome.substring(0, 28) + '…' : nome;
      return `<div class="meta-item">
        <div class="meta-header">
          <span class="meta-name" title="${nome}">${nomeCurto}</span>
          <span class="meta-pct">${fmt(val)}</span>
        </div>
        <div class="meta-bar-bg">
          <div class="meta-bar" style="width:${pct}%;background:#185FA5"></div>
        </div>
      </div>`;
    }).join('');
  }
});

// ==========================================
// FUNÇÕES GLOBAIS
// ==========================================
function updatePeriod(val) {
  const labels = { '1': 'Este mês', '3': 'Últimos 3 meses', '6': 'Últimos 6 meses', '12': 'Último ano' };
  const el = document.getElementById('topbarPeriod');
  if (el) el.textContent = labels[val] || 'Período selecionado';
}

function toggleUserArea() {
  const btn      = document.querySelector('.user-btn');
  const dropdown = document.getElementById('userDropdown');
  if (btn && dropdown) {
    btn.classList.toggle('active');
    dropdown.classList.toggle('show');
  }
}

function limparDados() {
  if (confirm('Apagar os dados importados? Será necessário importar uma nova planilha.')) {
    localStorage.removeItem('findash_real_data');
    localStorage.removeItem('findash_meta');
    window.location.reload();
  }
}

function exportPDF() { window.print(); }