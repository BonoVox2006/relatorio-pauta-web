# Relatorio Gerencial de Pauta

Aplicativo web para gerar relatorio estatistico de pauta de comissao.

## O que faz

- Upload de pauta (`.pdf`, `.docx`, `.txt`)
- Extrai autores e relatores de itens de projeto
- Busca partido e UF na API de Dados Abertos da Camara
- Gera relatorio gerencial com:
  - totais
  - contagem por partido (autores e relatores)
  - detalhamento por item

## Estrutura para Netlify

- Frontend estatico: `index.html`, `app.js`, `style.css`
- Backend serverless: `netlify/functions/report.js`
- Configuracao Netlify: `netlify.toml`

## Deploy no Netlify

1. Suba esta pasta para um repositorio no GitHub.
2. No Netlify: **Add new site** > **Import an existing project**.
3. Conecte o repositorio.
4. Build command: `npm install`
5. Publish directory: `.`
6. Deploy.

## Observacoes

- PDF escaneado (imagem) pode precisar de OCR antes do upload.
- Parser preparado para formato padrao de pauta da Camara (itens numerados com bloco de relator).
