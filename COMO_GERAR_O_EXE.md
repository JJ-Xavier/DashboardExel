# Como gerar o .exe do Kapo Analytics

Este projeto já está preparado para virar um instalador Windows via Electron.
Siga os passos abaixo **na sua máquina** (não dá pra gerar o .exe fora do Windows/sem GUI).

## 1. Pré-requisitos

- Instalar o [Node.js LTS](https://nodejs.org/) (inclui o `npm`).
- Confirmar que instalou certo, no terminal (cmd/PowerShell):
  ```
  node -v
  npm -v
  ```

## 2. Instalar as dependências do projeto

Abra o terminal dentro da pasta `DashboardExel` (a que tem o `package.json`) e rode:

```
npm install
```

Isso baixa o Electron e o electron-builder (ferramentas de empacotamento).
Só precisa rodar isso uma vez (ou de novo se apagar a pasta `node_modules`).

## 3. Adicionar o ícone (opcional, mas recomendado)

Coloque um arquivo `icon.ico` dentro da pasta `build/`. Veja `build/LEIA-ME.txt`
para instruções rápidas de como converter uma imagem em `.ico`.

Se pular esse passo, remova a linha `"icon": "build/icon.ico"` de dentro de
`"win"` no `package.json`, ou o build vai falhar.

## 4. Testar antes de empacotar

```
npm start
```

Isso abre o Kapo Analytics dentro de uma janela do Electron, exatamente como
vai rodar depois de instalado. Teste a importação de um arquivo grande de
verdade (o de ~13MB) pra confirmar que o Worker e o IndexedDB funcionam bem
nesse ambiente antes de gerar o instalador.

## 5. Gerar o instalador (.exe)

```
npm run dist
```

O instalador final aparece em `release/`, algo como:
`Kapo Analytics Setup 1.0.0.exe`

Esse é o arquivo que você distribui pros colegas/liderança. Ao rodar, ele
instala o app normalmente (ícone na área de trabalho, atalho no menu iniciar).

## Sobre a base de dados (a planilha)

O `.exe` empacota só o **programa** (HTML/CSS/JS). A planilha de faturamento
**não** vai dentro do instalador — cada pessoa que usar o app continua
importando o arquivo Excel/CSV dela pela tela normal de upload, exatamente
como funciona hoje no navegador. Como a base "com toda certeza será
atualizada com o tempo", isso é bom: não precisa gerar um novo instalador
toda vez que a planilha mudar, só quando o **código** mudar.

## O que fazer quando o código mudar de novo

Sempre que você alterar algo em `js/`, `css/` ou nos `.html`, repita só o
passo 5 (`npm run dist`) pra gerar um instalador novo. Não precisa repetir
`npm install` a menos que tenha adicionado alguma dependência nova.

## Sobre as bibliotecas externas (Chart.js e SheetJS)

Antes, `dashboard.html` e o Worker de importação carregavam Chart.js e o
SheetJS (`xlsx.full.min.js`) direto de CDNs externos (`cdn.jsdelivr.net` e
`cdn.sheetjs.com`). Isso **não funciona** dentro de um app empacotado, porque
o app não pode depender de internet pra abrir.

Essas duas bibliotecas já foram baixadas e colocadas em `js/vendor/`, e todas
as referências no código já foram atualizadas para usar essas cópias locais.

**Atenção**: a cópia de `xlsx.full.min.js` incluída aqui é da versão 0.18.5
(peguei do pacote público do SheetJS no npm, já que o domínio
`cdn.sheetjs.com` — onde está a versão 0.20.3 que o projeto usava antes — não
está liberado no meu ambiente de sandbox). Pra maioria dos casos de leitura
de Excel/CSV isso não deve fazer diferença, mas se quiser usar exatamente a
versão 0.20.3 original:

1. Baixe manualmente: https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js
2. Substitua o arquivo `js/vendor/xlsx.full.min.js` por ele.
3. Teste de novo com `npm start` antes de gerar o instalador.
