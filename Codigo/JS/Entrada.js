// ============================================================
// ENTRADA.JS — Leitura especializada para BASE DE FATURAMENTO
// Campos mapeados: NUMERO OS, ABERTURA, CLIENTE, TIPO DE MANUTENÇÃO,
//                 M.O SEM TAXA, PEÇAS SEM TAXA, TAXA, VALOR A FATURAR, STATUS
// ============================================================

let arquivoSelecionado = null;

document.addEventListener('DOMContentLoaded', () => {
  const dropZone   = document.getElementById('dropZone');
  const fileInput  = document.getElementById('fileInput');
  const removeBtn  = document.getElementById('removeFile');

  if (!dropZone || !fileInput) return;

  dropZone.addEventListener('click', (e) => {
    if (e.target !== fileInput) fileInput.click();
  });

  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('dragover');
  });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    const f = e.dataTransfer.files[0];
    if (f) definirArquivo(f);
  });

  fileInput.addEventListener('change', (e) => {
    const f = e.target.files[0];
    if (f) definirArquivo(f);
  });

  if (removeBtn) removeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    removerArquivo();
  });
});

function definirArquivo(file) {
  const ext = file.name.split('.').pop().toLowerCase();
  if (!['xlsx','xls','csv'].includes(ext)) {
    alert('Formato não suportado. Use .xlsx, .xls ou .csv');
    return;
  }
  arquivoSelecionado = file;

  const fp   = document.getElementById('filePreview');
  const ms   = document.getElementById('mappingSection');
  const div  = document.getElementById('divider');
  const dz   = document.getElementById('dropZone');
  const fn   = document.getElementById('fileName');
  const fs   = document.getElementById('fileSize');

  if (fn) fn.textContent = file.name;
  if (fs) {
    const mb = (file.size / 1048576).toFixed(1);
    const kb = (file.size / 1024).toFixed(0);
    fs.textContent = (file.size > 1048576 ? mb + ' MB' : kb + ' KB') + ' • pronto para importar';
  }
  if (fp)  fp.classList.add('visible');
  if (ms)  ms.classList.add('visible');
  if (div) div.style.display = 'none';
  if (dz)  dz.style.display  = 'none';
}

function removerArquivo() {
  arquivoSelecionado = null;
  ['filePreview','mappingSection'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.remove('visible');
  });
  const div = document.getElementById('divider');
  const dz  = document.getElementById('dropZone');
  const fi  = document.getElementById('fileInput');
  if (div) div.style.display = '';
  if (dz)  dz.style.display  = '';
  if (fi)  fi.value = '';
}

// ---- Conversões ----
function excelSerialParaData(serial) {
  if (typeof serial !== 'number' || isNaN(serial)) return null;
  const ms = Math.round((serial - 25569) * 86400 * 1000); // offset da epoch Excel→Unix
  const d  = new Date(ms);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().substring(0, 10);
}

function normalizarData(val) {
  if (!val && val !== 0) return null;
  if (typeof val === 'number') return excelSerialParaData(val);
  const s = String(val).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.substring(0, 10);
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (m) {
    let y = m[3].length === 2 ? '20' + m[3] : m[3];
    return `${y}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`;
  }
  const d = new Date(s);
  if (!isNaN(d.getTime())) return d.toISOString().substring(0, 10);
  return null;
}

function safeNum(v) {
  if (v === null || v === undefined || v === '') return 0;
  if (typeof v === 'number') return isNaN(v) ? 0 : v;
  const s = String(v).replace(/[R$\s"]/g,'').replace(/\./g,'').replace(',','.');
  return parseFloat(s) || 0;
}

// ---- Leitura ----
function lerExcel(file, cb) {
  const r = new FileReader();
  r.onload = e => {
    try {
      const wb    = XLSX.read(new Uint8Array(e.target.result), { type: 'array', raw: true });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const json  = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: '' });
      cb(null, json);
    } catch(err) { cb(err, null); }
  };
  r.onerror = () => cb(new Error('Erro ao ler'), null);
  r.readAsArrayBuffer(file);
}

function lerCSV(file, cb) {
  const r = new FileReader();
  r.onload = e => {
    try {
      const linhas = e.target.result.split(/\r?\n/);
      const sep    = linhas[0].includes(';') ? ';' : ',';
      const json   = linhas.filter(l => l.trim()).map(l => parseLine(l, sep));
      cb(null, json);
    } catch(err) { cb(err, null); }
  };
  r.onerror = () => cb(new Error('Erro CSV'), null);
  r.readAsText(file, 'UTF-8');
}

function parseLine(linha, sep) {
  const res = []; let cur = ''; let inQ = false;
  for (const ch of linha) {
    if (ch === '"') { inQ = !inQ; }
    else if (ch === sep && !inQ) { res.push(cur.trim()); cur = ''; }
    else cur += ch;
  }
  res.push(cur.trim());
  return res;
}

// ---- Índice de coluna pelo nome ----
function idx(cab, termos) {
  return cab.findIndex(c => termos.some(t => String(c).toUpperCase().trim().includes(t)));
}

// ---- Processamento principal ----
function processarDados(err, json) {
  const overlay = document.getElementById('progressOverlay');
  const bar     = document.getElementById('progressBar');
  const pct     = document.getElementById('progressPct');
  const msg     = document.getElementById('progressMsg');

  if (err || !json || json.length < 2) {
    if (overlay) overlay.classList.remove('visible');
    alert('Não foi possível ler o arquivo. Verifique se não está protegido por senha.');
    return;
  }

  // Encontra linha do cabeçalho (primeira linha não-vazia)
  let cabIdx = 0;
  for (let i = 0; i < Math.min(5, json.length); i++) {
    if (json[i].some(c => c !== '')) { cabIdx = i; break; }
  }
  const cab = json[cabIdx].map(c => String(c || '').toUpperCase().trim());

  // Mapeamento EXATO para esta planilha
  const iOs      = idx(cab, ['NUMERO OS', 'NUM OS', 'OS']);
  const iData    = idx(cab, ['ABERTURA', 'DATA ABERTURA', 'DATA']);
  const iCliente = idx(cab, ['CLIENTE', 'RAZÃO SOCIAL', 'RAZAO SOCIAL']);
  const iTipo    = idx(cab, ['TIPO DE MANUTENÇÃO', 'TIPO MANUT', 'TIPO']);
  const iModelo  = idx(cab, ['MODELO VEÍCULO', 'MODELO VEICULO', 'MODELO']);
  const iPlaca   = idx(cab, ['PLACA', 'PLACA VEÍCULO', 'PLACA VEICULO']);
  const iMoSem   = idx(cab, ['M.O SEM TAXA', 'MO SEM TAXA', 'MAO DE OBRA']);
  const iPecSem  = idx(cab, ['PEÇAS SEM TAXA', 'PECAS SEM TAXA', 'PECA SEM TAXA']);
  const iTaxa    = idx(cab, ['TAXA']);
  const iMoTot   = idx(cab, ['M.O TOTAL', 'MO TOTAL']);
  const iPecTot  = idx(cab, ['PEÇAS TOTAL', 'PECAS TOTAL']);
  const iFaturar = idx(cab, ['VALOR A FATURAR', 'VALOR FATURAR', 'FATURAR', 'FATURAMENTO']);
  const iStatus  = idx(cab, ['STATUS']);
  const iNat     = idx(cab, ['NATUREZA', 'NATUREZA ATENDIMENTO', 'LOCAÇÃO NATUREZA']);

  if (msg) msg.textContent = 'Mapeando ' + (json.length - cabIdx - 1) + ' registros...';
  if (bar) bar.style.width = '50%';
  if (pct) pct.textContent = '50%';

  const dados = [];

  for (let i = cabIdx + 1; i < json.length; i++) {
    const r = json[i];
    if (!r || r.every(c => c === '' || c === null || c === undefined)) continue;

    const dataNorm = normalizarData(iData >= 0 ? r[iData] : null) || '2025-01-01';
    const faturar  = iFaturar >= 0 ? safeNum(r[iFaturar]) : 0;
    const moSem    = iMoSem  >= 0 ? safeNum(r[iMoSem])   : 0;
    const pecSem   = iPecSem >= 0 ? safeNum(r[iPecSem])  : 0;
    const taxa     = iTaxa   >= 0 ? safeNum(r[iTaxa])    : 0;
    const moTot    = iMoTot  >= 0 ? safeNum(r[iMoTot])   : 0;
    const pecTot   = iPecTot >= 0 ? safeNum(r[iPecTot])  : 0;
    const natureza = iNat    >= 0 ? String(r[iNat] || '').trim() : '';

    // Custo real = M.O sem taxa + Peças sem taxa (valor antes da margem)
    const custoBase = moSem + pecSem;
    // Se não tiver sem taxa, usa o total
    const custo = custoBase > 0 ? custoBase : (moTot + pecTot);

    dados.push({
      os:       iOs      >= 0 ? String(r[iOs]      || '').trim() : '-',
      data:     dataNorm,
      cliente:  iCliente >= 0 ? String(r[iCliente] || '').trim() : '-',
      tipo:     iTipo    >= 0 ? String(r[iTipo]    || 'Outros').trim() : 'Outros',
      modelo:   iModelo  >= 0 ? String(r[iModelo]  || '').trim() : '',
      placa:    iPlaca   >= 0 ? String(r[iPlaca]   || '').trim() : '',
      natureza: natureza,
      moSem:    moSem,
      pecSem:   pecSem,
      taxa:     taxa,
      moTot:    moTot,
      pecTot:   pecTot,
      faturar:  faturar,
      custo:    custo,
      status:   iStatus  >= 0 ? String(r[iStatus]  || '').trim() : '',
    });
  }

  if (msg) msg.textContent = 'Salvando ' + dados.length + ' registros...';
  if (bar) bar.style.width = '80%';
  if (pct) pct.textContent = '80%';

  try {
    localStorage.setItem('findash_real_data', JSON.stringify(dados));
    localStorage.setItem('findash_meta', JSON.stringify({
      arquivo: arquivoSelecionado.name,
      total:   dados.length,
      versao:  Date.now(),
    }));
  } catch(e) {
    // localStorage cheio: salva amostra
    localStorage.setItem('findash_real_data', JSON.stringify(dados.slice(0, 4000)));
    localStorage.setItem('findash_meta', JSON.stringify({ arquivo: arquivoSelecionado.name, total: dados.length, amostrado: true }));
  }

  let prog = 80;
  const iv = setInterval(() => {
    prog += 10;
    if (bar) bar.style.width = prog + '%';
    if (pct) pct.textContent = prog + '%';
    if (prog >= 100) {
      clearInterval(iv);
      if (msg) msg.textContent = '✓ ' + dados.length + ' registros carregados!';
      setTimeout(() => { window.location.href = 'Dashboard.html'; }, 350);
    }
  }, 100);
}

function startUpload() {
  if (!arquivoSelecionado) {
    alert('Selecione um arquivo primeiro.');
    return;
  }
  const overlay = document.getElementById('progressOverlay');
  const bar     = document.getElementById('progressBar');
  const pct     = document.getElementById('progressPct');
  const msg     = document.getElementById('progressMsg');

  if (overlay) overlay.classList.add('visible');
  if (msg) msg.textContent = 'Lendo arquivo...';
  if (bar) bar.style.width = '15%';
  if (pct) pct.textContent = '15%';

  const ext = arquivoSelecionado.name.split('.').pop().toLowerCase();
  if (ext === 'csv') lerCSV(arquivoSelecionado, processarDados);
  else               lerExcel(arquivoSelecionado, processarDados);
}