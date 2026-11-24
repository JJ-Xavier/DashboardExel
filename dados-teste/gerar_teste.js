/*============================================================
  gerar_teste.js
  Gera dados-teste/teste_faturamento_10k.xlsx: ~10 mil O.S
  sintéticas de oficina/frota para testar a importação do
  Kapo Analytics. Usa o próprio SheetJS do projeto (js/vendor),
  então não precisa de npm install.

    node dados-teste/gerar_teste.js

  Semente fixa: rodar de novo gera exatamente o mesmo arquivo.
  Todos os nomes de clientes, CPFs, CNPJs e placas são
  inventados (CPF/CNPJ com dígito verificador válido, mas
  aleatórios).
==============================================================*/
"use strict";

const path = require("path");
const XLSX = require(path.join(__dirname, "..", "js", "vendor", "xlsx.full.min.js"));

const OUT = path.join(__dirname, "teste_faturamento_10k.xlsx");
const N_ANTIGA = 500;
const N_CARROS = 6700;
const N_MOTOS = 2800;

/*-------------------- aleatoriedade determinística --------------------*/
function mulberry32(a) {
    return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
const rnd = mulberry32(20261123);
const int = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const pick = arr => arr[Math.floor(rnd() * arr.length)];
const round2 = n => Math.round(n * 100) / 100;
const skewed = (min, max) => min + (max - min) * Math.pow(rnd(), 2); // mais valores baixos que altos
const digits = n => Array.from({ length: n }, () => int(0, 9));
function weighted(entries) { // [[valor, peso], ...]
    const total = entries.reduce((s, e) => s + e[1], 0);
    let r = rnd() * total;
    for (const [v, w] of entries) if ((r -= w) < 0) return v;
    return entries[entries.length - 1][0];
}

/*-------------------- documentos --------------------*/
function cnpj() {
    const calc = (d, w) => { const r = d.reduce((s, x, i) => s + x * w[i], 0) % 11; return r < 2 ? 0 : 11 - r; };
    const w1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    const d = [...digits(8), 0, 0, 0, 1];
    d.push(calc(d, w1));
    d.push(calc(d, [6, ...w1]));
    const s = d.join("");
    return `${s.slice(0, 2)}.${s.slice(2, 5)}.${s.slice(5, 8)}/${s.slice(8, 12)}-${s.slice(12)}`;
}
function cpf() {
    const calc = (d, w0) => { const r = (d.reduce((s, x, i) => s + x * (w0 - i), 0) * 10) % 11; return r === 10 ? 0 : r; };
    const d = digits(9);
    d.push(calc(d, 10));
    d.push(calc(d, 11));
    const s = d.join("");
    return `${s.slice(0, 3)}.${s.slice(3, 6)}.${s.slice(6, 9)}-${s.slice(9)}`;
}
const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const usedPlates = new Set();
function plate(mercosulRatio) {
    const l = () => LETTERS[int(0, 25)];
    let p;
    do {
        p = rnd() < mercosulRatio
            ? `${l()}${l()}${l()}${int(0, 9)}${l()}${int(0, 9)}${int(0, 9)}`  // Mercosul: ABC1D23
            : `${l()}${l()}${l()}-${digits(4).join("")}`;                  // antiga:   ABC-1234
    } while (usedPlates.has(p));
    usedPlates.add(p);
    return p;
}
const phone = (ddd, mobile) => mobile
    ? `(${ddd}) 9${int(6, 9)}${int(100, 999)}-${digits(4).join("")}`
    : `(${ddd}) ${int(2, 3)}${int(100, 999)}-${digits(4).join("")}`;

/*-------------------- datas --------------------*/
const DAY = 86400000;
const noon = (y, m, d) => new Date(y, m - 1, d, 12, 0, 0); // meio-dia evita virada de dia por fuso
const KM_REF = noon(2024, 1, 1);
const TODAY = noon(2026, 11, 20);
const fmtDate = d => `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
const dateKey = d => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

/** n datas ordenadas: sem domingo, sábado mais fraco, volume crescendo com o tempo */
function sampleDates(n, start, end) {
    const days = [];
    for (let t = start.getTime(); t <= end.getTime(); t += DAY) {
        const d = new Date(t);
        if (d.getDay() !== 0) days.push(d);
    }
    const cum = [];
    let acc = 0;
    days.forEach((d, i) => { acc += (d.getDay() === 6 ? 0.4 : 1) * (1 + 0.6 * i / days.length); cum.push(acc); });
    const out = [];
    for (let k = 0; k < n; k++) {
        const r = rnd() * acc;
        let lo = 0, hi = cum.length - 1;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (cum[mid] < r) lo = mid + 1; else hi = mid; }
        out.push(days[lo]);
    }
    return out.sort((a, b) => a - b);
}

function statusFor(date) {
    const age = (TODAY - date) / DAY;
    if (age > 45) return weighted([["FATURADA", 80], ["FINALIZADA", 12], ["CANCELADA", 5], ["AGUARDANDO PEÇAS", 3]]);
    if (age > 15) return weighted([["FATURADA", 45], ["FINALIZADA", 30], ["EM ANDAMENTO", 10], ["AGUARDANDO PEÇAS", 10], ["CANCELADA", 5]]);
    return weighted([["ABERTA", 30], ["EM ANDAMENTO", 30], ["AGUARDANDO PEÇAS", 20], ["FINALIZADA", 15], ["FATURADA", 5]]);
}
const TIPOS = [["CORRETIVA", 50], ["PREVENTIVA", 30], ["SINISTRO", 8], ["REVISÃO", 8], ["GARANTIA", 4]];

/** ~6% das O.S não fecham com M.O + Peças: viram "Outros Lançamentos" no dashboard */
function adjust(valor) {
    const r = rnd();
    if (r < 0.035) {
        const desc = pick([0.05, 0.08, 0.1, 0.12, 0.15]);
        return { valor: round2(valor * (1 - desc)), desc, obs: `Desconto comercial de ${Math.round(desc * 100)}%` };
    }
    if (r < 0.06) {
        const extra = int(150, 650);
        const motivo = pick(["Guincho incluso", "Deslocamento técnico", "Taxa de diagnóstico", "Lavagem e higienização"]);
        return { valor: round2(valor + extra), desc: 0, obs: `${motivo} (R$ ${extra},00)` };
    }
    return { valor, desc: 0, obs: null };
}

/*-------------------- cadastros --------------------*/
const CITIES = [["CAMPINAS", "19"], ["JUNDIAÍ", "11"], ["SOROCABA", "15"], ["PIRACICABA", "19"], ["RIBEIRÃO PRETO", "16"],
    ["SÃO JOSÉ DOS CAMPOS", "12"], ["LIMEIRA", "19"], ["AMERICANA", "19"], ["SÃO PAULO", "11"]];

const CAR_MODELS = [["FIAT STRADA 1.4", 1.0], ["FIAT MOBI 1.0", 0.8], ["VW GOL 1.0", 0.85], ["VW SAVEIRO 1.6", 1.0],
    ["CHEVROLET ONIX 1.0", 0.9], ["CHEVROLET S10 2.8 DIESEL", 1.6], ["RENAULT KWID 1.0", 0.8], ["RENAULT MASTER 2.3", 1.7],
    ["FIAT FIORINO 1.4", 1.0], ["FIAT TORO 2.0 DIESEL", 1.5], ["TOYOTA HILUX 2.8 DIESEL", 1.8], ["FORD RANGER 3.2", 1.7],
    ["HYUNDAI HB20 1.0", 0.9], ["MERCEDES-BENZ SPRINTER 2.2", 1.9], ["VW AMAROK 2.0", 1.7], ["NISSAN FRONTIER 2.3", 1.6]];
const MOTO_MODELS = [["HONDA CG 160 FAN", 1.0], ["HONDA CG 160 TITAN", 1.05], ["HONDA BIZ 125", 0.85], ["HONDA POP 110I", 0.75],
    ["YAMAHA FACTOR 150", 1.0], ["YAMAHA FAZER 250", 1.3], ["HONDA XRE 300", 1.5], ["YAMAHA LANDER 250", 1.3],
    ["HONDA NXR 160 BROS", 1.1], ["YAMAHA NMAX 160", 1.25]];

const CAR_VALUES = {
    "CORRETIVA": { mo: [150, 1500], pc: [100, 4200] }, "PREVENTIVA": { mo: [120, 450], pc: [150, 950] },
    "SINISTRO": { mo: [900, 6500], pc: [1500, 18000] }, "REVISÃO": { mo: [220, 650], pc: [250, 1300] },
    "GARANTIA": { mo: [80, 400], pc: [60, 900] }
};
const MOTO_VALUES = {
    "CORRETIVA": { mo: [80, 450], pc: [60, 1200] }, "PREVENTIVA": { mo: [60, 180], pc: [50, 350] },
    "SINISTRO": { mo: [250, 1500], pc: [400, 5000] }, "REVISÃO": { mo: [90, 220], pc: [80, 400] },
    "GARANTIA": { mo: [40, 150], pc: [30, 300] }
};

const MECANICOS_CARRO = ["ADEMIR", "CLAUDIO", "EDSON", "FABIO", "GILBERTO", "JAIR", "MARCELO", "NELSON", "RENATO", "WAGNER"];
const MECANICOS_MOTO = ["ALEX", "DOUGLAS", "JONAS", "KLEBER", "ROBSON", "VINICIUS"];

const FIRST = ["JOÃO", "MARIA", "JOSÉ", "ANA", "CARLOS", "FERNANDA", "LUCAS", "JULIANA", "PEDRO", "PATRÍCIA", "RAFAEL",
    "CAMILA", "MARCOS", "ALINE", "BRUNO", "LETÍCIA", "DIEGO", "VANESSA", "THIAGO", "BEATRIZ", "GABRIEL", "LARISSA",
    "RODRIGO", "AMANDA", "FELIPE", "TATIANE", "MATEUS", "PRISCILA", "LEANDRO", "SABRINA"];
const LAST = ["SILVA", "SANTOS", "OLIVEIRA", "SOUZA", "RODRIGUES", "FERREIRA", "ALVES", "PEREIRA", "LIMA", "GOMES",
    "COSTA", "RIBEIRO", "MARTINS", "CARVALHO", "ALMEIDA", "LOPES", "SOARES", "FERNANDES", "VIEIRA", "BARBOSA", "ROCHA",
    "DIAS", "NASCIMENTO", "ANDRADE", "MOREIRA", "NUNES", "MARQUES", "MACHADO", "MENDES", "FREITAS"];

function makeCompanies(n, totalVehicles) {
    const prefix = ["TRANSPORTADORA", "LOCADORA", "DISTRIBUIDORA", "LOGÍSTICA", "CONSTRUTORA", "AGROPECUÁRIA",
        "SERVIÇOS", "COMERCIAL", "INDÚSTRIA", "COOPERATIVA"];
    const core = ["HORIZONTE", "SERRA AZUL", "VALE VERDE", "ESTRELA GUIA", "RIO CLARO", "TRÊS PINHEIROS", "NOVA ERA",
        "BOA VIAGEM", "PRIMAVERA", "ATLÂNTICO SUL", "IPÊ AMARELO", "CAMPO ALTO", "SOL NASCENTE", "PONTE NOVA", "AURORA"];
    const suffix = ["LTDA", "S.A.", "EIRELI", "LTDA ME"];
    const names = new Set();
    while (names.size < n) names.add(`${pick(prefix)} ${pick(core)} ${pick(suffix)}`);
    const list = [...names].map((nome, i) => {
        const [cidade, ddd] = pick(CITIES);
        return { nome, cnpj: cnpj(), telefone: phone(ddd, false), cidade, peso: 1 / Math.pow(i + 1, 0.85), frota: [] };
    });
    const pesoTotal = list.reduce((s, c) => s + c.peso, 0);
    for (const c of list) {
        const size = Math.max(3, Math.round(c.peso / pesoTotal * totalVehicles));
        for (let k = 0; k < size; k++) {
            const [modelo, fator] = pick(CAR_MODELS);
            c.frota.push({ placa: plate(0.6), modelo, fator, kmBase: int(3000, 60000), kmDia: 40 + rnd() * 120 });
        }
    }
    return list;
}

function makePeople(n) {
    return Array.from({ length: n }, () => {
        const [cidade, ddd] = pick(CITIES);
        const [modelo, fator] = pick(MOTO_MODELS);
        return {
            nome: `${pick(FIRST)} ${pick(LAST)} ${pick(LAST)}`, cpf: cpf(), celular: phone(ddd, true), cidade,
            moto: { placa: plate(0.85), modelo, fator, kmBase: int(500, 30000), kmDia: 20 + rnd() * 60 }
        };
    });
}

const kmAt = (v, date) => Math.max(0, Math.round(v.kmBase + (date - KM_REF) / DAY * v.kmDia + int(-300, 300)));

/*-------------------- abas --------------------*/
const CAR_HEADER = ["NUMERO OS", "DATA ABERTURA", "CLIENTE", "CNPJ", "TELEFONE", "CIDADE", "PLACA", "MODELO", "KM",
    "TIPO DE MANUTENÇÃO", "STATUS", "MECÂNICO", "M.O TOTAL", "VALOR TAXA PEÇAS", "PEÇAS TOTAL", "DESCONTO %",
    "VALOR A FATURAR", "VALOR TOTAL OS - DESPESA", "OBSERVAÇÃO"];

function genCarRows(n, start, end, osStart, companies) {
    const pesos = companies.map(c => [c, c.peso]);
    return sampleDates(n, start, end).map((date, i) => {
        const cli = weighted(pesos);
        const v = pick(cli.frota);
        const tipo = weighted(TIPOS);
        const status = statusFor(date);
        let mo = 0, taxa = 0, pecas = 0, valor = 0, despesa = 0, desc = 0, obs = "O.S cancelada pelo cliente";
        if (status !== "CANCELADA") {
            const faixa = CAR_VALUES[tipo];
            mo = round2(skewed(...faixa.mo) * v.fator);
            const pecasBase = rnd() < 0.08 ? 0 : round2(skewed(...faixa.pc) * v.fator); // 8% só mão de obra
            taxa = round2(pecasBase * 0.12);
            pecas = round2(pecasBase + taxa);
            ({ valor, desc, obs } = adjust(round2(mo + pecas)));
            despesa = round2(mo * (0.45 + rnd() * 0.15) + pecasBase * (0.7 + rnd() * 0.15));
        }
        return {
            date, tipo, status, valor, despesa,
            row: [osStart + i, date, cli.nome, cli.cnpj, cli.telefone, cli.cidade, v.placa, v.modelo, kmAt(v, date),
                tipo, status, pick(MECANICOS_CARRO), mo, taxa, pecas, desc, valor, despesa, obs]
        };
    });
}

const MOTO_HEADER = ["OS", "DT ABERTURA", "NOME CLIENTE", "CPF", "CELULAR", "PLACA", "MODELO", "KM",
    "TIPO DE ATENDIMENTO", "SITUAÇÃO", "MECÂNICO", "VALOR MÃO DE OBRA", "VALOR PEÇAS", "VALOR TOTAL", "OBS"];

function genMotoRows(n, start, end, osStart, people) {
    return sampleDates(n, start, end).map((date, i) => {
        const p = people[Math.floor(people.length * Math.pow(rnd(), 1.4))]; // clientes recorrentes
        const tipo = weighted(TIPOS);
        const status = statusFor(date);
        let mo = 0, pecas = 0, valor = 0, obs = "O.S cancelada pelo cliente";
        if (status !== "CANCELADA") {
            const faixa = MOTO_VALUES[tipo];
            mo = round2(skewed(...faixa.mo) * p.moto.fator);
            pecas = rnd() < 0.1 ? 0 : round2(skewed(...faixa.pc) * p.moto.fator);
            ({ valor, obs } = adjust(round2(mo + pecas)));
        }
        // datas como TEXTO dd/mm/aaaa, como sai de muitos sistemas que exportam para Excel
        return [`OS-${osStart + i}`, fmtDate(date), p.nome, p.cpf, p.celular, p.moto.placa, p.moto.modelo,
            kmAt(p.moto, date), tipo, status, pick(MECANICOS_MOTO), mo, pecas, valor, obs];
    });
}

const RESUMO_HEADER = ["DATA", "QTD MANUT PREVENTIVA E CORRETIVA", "QDT SINISTRO", "VALOR DESPESA TOTAL NO DIA",
    "VALOR TOTAL FATURADO NO DIA", "% FATURADO SINISTRO"];

function genResumo(carRecords) {
    const byDay = new Map();
    for (const r of carRecords) {
        if (r.status === "CANCELADA") continue;
        const k = dateKey(r.date);
        if (!byDay.has(k)) byDay.set(k, { date: r.date, prevCorr: 0, sin: 0, desp: 0, fat: 0, sinDesp: 0, sinFat: 0 });
        const d = byDay.get(k);
        if (r.tipo === "PREVENTIVA" || r.tipo === "CORRETIVA") d.prevCorr++;
        if (r.tipo === "SINISTRO") { d.sin++; d.sinDesp += r.despesa; d.sinFat += r.valor; }
        d.desp += r.despesa;
        d.fat += r.valor;
    }
    return [...byDay.values()].map(d => [d.date, d.prevCorr, d.sin, round2(d.desp), round2(d.fat),
        d.sinDesp > 0 ? Math.round(d.sinFat / d.sinDesp * 10000) / 10000 : null]);
}

/*-------------------- escrita --------------------*/
const MONEY_FMT = '"R$" #,##0.00';
const FORMATS = {
    "KM": "#,##0", "DESCONTO %": "0.0%", "% FATURADO SINISTRO": "0.0%",
    "M.O TOTAL": MONEY_FMT, "VALOR TAXA PEÇAS": MONEY_FMT, "PEÇAS TOTAL": MONEY_FMT, "VALOR A FATURAR": MONEY_FMT,
    "VALOR TOTAL OS - DESPESA": MONEY_FMT, "VALOR MÃO DE OBRA": MONEY_FMT, "VALOR PEÇAS": MONEY_FMT,
    "VALOR TOTAL": MONEY_FMT, "VALOR DESPESA TOTAL NO DIA": MONEY_FMT, "VALOR TOTAL FATURADO NO DIA": MONEY_FMT
};

function toSheet(header, rows, titleRows = []) {
    const ws = XLSX.utils.aoa_to_sheet([...titleRows, header, ...rows], { cellDates: true, dateNF: "dd/mm/yyyy" });
    const h = titleRows.length;
    const last = h + rows.length;
    header.forEach((name, c) => {
        const z = FORMATS[name];
        if (!z) return;
        for (let r = h + 1; r <= last; r++) {
            const cell = ws[XLSX.utils.encode_cell({ r, c })];
            if (cell && cell.t === "n") cell.z = z;
        }
    });
    ws["!cols"] = header.map((name, c) => {
        const longest = rows.slice(0, 300).reduce((m, r) => {
            const v = r[c];
            return Math.max(m, v instanceof Date ? 10 : String(v ?? "").length);
        }, 0);
        return { wch: Math.min(42, Math.max(10, name.length + 2, longest + 2)) };
    });
    ws["!autofilter"] = { ref: XLSX.utils.encode_range({ s: { r: h, c: 0 }, e: { r: last, c: header.length - 1 } }) };
    return ws;
}

const companies = makeCompanies(35, 1300);
const people = makePeople(1700);

const antiga = genCarRows(N_ANTIGA, noon(2024, 1, 2), noon(2024, 12, 28), 90001, companies);
const carros = genCarRows(N_CARROS, noon(2025, 1, 2), TODAY, 100001, companies);
const motos = genMotoRows(N_MOTOS, noon(2025, 1, 2), TODAY, 50001, people);
const resumo = genResumo(carros);

const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, toSheet(CAR_HEADER, antiga.map(r => r.row)), "BASE ANTIGA 2024");
XLSX.utils.book_append_sheet(wb, toSheet(CAR_HEADER, carros.map(r => r.row), [
    ["RELATÓRIO DE ORDENS DE SERVIÇO — FROTA CARROS"],
    [`Período: 02/01/2025 a ${fmtDate(TODAY)}`],
    []
]), "BASE CARROS");
XLSX.utils.book_append_sheet(wb, toSheet(MOTO_HEADER, motos), "BASE MOTOS");
XLSX.utils.book_append_sheet(wb, toSheet(RESUMO_HEADER, resumo), "RESUMO POR DIA CARROS");

// writeFile não acessa o disco quando o SheetJS vem do .min.js; gera em memória e grava.
require("fs").writeFileSync(OUT, XLSX.write(wb, { type: "buffer", bookType: "xlsx", compression: true }));

const total = antiga.length + carros.length + motos.length;
console.log(`OK: ${OUT}`);
console.log(`  BASE ANTIGA 2024      ${antiga.length} linhas`);
console.log(`  BASE CARROS           ${carros.length} linhas (título nas 3 primeiras linhas)`);
console.log(`  BASE MOTOS            ${motos.length} linhas`);
console.log(`  RESUMO POR DIA CARROS ${resumo.length} linhas`);
console.log(`  Total de O.S: ${total}`);
