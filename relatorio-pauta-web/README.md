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

## Rodar local

```bash
npm install
npm start
```

Acesse `http://localhost:3000`.

## Deploy no Render

1. Suba esta pasta para um repositorio no GitHub.
2. No Render: **New +** > **Web Service**.
3. Conecte o repositorio.
4. Deploy usando o `render.yaml`.

## Observacoes

- PDF escaneado (imagem) pode precisar de OCR antes do upload.
- Parser preparado para formato padrao de pauta da Camara (itens numerados com bloco de relator).
